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
# Batch-write copyright, creator, and contact metadata to IPTC/EXIF fields.
# ----------------------------------------------------------------------------
# Change Log:
# ****************************************************************************
# 2026-03-27	igor@igoros.com	Wrote this script
# ****************************************************************************

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

INPUT_DIR="."
AUTHOR=""
COPYRIGHT=""
EMAIL=""
WEBSITE=""
CREDIT=""
SOURCE=""
FORCE=0
RECURSIVE=0
DRY_RUN=0
FILE_TYPES=""
DEFAULT_TYPES="jpg,jpeg,png,tif,tiff,heic,heif,webp,bmp,gif,dng,nef,cr2,cr3,arw,orf,rw2,srw,raf,pef,x3f"

usage() {
  cat <<EOF
Usage:
  ${SCRIPT_NAME} [options] [DIRECTORY]

Purpose:
  Batch-write copyright, creator, and contact metadata to photo files.
  By default, only fills fields that are currently empty. Use --force
  to overwrite existing values.

Options:
  -a, --author NAME        Photographer/creator name
                           (writes IPTC:By-line and EXIF:Artist)
  -c, --copyright TEXT     Copyright notice
                           (writes IPTC:CopyrightNotice and EXIF:Copyright)
                           Use %Y for current year: "© %Y John Smith"
  -e, --email EMAIL        Contact email (writes XMP-iptcCore:CiEmailWork)
  -w, --website URL        Contact website (writes XMP-iptcCore:CiUrlWork)
  --credit TEXT             Credit line (writes IPTC:Credit)
  --source TEXT             Source (writes IPTC:Source)
  -f, --force              Overwrite existing values (default: fill empty only)
  -r, --recursive          Include subfolders
  -t, --types EXT,...      File extensions (default: all image types)
  -n, --dry-run            Preview changes without writing
  -h, --help               Show this help

Examples:
  ${SCRIPT_NAME} -a "Igor Oseledko" -c "© %Y Igor Oseledko" /photos
  ${SCRIPT_NAME} -a "Igor Oseledko" -e "igor@igoros.com" -w "https://fieldexposure.com" /photos
  ${SCRIPT_NAME} -a "Igor Oseledko" -c "© %Y Igor Oseledko" --force -r /photos
  ${SCRIPT_NAME} -a "Igor Oseledko" --credit "Igor Oseledko / Field Exposure" -n /photos
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
# Check if a field is empty for a file
# ---------------------------------------------------------------------------

field_is_empty() {
  local file="$1"
  local tag="$2"
  local val
  val="$(exiftool -s3 "-${tag}" "${file}" 2>/dev/null)" || return 0
  [[ -z "${val}" || "${val}" == " " ]]
}

# ---------------------------------------------------------------------------
# Main processing
# ---------------------------------------------------------------------------

process_file() {
  local file="$1"
  local fname
  fname="$(basename "${file}")"

  local -a exif_args=()
  local fields_written=0
  local fields_skipped=0

  # Author → IPTC:By-line + EXIF:Artist
  if [[ -n "${AUTHOR}" ]]; then
    if [[ "${FORCE}" -eq 1 ]] || field_is_empty "${file}" "IPTC:By-line"; then
      exif_args+=("-IPTC:By-line=${AUTHOR}" "-EXIF:Artist=${AUTHOR}")
      fields_written=$((fields_written + 1))
    else
      fields_skipped=$((fields_skipped + 1))
    fi
  fi

  # Copyright → IPTC:CopyrightNotice + EXIF:Copyright
  if [[ -n "${COPYRIGHT}" ]]; then
    if [[ "${FORCE}" -eq 1 ]] || field_is_empty "${file}" "IPTC:CopyrightNotice"; then
      exif_args+=("-IPTC:CopyrightNotice=${COPYRIGHT}" "-EXIF:Copyright=${COPYRIGHT}")
      fields_written=$((fields_written + 1))
    else
      fields_skipped=$((fields_skipped + 1))
    fi
  fi

  # Email → XMP-iptcCore:CreatorContactInfo/CiEmailWork
  if [[ -n "${EMAIL}" ]]; then
    if [[ "${FORCE}" -eq 1 ]] || field_is_empty "${file}" "XMP-iptcCore:CiEmailWork"; then
      exif_args+=("-XMP-iptcCore:CiEmailWork=${EMAIL}")
      fields_written=$((fields_written + 1))
    else
      fields_skipped=$((fields_skipped + 1))
    fi
  fi

  # Website → XMP-iptcCore:CreatorContactInfo/CiUrlWork
  if [[ -n "${WEBSITE}" ]]; then
    if [[ "${FORCE}" -eq 1 ]] || field_is_empty "${file}" "XMP-iptcCore:CiUrlWork"; then
      exif_args+=("-XMP-iptcCore:CiUrlWork=${WEBSITE}")
      fields_written=$((fields_written + 1))
    else
      fields_skipped=$((fields_skipped + 1))
    fi
  fi

  # Credit → IPTC:Credit
  if [[ -n "${CREDIT}" ]]; then
    if [[ "${FORCE}" -eq 1 ]] || field_is_empty "${file}" "IPTC:Credit"; then
      exif_args+=("-IPTC:Credit=${CREDIT}")
      fields_written=$((fields_written + 1))
    else
      fields_skipped=$((fields_skipped + 1))
    fi
  fi

  # Source → IPTC:Source
  if [[ -n "${SOURCE}" ]]; then
    if [[ "${FORCE}" -eq 1 ]] || field_is_empty "${file}" "IPTC:Source"; then
      exif_args+=("-IPTC:Source=${SOURCE}")
      fields_written=$((fields_written + 1))
    else
      fields_skipped=$((fields_skipped + 1))
    fi
  fi

  if [[ "${#exif_args[@]}" -eq 0 ]]; then
    echo "  SKIP   ${fname}  (all fields already populated)"
    return 1
  fi

  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "  [plan] ${fname}  (${fields_written} field(s) would be written, ${fields_skipped} skipped)"
    return 0
  fi

  exif_args+=("-overwrite_original")

  if exiftool "${exif_args[@]}" "${file}" >/dev/null 2>&1; then
    echo "  SET    ${fname}  (${fields_written} field(s) written)"
    return 0
  else
    echo "  FAIL   ${fname}  (exiftool error)"
    return 2
  fi
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    -a|--author)
      [[ $# -lt 2 ]] && die "$1 requires a name"
      AUTHOR="$2"; shift 2 ;;
    -c|--copyright)
      [[ $# -lt 2 ]] && die "$1 requires text"
      COPYRIGHT="$2"; shift 2 ;;
    -e|--email)
      [[ $# -lt 2 ]] && die "$1 requires an email"
      EMAIL="$2"; shift 2 ;;
    -w|--website)
      [[ $# -lt 2 ]] && die "$1 requires a URL"
      WEBSITE="$2"; shift 2 ;;
    --credit)
      [[ $# -lt 2 ]] && die "$1 requires text"
      CREDIT="$2"; shift 2 ;;
    --source)
      [[ $# -lt 2 ]] && die "$1 requires text"
      SOURCE="$2"; shift 2 ;;
    -f|--force)
      FORCE=1; shift ;;
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

if [[ -z "${AUTHOR}" && -z "${COPYRIGHT}" && -z "${EMAIL}" && -z "${WEBSITE}" && -z "${CREDIT}" && -z "${SOURCE}" ]]; then
  die "At least one of --author, --copyright, --email, --website, --credit, or --source is required"
fi

command -v exiftool >/dev/null 2>&1 || die "exiftool is required"

# %Y substitution in copyright
if [[ -n "${COPYRIGHT}" ]]; then
  COPYRIGHT="${COPYRIGHT//%Y/$(date +%Y)}"
fi

# Display settings
log "Copyright/Creator Metadata"
[[ -n "${AUTHOR}" ]]    && log "  Author:    ${AUTHOR}"
[[ -n "${COPYRIGHT}" ]] && log "  Copyright: ${COPYRIGHT}"
[[ -n "${EMAIL}" ]]     && log "  Email:     ${EMAIL}"
[[ -n "${WEBSITE}" ]]   && log "  Website:   ${WEBSITE}"
[[ -n "${CREDIT}" ]]    && log "  Credit:    ${CREDIT}"
[[ -n "${SOURCE}" ]]    && log "  Source:    ${SOURCE}"
[[ "${FORCE}" -eq 1 ]]  && log "  Mode:      overwrite all" || log "  Mode:      fill empty fields only"
[[ "${DRY_RUN}" -eq 1 ]] && log "  Dry run:   yes"
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

# Process
updated=0
skipped=0
failed=0

while IFS= read -r file; do
  [[ -z "${file}" ]] && continue
  result=0
  process_file "${file}" || result=$?
  case "${result}" in
    0) updated=$((updated + 1)) ;;
    1) skipped=$((skipped + 1)) ;;
    2) failed=$((failed + 1)) ;;
  esac
done < "${tmpfile}"

log ""
log "Done: ${updated} updated, ${skipped} skipped, ${failed} failed"
