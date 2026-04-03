#!/usr/bin/env bash
#
#                                      |
#                                  ___/"\___
#                          __________/ o \__________
#                            (I) (G) \___/ (O) (R)
#                                   Igor Os
#                              igor@igoros.com
#                                 2026-04-02
# ----------------------------------------------------------------------------
# Check photos against stock agency submission requirements.
# Reads rules from stock_compliance.json and validates each photo's
# file size, dimensions, format, color space, and metadata.
# ----------------------------------------------------------------------------
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_RULES="${SCRIPT_DIR}/stock_compliance.json"

INPUT_DIR="."
RULES_FILE=""
AGENCIES=""
RECURSIVE=0
DRY_RUN=0
OUTPUT_FORMAT="text"
FILE_TYPES="jpg,jpeg"

DEFAULT_TYPES="jpg,jpeg,png,tif,tiff"

usage() {
  cat <<'EOF'
Usage:
  stock_compliance.sh [options] [DIRECTORY]

Purpose:
  Validate photos against stock agency submission requirements.
  Checks file size, dimensions (megapixels), format, color space,
  and IPTC/EXIF metadata (title, keywords, caption).

Options:
  -a, --agencies LIST    Comma-separated agency names to check against
                         (default: all agencies in the rules file)
                         Example: "Shutterstock,Adobe Stock,Getty Images"
  -j, --json             Output results as JSON (default: human-readable text)
  --rules PATH           Path to rules JSON file
                         (default: stock_compliance.json in script directory)
  -r, --recursive        Include subfolders
  -t, --types EXT,...    File extensions to check (default: jpg,jpeg)
  -n, --dry-run          List files that would be checked without checking
  -h, --help             Show this help

Examples:
  stock_compliance.sh /photos
  stock_compliance.sh -a "Shutterstock,Adobe Stock" /photos
  stock_compliance.sh -a "Getty Images" -r --json /photos
  stock_compliance.sh --rules custom_rules.json /photos
EOF
}

die() { echo "Error: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)      usage; exit 0 ;;
    -a|--agencies)  AGENCIES="$2"; shift 2 ;;
    --agencies=*)   AGENCIES="${1#*=}"; shift ;;
    -j|--json)      OUTPUT_FORMAT="json"; shift ;;
    --rules)        RULES_FILE="$2"; shift 2 ;;
    --rules=*)      RULES_FILE="${1#*=}"; shift ;;
    -r|--recursive) RECURSIVE=1; shift ;;
    -t|--types)     FILE_TYPES="$2"; shift 2 ;;
    --types=*)      FILE_TYPES="${1#*=}"; shift ;;
    -n|--dry-run)   DRY_RUN=1; shift ;;
    --)             shift; break ;;
    -*)             die "Unknown option: $1" ;;
    *)
      if [[ -z "${INPUT_DIR}" || "${INPUT_DIR}" == "." ]]; then
        INPUT_DIR="$1"
      fi
      shift ;;
  esac
done

[[ -z "${RULES_FILE}" ]] && RULES_FILE="${DEFAULT_RULES}"
[[ ! -f "${RULES_FILE}" ]] && die "Rules file not found: ${RULES_FILE}"

if [[ "${INPUT_DIR}" == "." ]]; then
  INPUT_DIR="$(pwd)"
fi
[[ ! -d "${INPUT_DIR}" ]] && die "Directory not found: ${INPUT_DIR}"

# ---------------------------------------------------------------------------
# File discovery
# ---------------------------------------------------------------------------
find_photos() {
  local IFS=','
  local -a exts=(${FILE_TYPES})
  local -a find_args=("${INPUT_DIR}")

  if [[ ${RECURSIVE} -ne 1 ]]; then
    find_args+=("-maxdepth" "1")
  fi
  find_args+=("-type" "f" "(")

  local first=1
  for ext in "${exts[@]}"; do
    [[ ${first} -eq 0 ]] && find_args+=("-o")
    find_args+=("-iname" "*.${ext}")
    first=0
  done
  find_args+=(")" "-print0")

  find "${find_args[@]}" | sort -z
}

