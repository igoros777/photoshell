#!/usr/bin/env bash
#
#                                      |
#                                  ___/"\___
#                          __________/ o \__________
#                            (I) (G) \___/ (O) (R)
#                                Igor Oseledko
#                               igor@igoros.com
#                                  2026-02-13
# ----------------------------------------------------------------------------
# Batch-rename photos using EXIF metadata and optional reverse geocoding.
# Filename pattern:
#   YYYYMMDD-HHMMSS-<camera_model>-<location>.<ext>
# Metadata sources:
# - timestamp: DateTimeOriginal (fallback: CreateDate, then ModifyDate)
# - model    : Model
# - GPS      : GPSLatitude,GPSLongitude -> geocod.io reverse lookup
# Fallbacks:
# - missing/failed geocode or API key -> mystery_town
# - missing model -> unknowncamera
# Optional folder structures:
# - none    : keep files in current folder
# - daily   : YYYY/YYYY-MM-DD
# - monthly : YYYY/YYYY-MM
# ----------------------------------------------------------------------------
set -euo pipefail

# ----------------------------------------------------------------------------
# CONFIGURATION
# ----------------------------------------------------------------------------
configure() {
  v='v1.7'
  apibase="https://api.geocod.io/${v}"
  api_key="${GEOCODIO_API_KEY:-Get your API key from https://www.geocod.io}"

  DRY_RUN=0
  STRUCTURE="none"
  OVERRIDE_LOCATION=""

  PHOTO_EXTS=(
    jpg jpeg jpe
    heic heif
    tif tiff
    png webp
    dng
    nef cr2 cr3 arw orf rw2 rwl srw raf pef x3f
  )
}

usage() {
  cat <<'EOF'
Usage: geo_rename_photos.sh [--dry-run] [--structure none|daily|monthly]
                            [--location "City, State"]

Options:
  --dry-run                 Print planned changes only (no writes/moves)
  --structure <value>       Optional folder structure:
                            none (default)  -> keep files in current folder
                            daily           -> YYYY/YYYY-MM-DD
                            monthly         -> YYYY/YYYY-MM
  --location <name>         Fallback location for photos without GPS
                            (used instead of "mystery_town")
  -h, --help                Show this help

Environment:
  GEOCODIO_API_KEY          geocod.io API key (recommended)
EOF
}

