#!/usr/bin/env bash
#
#                                      |
#                                  ___/"\___
#                          __________/ o \__________
#                            (I) (G) \___/ (O) (R)
#                                   Igor Os
#                              igor@igoros.com
#                                 2026-03-27
# ----------------------------------------------------------------------------
# Use Ollama to audit metadata descriptions across a photo set for consistency.
# Detects outliers (wrong event names, location mismatches, tone drift) and
# optionally fixes them.
# ----------------------------------------------------------------------------
# Change Log:
# ****************************************************************************
# 2026-03-27	igor@igoros.com	Wrote this script
# ****************************************************************************

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

INPUT_DIR="."
FIELD="Caption-Abstract"
MODEL="gemma3:27b"
FIX_MODE=0
RECURSIVE=0
DRY_RUN=0
FILE_TYPES=""
BATCH_SIZE=200

DEFAULT_TYPES="jpg,jpeg,png,tif,tiff,heic,heif,webp,bmp,gif,dng,nef,cr2,cr3,arw,orf,rw2,srw,raf,pef,x3f"

usage() {
  cat <<EOF
Usage:
  ${SCRIPT_NAME} [options] [DIRECTORY]

Purpose:
  Use Ollama to audit metadata descriptions across a photo set for consistency.
  Detects outliers — wrong event names, location mismatches, tone differences,
  factual contradictions — and optionally fixes them.

  Keywords are not supported (use metadata_replace.sh for keyword cleanup).

Options:
  -F, --field FIELD        IPTC field to audit (default: Caption-Abstract)
                           Supported: Caption-Abstract, Headline, ImageDescription
  -m, --model NAME         Ollama model (default: ${MODEL})
  --fix                    Auto-fix detected inconsistencies (default: report only)
  -r, --recursive          Include subfolders
  -t, --types EXT,...      File extensions (default: all image types)
  -n, --dry-run            Preview fixes without writing (shows what --fix would do)
  -h, --help               Show this help

Examples:
  ${SCRIPT_NAME} /photos
  ${SCRIPT_NAME} -F Headline /photos
  ${SCRIPT_NAME} --fix /photos
  ${SCRIPT_NAME} --fix -n /photos
  ${SCRIPT_NAME} -m gemma3:12b -F ImageDescription /photos
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

log() {
  echo "$*"
}

# ---------------------------------------------------------------------------
# File discovery
# ---------------------------------------------------------------------------

discover_files() {
  local outfile="$1"
  local types="${FILE_TYPES:-${DEFAULT_TYPES}}"

  local -a find_cmd=(find "${INPUT_DIR}")
  if [[ "${RECURSIVE}" -eq 0 ]]; then
    find_cmd+=(-maxdepth 1)
  fi
  find_cmd+=(-type f)

  local -a ext_args=()
  local first=1
  local ext
  IFS=',' read -ra EXTS <<< "${types}"
  for ext in "${EXTS[@]}"; do
    ext="$(echo "${ext}" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -z "${ext}" ]] && continue
    if [[ "${first}" -eq 1 ]]; then
      first=0
      ext_args+=( \( -iname "*.${ext}" )
    else
      ext_args+=( -o -iname "*.${ext}" )
    fi
  done
  if [[ "${#ext_args[@]}" -gt 0 ]]; then
    ext_args+=( \) )
    find_cmd+=("${ext_args[@]}")
  fi

  "${find_cmd[@]}" 2>/dev/null > "${outfile}" || true
  wc -l < "${outfile}" | tr -d ' '
}

# ---------------------------------------------------------------------------
# Main processing via python3
# ---------------------------------------------------------------------------

run_audit() {
  local file_list="$1"

  python3 -c "
import subprocess, json, sys, os, re

file_list_path = sys.argv[1]
field = sys.argv[2]
model = sys.argv[3]
fix_mode = sys.argv[4] == '1'
dry_run = sys.argv[5] == '1'
batch_size = int(sys.argv[6])

# Read file list
with open(file_list_path) as f:
    files = [line.strip() for line in f if line.strip()]

if not files:
    print('No files found.')
    sys.exit(0)

# Pass 1: Extract field values
print(f'Pass 1: Reading {field} from {len(files)} files...')
sys.stdout.flush()

tag = '-' + field
cmd = ['exiftool', '-json', '-n', tag] + files
try:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    data = json.loads(proc.stdout) if proc.stdout else []
except Exception as e:
    print(f'Error reading metadata: {e}')
    sys.exit(1)

# Build corpus: filename -> value
corpus = {}
short_field = field.split(':')[-1] if ':' in field else field
# Handle IPTC field name variations
field_keys = [field, short_field, field.replace('-', '')]
for rec in data:
    src = rec.get('SourceFile', '')
    fname = os.path.basename(src)
    val = None
    for key in field_keys:
        val = rec.get(key)
        if val:
            break
    if val and isinstance(val, str) and val.strip():
        corpus[fname] = {'path': src, 'value': val.strip()}

non_empty = len(corpus)
print(f'Pass 1: Found {non_empty} non-empty {field} values out of {len(files)} files')
sys.stdout.flush()

if non_empty < 3:
    print(f'Need at least 3 descriptions to detect consistency patterns. Found {non_empty}.')
    sys.exit(0)

if non_empty > 1000:
    print(f'WARNING: {non_empty} descriptions is a very large corpus. Results may be less accurate.')
    sys.stdout.flush()

# Pass 2: Send to Ollama in batches
print(f'Pass 2: Analyzing consistency with {model}...')
sys.stdout.flush()

all_findings = []
items = list(corpus.items())

for batch_start in range(0, len(items), batch_size):
    batch = items[batch_start:batch_start + batch_size]
    batch_num = batch_start // batch_size + 1
    total_batches = (len(items) + batch_size - 1) // batch_size

    if total_batches > 1:
        print(f'  Batch {batch_num}/{total_batches} ({len(batch)} descriptions)...')
        sys.stdout.flush()

    # Build the prompt
    desc_list = '\\n'.join([f'{fname}: {info[\"value\"]}' for fname, info in batch])
    prompt = f'''You are a metadata consistency auditor. Below are {len(batch)} photo descriptions from the same photo shoot or collection.

Identify descriptions that are INCONSISTENT with the majority. Look for:
- Wrong event names (e.g., \"Sunset Festival\" when most say \"Sunrise Festival\")
- Location mismatches (e.g., \"Cape Hatteras\" when most reference \"Cape Lookout\")
- Tone or style differences that stand out from the majority
- Factual contradictions between descriptions
- Obvious errors or hallucinations

For EACH inconsistency found, output EXACTLY this JSON format on its own line:
{{\"file\": \"filename.jpg\", \"issue\": \"brief description of the problem\", \"current\": \"the current value\", \"suggested\": \"the corrected value\"}}

If everything is consistent, output just: []

IMPORTANT: Only flag GENUINE inconsistencies where the majority agrees on something different. Do not flag stylistic variation or minor wording differences.

Descriptions:
{desc_list}'''

    # Call Ollama
    try:
        proc = subprocess.run(
            ['ollama', 'run', model],
            input=prompt,
            capture_output=True, text=True, timeout=120
        )
        response = proc.stdout.strip() if proc.stdout else ''
    except subprocess.TimeoutExpired:
        print(f'  WARNING: Ollama timed out on batch {batch_num}. Skipping.')
        sys.stdout.flush()
        continue
    except Exception as e:
        print(f'  WARNING: Ollama error on batch {batch_num}: {e}. Skipping.')
        sys.stdout.flush()
        continue

    if not response:
        continue

    # Parse response — handle various LLM output formats
    # Strip markdown code fences if present
    response = re.sub(r'\`\`\`json\s*', '', response)
    response = re.sub(r'\`\`\`\s*', '', response)
    response = response.strip()

    if response == '[]':
        continue

    # Try to parse as JSON array first
    findings = []
    try:
        parsed = json.loads(response)
        if isinstance(parsed, list):
            findings = parsed
        elif isinstance(parsed, dict):
            findings = [parsed]
    except json.JSONDecodeError:
        # Try line-by-line JSON parsing
        for line in response.split('\\n'):
            line = line.strip()
            if not line or line == '[]':
                continue
            # Remove leading comma, list brackets
            line = line.strip(',[]')
            try:
                obj = json.loads(line)
                if isinstance(obj, dict) and 'file' in obj:
                    findings.append(obj)
            except json.JSONDecodeError:
                continue

    # Validate and match findings to actual files
    for finding in findings:
        fname = finding.get('file', '')
        # Fuzzy match filename to actual files in corpus
        matched_fname = None
        if fname in corpus:
            matched_fname = fname
        else:
            # Try case-insensitive match
            for cf in corpus:
                if cf.lower() == fname.lower():
                    matched_fname = cf
                    break
            if not matched_fname:
                # Try without extension
                fname_base = os.path.splitext(fname)[0]
                for cf in corpus:
                    if os.path.splitext(cf)[0].lower() == fname_base.lower():
                        matched_fname = cf
                        break

        if matched_fname:
            finding['_matched'] = matched_fname
            finding['_path'] = corpus[matched_fname]['path']
            all_findings.append(finding)
        else:
            print(f'  WARNING: Could not match filename \"{fname}\" from Ollama response')

# Report findings
print()
if not all_findings:
    print(f'No inconsistencies found in {non_empty} descriptions.')
    sys.exit(0)

print(f'INCONSISTENCIES FOUND: {len(all_findings)}')
print()

for f in all_findings:
    fname = f.get('_matched', f.get('file', ''))
    issue = f.get('issue', 'Unknown issue')
    current = f.get('current', '')
    suggested = f.get('suggested', '')

    print(f'  \\u26a0 {fname}')
    print(f'    Issue: {issue}')
    if current:
        print(f'    Current: \"{current}\"')
    if suggested:
        print(f'    Suggested: \"{suggested}\"')
    print()

# Apply fixes if requested
if fix_mode and all_findings:
    if dry_run:
        print(f'Dry run: {len(all_findings)} fix(es) would be applied.')
        print('Run without --dry-run to apply.')
    else:
        applied = 0
        for f in all_findings:
            path = f.get('_path')
            suggested = f.get('suggested', '').strip()
            if not path or not suggested:
                continue
            fname = os.path.basename(path)
            try:
                subprocess.run(
                    ['exiftool', '-overwrite_original', f'-{field}={suggested}', path],
                    capture_output=True, text=True, timeout=10
                )
                print(f'  FIXED  {fname}')
                applied += 1
            except Exception as e:
                print(f'  FAIL   {fname}: {e}')
        print(f'\\nApplied {applied} fix(es).')
elif not fix_mode:
    print(f'Found {len(all_findings)} inconsistencies in {non_empty} descriptions ({len(all_findings)*100//non_empty}%)')
    print('Use --fix to apply suggested corrections, or --dry-run --fix to preview.')

" "${file_list}" "${FIELD}" "${MODEL}" "${FIX_MODE}" "${DRY_RUN}" "${BATCH_SIZE}"
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    -F|--field)
      [[ $# -lt 2 ]] && die "$1 requires a field name"
      FIELD="$2"; shift 2 ;;
    -m|--model)
      [[ $# -lt 2 ]] && die "$1 requires a model name"
      MODEL="$2"; shift 2 ;;
    --fix)
      FIX_MODE=1; shift ;;
    -r|--recursive)
      RECURSIVE=1; shift ;;
    -t|--types)
      [[ $# -lt 2 ]] && die "$1 requires extensions"
      FILE_TYPES="$2"; shift 2 ;;
    -n|--dry-run)
      DRY_RUN=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    -*)
      die "Unknown option: $1" ;;
    *)
      if [[ "${INPUT_DIR}" != "." ]]; then
        die "Only one DIRECTORY argument is supported"
      fi
      INPUT_DIR="$1"; shift ;;
  esac
