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
# Find and replace text in selected EXIF/IPTC metadata fields across photos.
# Keyword-aware: replaces individual keywords within keyword lists.
# ----------------------------------------------------------------------------
# Change Log:
# ****************************************************************************
# 2026-03-27	igor@igoros.com	Wrote this script
# ****************************************************************************

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

INPUT_DIR="."
SEARCH=""
REPLACE=""
FIELDS=""
IGNORE_CASE=0
WHOLE_WORD=0
USE_REGEX=0
RECURSIVE=0
DRY_RUN=0
FILE_TYPES=""
DEFAULT_TYPES="jpg,jpeg,png,tif,tiff,heic,heif,webp,bmp,gif,dng,nef,cr2,cr3,arw,orf,rw2,srw,raf,pef,x3f"
ALL_FIELDS="Keywords,Caption-Abstract,Headline,ImageDescription,UserComment,Copyright,Credit,Source,City,Province-State,Country-PrimaryLocationName,XMP-dc:Description,XMP-dc:Title,XMP-dc:Subject,XMP-dc:Rights,XMP-dc:Creator,XMP-iptcCore:AltTextAccessibility,XMP-iptcCore:Location,XMP-iptcCore:CreatorWorkEmail,XMP-iptcCore:CreatorWorkURL"

usage() {
  cat <<EOF
Usage:
  ${SCRIPT_NAME} [options] [DIRECTORY]

Purpose:
  Find and replace text in selected EXIF/IPTC metadata fields across photos.
  Keywords are handled individually — replacing within a keyword list replaces
  the matching keyword, not the entire field.

Options:
  -s, --search TEXT        Text to find (required)
  -R, --replace TEXT       Replacement text (required; use "" to delete)
  -F, --fields FIELD,...   Fields to operate on (default: all supported fields)
                           IPTC: Keywords, Caption-Abstract, Headline, Copyright,
                                 Credit, Source, City, Province-State,
                                 Country-PrimaryLocationName
                           EXIF: ImageDescription, UserComment
                           XMP:  XMP-dc:Description, XMP-dc:Title, XMP-dc:Subject,
                                 XMP-dc:Rights, XMP-dc:Creator,
                                 XMP-iptcCore:AltTextAccessibility, XMP-iptcCore:Location,
                                 XMP-iptcCore:CreatorWorkEmail, XMP-iptcCore:CreatorWorkURL
  -i, --ignore-case        Case-insensitive matching
  -w, --whole-word         Match whole words only
  -x, --regex              Treat search as Python regex
  -r, --recursive          Include subfolders
  -t, --types EXT,...      File extensions (default: all image types)
  -n, --dry-run            Preview changes without writing
  -h, --help               Show this help

Examples:
  ${SCRIPT_NAME} -s "sunset" -R "golden hour" /photos
  ${SCRIPT_NAME} -s "sunset" -R "golden hour" -F Keywords,Headline /photos
  ${SCRIPT_NAME} -s "NYC" -R "New York City" -i /photos
  ${SCRIPT_NAME} -s "IMG_\\d{4}" -R "" -x -F Keywords /photos
  ${SCRIPT_NAME} -s "typo" -R "fixed" -n /photos
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
# Core: find and replace using python3
# ---------------------------------------------------------------------------

process_file() {
  local file="$1"
  local fname
  fname="$(basename "${file}")"

  # Use python3 for reliable JSON parsing and regex handling
  python3 -c "
import subprocess, json, sys, re, os

file = sys.argv[1]
search = sys.argv[2]
replace = sys.argv[3]
fields_str = sys.argv[4]
ignore_case = sys.argv[5] == '1'
whole_word = sys.argv[6] == '1'
use_regex = sys.argv[7] == '1'
dry_run = sys.argv[8] == '1'
fname = os.path.basename(file)

fields = [f.strip() for f in fields_str.split(',') if f.strip()]

# Build exiftool read command for target fields
tags = []
for f in fields:
    tags.append('-' + f)

cmd = ['exiftool', '-json', '-n'] + tags + [file]
try:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    if proc.returncode != 0:
        sys.exit(0)
    data = json.loads(proc.stdout)
    if not data:
        sys.exit(0)
    rec = data[0]
except Exception:
    sys.exit(0)

# Build search pattern
flags = re.IGNORECASE if ignore_case else 0
if use_regex:
    pattern = search
elif whole_word:
    pattern = r'\b' + re.escape(search) + r'\b'
else:
    pattern = re.escape(search)

try:
    compiled = re.compile(pattern, flags)
except re.error as e:
    print(f'  ERROR  {fname}  Invalid regex: {e}', flush=True)
    sys.exit(0)

# Check each field for matches
changes = []
exif_args = []

for field in fields:
    # exiftool may return the tag without the group prefix
    val = rec.get(field)
    if val is None:
        # Try without group prefix
        short = field.split(':')[-1] if ':' in field else field
        val = rec.get(short)
    if val is None:
        continue

    if field in ('Keywords', 'XMP-dc:Subject', 'Subject'):
        # Handle keywords as a list
        if isinstance(val, str):
            kw_list = [k.strip() for k in val.split(',')]
        elif isinstance(val, list):
            kw_list = [str(k) for k in val]
        else:
            continue

        new_kw_list = []
        matched = False
        for kw in kw_list:
            new_kw = compiled.sub(replace, kw)
            if new_kw != kw:
                matched = True
            # Remove empty keywords (when replacing with empty string)
            if new_kw.strip():
                new_kw_list.append(new_kw.strip())

        if matched:
            old_str = ', '.join(kw_list)
            new_str = ', '.join(new_kw_list)
            changes.append((field, old_str, new_str))
            # Build exiftool args for keywords
            exif_args.append('-Keywords=')
            for kw in new_kw_list:
                exif_args.append(f'-Keywords+={kw}')

    else:
        # Handle as string
        val_str = str(val)
        new_val = compiled.sub(replace, val_str)
        if new_val != val_str:
            changes.append((field, val_str, new_val))
            exif_args.append(f'-{field}={new_val}')

if not changes:
    sys.exit(0)

# Report changes
for field, old, new in changes:
    if len(old) > 60:
        old = old[:57] + '...'
    if len(new) > 60:
        new = new[:57] + '...'
    print(f'  MATCH  {fname}  {field}: \"{old}\" -> \"{new}\"', flush=True)

if dry_run:
    sys.exit(0)

# Write changes
write_cmd = ['exiftool', '-overwrite_original'] + exif_args + [file]

try:
    proc = subprocess.run(write_cmd, capture_output=True, text=True, timeout=30)
    if proc.returncode != 0:
        print(f'  FAIL   {fname}  exiftool write error', flush=True)
        sys.exit(2)
except Exception as e:
    print(f'  FAIL   {fname}  {e}', flush=True)
    sys.exit(2)

sys.exit(0)
" "${file}" "${SEARCH}" "${REPLACE}" "${FIELDS:-${ALL_FIELDS}}" \
  "${IGNORE_CASE}" "${WHOLE_WORD}" "${USE_REGEX}" "${DRY_RUN}"
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--search)
      [[ $# -lt 2 ]] && die "$1 requires search text"
      SEARCH="$2"; shift 2 ;;
    -R|--replace)
      [[ $# -lt 2 ]] && die "$1 requires replacement text"
      REPLACE="$2"; shift 2 ;;
    -F|--fields)
      [[ $# -lt 2 ]] && die "$1 requires field names"
      FIELDS="$2"; shift 2 ;;
    -i|--ignore-case)
      IGNORE_CASE=1; shift ;;
    -w|--whole-word)
      WHOLE_WORD=1; shift ;;
    -x|--regex)
      USE_REGEX=1; shift ;;
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
if [[ -z "${SEARCH}" ]]; then
  die "Search text is required. Use -s \"text\""
fi

if [[ ! -d "${INPUT_DIR}" ]]; then
  die "Directory not found: ${INPUT_DIR}"
fi

command -v exiftool >/dev/null 2>&1 || die "exiftool is required"
command -v python3 >/dev/null 2>&1 || die "python3 is required"

# Display settings
log "Metadata Find & Replace"
log "  Search:  \"${SEARCH}\""
log "  Replace: \"${REPLACE}\""
log "  Fields:  ${FIELDS:-all supported fields}"
[[ "${IGNORE_CASE}" -eq 1 ]] && log "  Case:    insensitive"
[[ "${WHOLE_WORD}" -eq 1 ]]  && log "  Match:   whole word"
[[ "${USE_REGEX}" -eq 1 ]]   && log "  Mode:    regex"
[[ "${DRY_RUN}" -eq 1 ]]     && log "  Dry run: yes"
log ""

# Discover files
tmpfile="$(mktemp)"
trap "rm -f '${tmpfile}'" EXIT
total="$(discover_files "${tmpfile}")"
log "Files scanned: ${total}"

if [[ "${total}" -eq 0 ]]; then
  log "No matching files found."
  exit 0
fi

# Process
matched=0
while IFS= read -r file; do
  [[ -z "${file}" ]] && continue
  output="$(process_file "${file}" 2>&1)" || true
  if [[ -n "${output}" ]]; then
    echo "${output}"
    matched=$((matched + 1))
  fi
done < "${tmpfile}"

log ""
log "Done: ${matched} files with matches, $((total - matched)) without"