check_requirements() {
  local missing=0
  local cmd
  for cmd in exiftool curl jq find sed date grep awk; do
    if ! command -v "${cmd}" >/dev/null 2>&1; then
      echo "Missing required command: ${cmd}" >&2
      missing=1
    fi
  done
  if [[ ${missing} -ne 0 ]]; then
    exit 1
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "${1}" in
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --structure)
        if [[ $# -lt 2 ]]; then
          echo "Error: --structure requires a value" >&2
          usage
          exit 1
        fi
        case "${2}" in
          none|flat)
            STRUCTURE="none"
            ;;
          daily|day|one|1)
            STRUCTURE="daily"
            ;;
          monthly|month|two|2)
            STRUCTURE="monthly"
            ;;
          *)
            echo "Error: invalid structure '${2}'. Use none|daily|monthly" >&2
            usage
            exit 1
            ;;
        esac
        shift 2
        ;;
      --location)
        if [[ $# -lt 2 ]]; then
          echo "Error: --location requires a value" >&2
          usage
          exit 1
        fi
        OVERRIDE_LOCATION="${2}"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "Error: unknown argument '${1}'" >&2
        usage
        exit 1
        ;;
    esac
  done
}

build_find_expr() {
  FIND_EXPR=()
  local ext
  for ext in "${PHOTO_EXTS[@]}"; do
    [[ ${#FIND_EXPR[@]} -gt 0 ]] && FIND_EXPR+=("-o")
    FIND_EXPR+=("-iname" "*.${ext}")
  done
}

find_photos() {
  build_find_expr
  mapfile -d '' -t PHOTO_FILES < <(
    find . -mindepth 1 -maxdepth 1 -type f \( "${FIND_EXPR[@]}" \) -print0
  )

  if [[ ${#PHOTO_FILES[@]} -eq 0 ]]; then
    echo "No supported photo files found in current directory."
    exit 0
  fi
  echo "Found ${#PHOTO_FILES[@]} photo file(s)."
}

sanitize_location() {
  echo "${1}" | tr '[:upper:]' '[:lower:]' | \
    sed -e 's/[^A-Za-z0-9._-]/_/g' -e 's/__/_/g' -e 's/^_//' -e 's/_$//'
}

sanitize_model() {
  echo "${1}" | tr '[:upper:]' '[:lower:]' | \
    sed -e 's/[- ]//g' -e 's/[^A-Za-z0-9._-]/_/g' -e 's/__/_/g' -e 's/^_//' -e 's/_$//'
}

query_location() {
  local coordinates="${1}"
  local raw_location
  raw_location="$(
    curl -s0 -q -k "${apibase}/reverse?q=${coordinates}&api_key=${api_key}&limit=1" | \
      jq -r '.results[0].formatted_address // empty' 2>/dev/null
  )"
  sanitize_location "${raw_location}"
}

resolve_location() {
  local coordinates="${1}"

  # No GPS coordinates — use override or fallback
  if [[ -z "${coordinates}" ]]; then
    if [[ -n "${OVERRIDE_LOCATION}" ]]; then
      sanitize_location "${OVERRIDE_LOCATION}"
    else
      echo "mystery_town"
    fi
    return
  fi

  if [[ "${api_key}" == "Get your API key from https://www.geocod.io" ]]; then
    if [[ -n "${OVERRIDE_LOCATION}" ]]; then
      sanitize_location "${OVERRIDE_LOCATION}"
    else
      echo "mystery_town"
    fi
    return
  fi

  local location
  location="$(query_location "${coordinates}")"
  if [[ -n "${location}" ]]; then
    echo "${location}"
    return
  fi

  local lat lon
  lat="$(echo "${coordinates}" | awk -F, '{print $1}' | sed 's/[0-9]$//')"
  lon="$(echo "${coordinates}" | awk -F, '{print $2}' | sed 's/[0-9]$//')"
  coordinates="${lat},${lon}"

  location="$(query_location "${coordinates}")"
  if [[ -n "${location}" ]]; then
    echo "${location}"
  elif [[ -n "${OVERRIDE_LOCATION}" ]]; then
    sanitize_location "${OVERRIDE_LOCATION}"
  else
    echo "mystery_town"
  fi
}

normalize_datetime() {
  echo "${1}" | sed 's/^\([0-9]\{4\}\):\([0-9]\{2\}\):\([0-9]\{2\}\)/\1-\2-\3/'
}

choose_target_dir() {
  local epoch="${1}"
  case "${STRUCTURE}" in
    none)
      echo "."
      ;;
    daily)
      date -d "@${epoch}" '+%Y/%Y-%m-%d'
      ;;
    monthly)
      date -d "@${epoch}" '+%Y/%Y-%m'
      ;;
    *)
      echo "."
      ;;
  esac
}

resolve_collision() {
  local source_path="${1}"
  local target_path="${2}"

  if [[ "${source_path}" == "${target_path}" || ! -e "${target_path}" ]]; then
    echo "${target_path}"
    return
  fi

  local dir file base ext i candidate
  dir="$(dirname "${target_path}")"
  file="$(basename "${target_path}")"
  base="${file}"
  ext=""

  if [[ "${file}" == *.* ]]; then
    base="${file%.*}"
    ext=".${file##*.}"
  fi

  # Bound the collision loop to prevent infinite iteration
  local max_attempts=1000
  local attempt=0
  i=1
  while true; do
    ((attempt++))
    if (( attempt > max_attempts )); then
      echo "ERROR: Could not resolve filename collision after $max_attempts attempts for: $1" >&2
      return 1
    fi
    candidate="${dir}/${base}-${i}${ext}"
    if [[ ! -e "${candidate}" || "${source_path}" == "${candidate}" ]]; then
      echo "${candidate}"
      return
    fi
    ((i++))
  done
}

process_photo() {
  local file="${1}"
  local dt_raw dt_norm epoch stamp model_raw model coordinates location ext
  local target_dir target_path final_target

  dt_raw="$(exiftool -s -s -s -DateTimeOriginal "${file}" 2>/dev/null || true)"
  [[ -z "${dt_raw}" ]] && dt_raw="$(exiftool -s -s -s -CreateDate "${file}" 2>/dev/null || true)"
  [[ -z "${dt_raw}" ]] && dt_raw="$(exiftool -s -s -s -ModifyDate "${file}" 2>/dev/null || true)"

  if [[ -z "${dt_raw}" ]]; then
    echo "SKIP $(basename "${file}"): no DateTimeOriginal/CreateDate/ModifyDate"
    ((SKIPPED+=1))
    return
  fi

  dt_norm="$(normalize_datetime "${dt_raw}")"
  epoch="$(date -d "${dt_norm}" +%s 2>/dev/null || true)"
  if [[ -z "${epoch}" ]]; then
    echo "SKIP $(basename "${file}"): invalid date '${dt_raw}'"
    ((SKIPPED+=1))
    return
  fi
  stamp="$(date -d "@${epoch}" '+%Y%m%d-%H%M%S')"

  model_raw="$(exiftool -s -s -s -Model "${file}" 2>/dev/null || true)"
  model="$(sanitize_model "${model_raw}")"
  [[ -z "${model}" ]] && model="unknowncamera"

  coordinates="$(exiftool -q -m -n -p '$GPSLatitude,$GPSLongitude' "${file}" 2>/dev/null || true)"
  if ! echo "${coordinates}" | grep -qE '^-?[0-9]+([.][0-9]+)?,-?[0-9]+([.][0-9]+)?$'; then
    coordinates=""
  fi
  location="$(resolve_location "${coordinates}")"
  [[ -z "${location}" ]] && location="mystery_town"

  ext="${file##*.}"
  ext="$(echo "${ext}" | tr '[:upper:]' '[:lower:]')"

  target_dir="$(choose_target_dir "${epoch}")"
  target_path="${target_dir}/${stamp}-${model}-${location}.${ext}"
  final_target="$(resolve_collision "${file}" "${target_path}")"

  if [[ "${file}" == "${final_target}" ]]; then
    echo "SKIP $(basename "${file}"): already matches target name/location"
    ((SKIPPED+=1))
    return
  fi

  if [[ ${DRY_RUN} -eq 1 ]]; then
    echo "PLAN ${file} -> ${final_target}"
    ((PLANNED+=1))
    return
  fi

  exiftool -P -overwrite_original_in_place \
    '-XMP-xmpMM:PreservedFileName<${filename;s/\.[^.]*$//}' \
    "${file}" >/dev/null 2>&1 || true

  if [[ "${target_dir}" != "." ]]; then
    mkdir -p "${target_dir}"
  fi

  mv -- "${file}" "${final_target}"
  echo "DONE ${file} -> ${final_target}"
  ((RENAMED+=1))
}

# ----------------------------------------------------------------------------
# RUNTIME
# \(^_^)/                                      __|__
#                                     __|__ *---o0o---*
#                            __|__ *---o0o---*
#                         *---o0o---*
# ----------------------------------------------------------------------------
configure
parse_args "$@"
check_requirements
find_photos

PLANNED=0
RENAMED=0
SKIPPED=0

if [[ ${DRY_RUN} -eq 1 ]]; then
  echo "[DRY-RUN mode: no files will be changed]"
fi

for photo_file in "${PHOTO_FILES[@]}"; do
  process_photo "${photo_file}"
done

echo ""
if [[ ${DRY_RUN} -eq 1 ]]; then
  echo "Dry run complete: ${PLANNED} planned, ${SKIPPED} skipped."
else
  echo "Complete: ${RENAMED} renamed/moved, ${SKIPPED} skipped."
fi