done

# Validate
if [[ ! -d "${INPUT_DIR}" ]]; then
  die "Directory not found: ${INPUT_DIR}"
fi

case "${FIELD}" in
  Caption-Abstract|Headline|ImageDescription) ;;
  Keywords)
    die "Keywords consistency audit is not supported. Use metadata_replace.sh for keyword cleanup." ;;
  *)
    die "Unsupported field: ${FIELD}. Use Caption-Abstract, Headline, or ImageDescription." ;;
esac

command -v exiftool >/dev/null 2>&1 || die "exiftool is required"
command -v ollama >/dev/null 2>&1 || die "ollama is required"
command -v python3 >/dev/null 2>&1 || die "python3 is required"

# Check Ollama is running
if ! ollama list >/dev/null 2>&1; then
  die "Ollama is not running. Start it with: ollama serve"
fi

# Display settings
log "Metadata Consistency Audit"
log "  Field:   ${FIELD}"
log "  Model:   ${MODEL}"
log "  Mode:    $( [[ "${FIX_MODE}" -eq 1 ]] && echo "fix" || echo "report only" )"
[[ "${DRY_RUN}" -eq 1 ]] && log "  Dry run: yes"
log ""

# Discover files
tmpfile="$(mktemp)"
trap "rm -f '${tmpfile}'" EXIT
total="$(discover_files "${tmpfile}")"
log "Files found: ${total}"

if [[ "${total}" -eq 0 ]]; then
  log "No matching files found."
  exit 0
fi

log ""
run_audit "${tmpfile}"

log ""
log "Done."