# ---------------------------------------------------------------------------
# Main validation — delegated to Python for JSON parsing + structured output
# ---------------------------------------------------------------------------
validate_files() {
  local file_list
  file_list="$(mktemp)"
  trap "rm -f '${file_list}'" EXIT

  find_photos > "${file_list}"

  local file_count
  file_count="$(tr -cd '\0' < "${file_list}" | wc -c)"
  file_count=$((file_count))  # trim whitespace

  if [[ ${file_count} -eq 0 ]]; then
    echo "No supported photo files found in ${INPUT_DIR}"
    exit 0
  fi

  if [[ ${DRY_RUN} -eq 1 ]]; then
    echo "Dry run: ${file_count} file(s) would be checked"
    tr '\0' '\n' < "${file_list}"
    exit 0
  fi

  echo "Checking ${file_count} file(s) against stock agency rules..." >&2

  # Read all metadata in one batch exiftool call
  local meta_json
  meta_json="$(xargs -0 exiftool -json -n \
    -FileSize -ImageWidth -ImageHeight -FileType \
    -ColorSpace -ICCProfileName -ProfileDescription \
    -IPTC:Headline -IPTC:Caption-Abstract -IPTC:Keywords \
    -EXIF:ImageDescription \
    -XMP:Description -XMP:Title \
    < "${file_list}" 2>/dev/null || echo '[]')"

  # Run validation in Python
  python3 -c "
import json, sys, os

rules_path = sys.argv[1]
agencies_filter = sys.argv[2]
output_format = sys.argv[3]

with open(rules_path, 'r') as f:
    rules = json.load(f)

meta = json.loads(sys.stdin.read())

# Filter agencies if specified
services = rules.get('services', [])
if agencies_filter:
    names = [a.strip().lower() for a in agencies_filter.split(',')]
    services = [s for s in services if s['service'].lower() in names]

if not services:
    print('No matching agencies found in rules file.', file=sys.stderr)
    sys.exit(1)

results = []
total_pass = 0
total_fail = 0
total_warn = 0

for rec in meta:
    src = rec.get('SourceFile', '')
    fname = os.path.basename(src)
    file_size = rec.get('FileSize', 0)
    if isinstance(file_size, str):
        # Parse '1234 bytes' or '1.2 MB' etc
        file_size = 0
    width = rec.get('ImageWidth', 0) or 0
    height = rec.get('ImageHeight', 0) or 0
    mp = (width * height) / 1_000_000 if width and height else 0
    uncompressed = width * height * 3 if width and height else 0
    file_type = (rec.get('FileType') or '').lower()
    color_space = rec.get('ICCProfileName') or rec.get('ProfileDescription') or ''
    color_space_id = rec.get('ColorSpace', 0)
    # ColorSpace=1 is sRGB in EXIF
    is_srgb = (color_space_id == 1 or 'srgb' in color_space.lower()
               or 'srgb' in str(rec.get('ICCProfileName', '')).lower())

    # Metadata
    headline = rec.get('Headline') or rec.get('Title') or ''
    caption = rec.get('Caption-Abstract') or rec.get('ImageDescription') or rec.get('Description') or ''
    keywords_raw = rec.get('Keywords') or ''
    if isinstance(keywords_raw, list):
        keywords = keywords_raw
    elif isinstance(keywords_raw, str) and keywords_raw:
        keywords = [k.strip() for k in keywords_raw.split(',') if k.strip()]
    else:
        keywords = []
    kw_count = len(keywords)

    # Title: use headline, fall back to caption first line
    title = headline if headline else ''
    title_words = len(title.split()) if title else 0

    file_result = {
        'file': fname,
        'path': src,
        'file_size': file_size,
        'megapixels': round(mp, 2),
        'uncompressed_bytes': uncompressed,
        'dimensions': '%dx%d' % (width, height),
        'format': file_type,
        'color_space': color_space or ('sRGB' if is_srgb else 'unknown'),
        'title': title,
        'title_words': title_words,
        'caption_length': len(caption),
        'keyword_count': kw_count,
        'agencies': {}
    }

    for svc in services:
        sname = svc['service']
        issues = []
        warnings = []

        # File size checks
        fs = svc.get('file_size', {})
        if fs.get('min_bytes') and file_size < fs['min_bytes']:
            issues.append('File size %d bytes < min %d bytes' % (file_size, fs['min_bytes']))
        if fs.get('min_bytes') and uncompressed < fs['min_bytes']:
            # Alamy uses uncompressed size
            if sname == 'Alamy':
                issues.append('Uncompressed size %d bytes < min %d bytes' % (uncompressed, fs['min_bytes']))
        if fs.get('max_bytes') and file_size > fs['max_bytes']:
            issues.append('File size %d bytes > max %d bytes' % (file_size, fs['max_bytes']))

        # Dimension checks
        dims = svc.get('image_dimensions', {})
        if dims.get('min_mp') and mp < dims['min_mp']:
            issues.append('%.2f MP < min %.1f MP' % (mp, dims['min_mp']))
        if dims.get('max_mp') and mp > dims['max_mp']:
            issues.append('%.2f MP > max %.1f MP' % (mp, dims['max_mp']))

        # Format check
        allowed = svc.get('allowed_formats', [])
        if allowed and file_type not in allowed:
            issues.append('Format %s not in allowed: %s' % (file_type, ', '.join(allowed)))

        # Color space
        if svc.get('color_space') and svc['color_space'].lower() == 'srgb' and not is_srgb:
            cs_found = color_space if color_space and color_space != 'unknown' else 'no ICC profile embedded'
            warnings.append('sRGB required — %s. Embed sRGB profile before submitting.' % cs_found)

        # Title checks
        tr = svc.get('title', {})
        if tr.get('min_words') and title_words < tr['min_words']:
            issues.append('Title %d words < min %d words' % (title_words, tr['min_words']))
        if tr.get('max_chars') and title and len(title) > tr['max_chars']:
            warnings.append('Title %d chars > recommended max %d' % (len(title), tr['max_chars']))
        if tr.get('no_special_chars') and title:
            import re
            if re.search(r'[^a-zA-Z0-9 ,.\\'\\-]', title):
                warnings.append('Title contains special characters')

        # Keyword checks
        kr = svc.get('keywords', {})
        if kr.get('min') and kw_count < kr['min']:
            issues.append('Keywords %d < min %d' % (kw_count, kr['min']))
        if kr.get('max') and kw_count > kr['max']:
            issues.append('Keywords %d > max %d' % (kw_count, kr['max']))

        # No title/caption at all
        if not title and not caption:
            warnings.append('No title or caption')

        status = 'PASS' if not issues else 'FAIL'
        if status == 'PASS':
            total_pass += 1
        else:
            total_fail += 1
        if warnings:
            total_warn += 1

        file_result['agencies'][sname] = {
            'status': status,
            'issues': issues,
            'warnings': warnings,
        }

    results.append(file_result)

# Output
if output_format == 'json':
    output = {
        'directory': os.path.dirname(meta[0].get('SourceFile', '')) if meta else '',
        'files_checked': len(results),
        'agencies_checked': [s['service'] for s in services],
        'summary': {
            'total_checks': total_pass + total_fail,
            'pass': total_pass,
            'fail': total_fail,
            'warnings': total_warn,
        },
        'results': results,
    }
    print(json.dumps(output, indent=2))
else:
    # Human-readable output
    svc_names = [s['service'] for s in services]
    print('Stock compliance check: %d files x %d agencies' % (len(results), len(svc_names)))
    print('Agencies: %s' % ', '.join(svc_names))
    print('=' * 72)
    print()

    for r in results:
        has_issues = any(a['issues'] for a in r['agencies'].values())
        has_warnings = any(a['warnings'] for a in r['agencies'].values())
        if not has_issues and not has_warnings:
            print('PASS  %s  (%.1f MP, %s)' % (r['file'], r['megapixels'], r['dimensions']))
            continue

        print('%s  (%.1f MP, %s, %d keywords)' % (r['file'], r['megapixels'], r['dimensions'], r['keyword_count']))
        for sname, a in r['agencies'].items():
            if a['issues']:
                for issue in a['issues']:
                    print('  FAIL  [%s] %s' % (sname, issue))
            if a['warnings']:
                for warn in a['warnings']:
                    print('  WARN  [%s] %s' % (sname, warn))
        print()

    print('=' * 72)
    print('Summary: %d checks — %d pass, %d fail, %d warnings' % (
        total_pass + total_fail, total_pass, total_fail, total_warn))

# Always write a JSON results file for the UI to read
results_output = {
    'directory': os.path.dirname(meta[0].get('SourceFile', '')) if meta else '',
    'files_checked': len(results),
    'agencies_checked': [s['service'] for s in services],
    'summary': {
        'total_checks': total_pass + total_fail,
        'pass': total_pass,
        'fail': total_fail,
        'warnings': total_warn,
    },
    'results': results,
}
results_path = sys.argv[4]
if results_path:
    os.makedirs(os.path.dirname(results_path), exist_ok=True)
    with open(results_path, 'w') as rf:
        rf.write(json.dumps(results_output, indent=2))
    print('Results written to: %s' % results_path, file=sys.stderr)
" "${RULES_FILE}" "${AGENCIES}" "${OUTPUT_FORMAT}" "${INPUT_DIR}/.photoshell/stock_compliance_results.json" <<< "${meta_json}"
}

# ---------------------------------------------------------------------------
# RUNTIME
# ---------------------------------------------------------------------------
validate_files
