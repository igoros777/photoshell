#!/usr/bin/env bash
#
#                                      |
#                                  ___/"\___
#                          __________/ o \__________
#                            (I) (G) \___/ (O) (R)
#                                Igor Oseledko
#                               igor@igoros.com
#                                 2026-02-18
# ----------------------------------------------------------------------------
# Build a contact/proof sheet with metadata captions.
# ----------------------------------------------------------------------------

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

SOURCE_DIR="."
RECURSIVE=0
THUMB_LONG_EDGE=256
OUTPUT_FILE="contact_sheet.jpg"
THEME="light"
SHEET_BACKGROUND=""
TILE_BACKGROUND=""
CAPTION_BACKGROUND=""
TEXT_COLOR=""
MAX_PER_SHEET=0  # 0 = unlimited (all images on one sheet)
GAP=12
TARGET_MAX_WIDTH=4096
TARGET_ASPECT=1.6

declare -a IMAGE_FILES=()
declare -a TILE_FILES=()

CONVERT_CMD=()
MONTAGE_CMD=()

usage() {
  cat <<EOF
Usage:
  ${SCRIPT_NAME} [options]

Purpose:
  Generate a contact/proof sheet from photos in a folder.
  Each thumbnail is paired with caption text from metadata:
    1) IPTC Caption-Abstract
    2) EXIF UserComment
    3) Brief EXIF parameter summary fallback

Options:
  -s, --source DIR           Source folder (default: current folder)
  -r, --recursive            Include subfolders
  -n, --no-recursive         Current folder only (default)
  -t, --thumb-size PX        Thumbnail long-edge size in pixels (default: 256)
  --theme NAME               Color theme: light | dark (default: light)
  -o, --output FILE          Output contact sheet file (default: contact_sheet.jpg)
  --max-per-sheet N          Max images per sheet; 0 = all on one sheet (default: 0)
                             When set, produces numbered files (e.g. contact_sheet_1.jpg, _2.jpg)
  -h, --help                 Show this help

Examples:
  ${SCRIPT_NAME}
  ${SCRIPT_NAME} -s /photos/job42 -r -t 320 -o proof_job42.jpg
  ${SCRIPT_NAME} -s /photos/trip --max-per-sheet 60 -o proof.jpg
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

log() {
  echo "$*"
}

apply_theme() {
  THEME="$(printf '%s' "${THEME}" | tr '[:upper:]' '[:lower:]')"
  case "${THEME}" in
    light)
      SHEET_BACKGROUND="#f5f5f5"
      TILE_BACKGROUND="#ffffff"
      CAPTION_BACKGROUND="#ffffff"
      TEXT_COLOR="#1c1c1c"
      ;;
    dark)
      SHEET_BACKGROUND="#1f2328"
      TILE_BACKGROUND="#2b3138"
      CAPTION_BACKGROUND="#2b3138"
      TEXT_COLOR="#d0d6dc"
      ;;
    *)
      die "unknown theme: ${THEME} (expected: light or dark)"
      ;;
  esac
}

normalize_text() {
  local value="$1"
  value="$(printf '%s' "${value}" | tr '\r\n\t' '   ' | sed -E 's/[[:cntrl:]]//g; s/[[:space:]]+/ /g; s/^[[:space:]]+//; s/[[:space:]]+$//')"
  value="$(printf '%s' "${value}" | sed -E 's/^(ASCII|UNICODE|JIS)[[:space:]]+//I')"
  printf '%s' "${value}"
}

get_tag() {
  local tag="$1"
  local file="$2"
  exiftool -s3 "-${tag}" "${file}" 2>/dev/null | head -n 1
}

# Read all needed EXIF tags in one exiftool call to avoid per-tag process spawns
read_all_tags() {
    local file="$1"
    exiftool -T -n -Model -LensModel -Lens -FocalLength -FNumber -ExposureTime -ISO -DateTimeOriginal -CreateDate -GPSLatitude -GPSLongitude "$file" 2>/dev/null
}

build_exif_summary() {
  local file="$1"
  local model lens aperture shutter iso focal dt
  local _t_model _t_lensmodel _t_lens _t_focal _t_fnum _t_exp _t_iso _t_dto _t_cdate _t_lat _t_lon
  local -a parts=()

  # Batch read all tags in a single exiftool invocation
  IFS=$'\t' read -r _t_model _t_lensmodel _t_lens _t_focal _t_fnum _t_exp _t_iso _t_dto _t_cdate _t_lat _t_lon <<< "$(read_all_tags "$file")"

  # Helper: convert exiftool "-" (missing) to empty string
  _ct() { [[ "$1" == "-" ]] && echo "" || echo "$1"; }

  model="$(normalize_text "$(_ct "${_t_model}")")"
  lens="$(normalize_text "$(_ct "${_t_lensmodel}")")"
  if [[ -z "${lens}" ]]; then
    lens="$(normalize_text "$(_ct "${_t_lens}")")"
  fi

  aperture="$(normalize_text "$(_ct "${_t_fnum}")")"
  if [[ -n "${aperture}" && "${aperture}" != f/* ]]; then
    aperture="f/${aperture}"
  fi

  shutter="$(normalize_text "$(_ct "${_t_exp}")")"
  iso="$(normalize_text "$(_ct "${_t_iso}")")"
  focal="$(normalize_text "$(_ct "${_t_focal}")")"
  dt="$(normalize_text "$(_ct "${_t_dto}")")"
  if [[ -z "${dt}" ]]; then
    dt="$(normalize_text "$(_ct "${_t_cdate}")")"
  fi

  [[ -n "${model}" ]] && parts+=("${model}")
  [[ -n "${lens}" ]] && parts+=("${lens}")
  [[ -n "${aperture}" ]] && parts+=("${aperture}")
  [[ -n "${shutter}" ]] && parts+=("${shutter}")
  [[ -n "${iso}" ]] && parts+=("ISO ${iso}")
  [[ -n "${focal}" ]] && parts+=("${focal}")
  [[ -n "${dt}" ]] && parts+=("${dt}")

  if [[ "${#parts[@]}" -eq 0 ]]; then
    echo "No IPTC caption/UserComment. EXIF summary unavailable."
    return
  fi

  (IFS=' | '; printf '%s' "${parts[*]}")
}

caption_for_file() {
  local file="$1"
  local caption

  caption="$(normalize_text "$(get_tag "IPTC:Caption-Abstract" "${file}")")"
  if [[ -n "${caption}" ]]; then
    printf '%s' "${caption}"
    return
  fi

  caption="$(normalize_text "$(get_tag "EXIF:UserComment" "${file}")")"
  if [[ -n "${caption}" ]]; then
    printf '%s' "${caption}"
    return
  fi

  build_exif_summary "${file}"
}

detect_imagemagick() {
  if command -v magick >/dev/null 2>&1; then
    CONVERT_CMD=(magick)
    MONTAGE_CMD=(magick montage)
    return
  fi

  if command -v convert >/dev/null 2>&1 && command -v montage >/dev/null 2>&1; then
    CONVERT_CMD=(convert)
    MONTAGE_CMD=(montage)
    return
  fi

  die "ImageMagick not found. Install IM7 (magick) or IM6 (convert + montage)."
}

check_requirements() {
  command -v exiftool >/dev/null 2>&1 || die "exiftool is required but not found in PATH"
  detect_imagemagick
}

collect_images() {
  local -a find_args=()

  find_args=("${SOURCE_DIR}")
  if [[ "${RECURSIVE}" -eq 0 ]]; then
    find_args+=(-maxdepth 1)
  fi

  find_args+=(
    -type f
    \(
      -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.jpe' -o
      -iname '*.tif' -o -iname '*.tiff' -o -iname '*.png' -o
      -iname '*.heic' -o -iname '*.heif' -o -iname '*.webp' -o
      -iname '*.bmp' -o -iname '*.gif'
    \)
    -print0
  )

  mapfile -d '' -t IMAGE_FILES < <(find "${find_args[@]}" | sort -z)

  if [[ "${#IMAGE_FILES[@]}" -eq 0 ]]; then
    die "no supported image files found in ${SOURCE_DIR}"
  fi
}

calc_columns() {
  local count="$1"
  local tile_width="$2"
  local max_cols ideal_cols cols

  max_cols=$(( TARGET_MAX_WIDTH / tile_width ))
  if (( max_cols < 1 )); then
    max_cols=1
  fi

  ideal_cols="$(awk -v n="${count}" -v a="${TARGET_ASPECT}" 'BEGIN {
    if (n <= 1) { print 1; exit }
    c = int(sqrt(n * a) + 0.999999)
    if (c < 1) c = 1
    print c
  }')"

  cols="${ideal_cols}"
  if (( cols > max_cols )); then
    cols=${max_cols}
  fi
  if (( cols > count )); then
    cols=${count}
  fi
  if (( cols < 1 )); then
    cols=1
  fi

  echo "${cols}"
}

calc_caption_point_size() {
  local min_pt=11
  local max_pt=24
  local scaled

  scaled=$(( THUMB_LONG_EDGE / 18 ))
  if (( scaled < min_pt )); then
    scaled=${min_pt}
  fi
  if (( scaled > max_pt )); then
    scaled=${max_pt}
  fi

  echo "${scaled}"
}

build_tiles() {
  local temp_dir="$1"
  local caption_point_size="$2"
  local file base caption tile
  local index=0
  local current=0
  local total=0

  total="${#IMAGE_FILES[@]}"
  log "Building tiles..."

  local failed=0
  for file in "${IMAGE_FILES[@]}"; do
    base="$(basename "${file}")"
    current=$((index + 1))
    log "  [${current}/${total}] ${base}"

    caption="$(caption_for_file "${file}")"

    tile="${temp_dir}/tile_$(printf '%05d' "${index}").png"
    # -limit flags prevent IM6 from crashing on very large files (HDR panos, multi-layer TIFFs)
    if "${CONVERT_CMD[@]}" \
      -limit memory 1GiB -limit map 2GiB -limit disk 4GiB \
      \( "${file}"[0] -auto-orient -thumbnail "${THUMB_LONG_EDGE}x${THUMB_LONG_EDGE}>" -background "${TILE_BACKGROUND}" -gravity center -extent "${THUMB_LONG_EDGE}x${THUMB_LONG_EDGE}" \) \
      \( -size "${THUMB_LONG_EDGE}x" -background "${CAPTION_BACKGROUND}" -fill "${TEXT_COLOR}" -gravity northwest -pointsize "${caption_point_size}" -style Italic caption:"${base}" -bordercolor "${CAPTION_BACKGROUND}" -border 6x4 \) \
      \( -size "${THUMB_LONG_EDGE}x" -background "${CAPTION_BACKGROUND}" -fill "${TEXT_COLOR}" -gravity northwest -pointsize "${caption_point_size}" -style Normal caption:"${caption}" -bordercolor "${CAPTION_BACKGROUND}" -border 6x4 \) \
      -append "${tile}" 2>&1; then
      TILE_FILES+=("${tile}")
    else
      log "  WARN: skipped ${base} — ImageMagick failed (file may be too large or corrupted)"
      ((failed++)) || true
    fi
    index=$((index + 1))
  done
  if [[ ${failed} -gt 0 ]]; then
    log "  ${failed} file(s) skipped due to errors"
  fi
}

build_contact_sheet() {
  local cols="$1"
  local output="$2"

  log "Assembling contact sheet..."
  "${MONTAGE_CMD[@]}" "${TILE_FILES[@]}" \
    -tile "${cols}x" \
    -geometry +"${GAP}"+"${GAP}" \
    -background "${SHEET_BACKGROUND}" \
    "${output}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--source)
      [[ $# -lt 2 ]] && die "missing value for $1"
      SOURCE_DIR="$2"
      shift 2
      ;;
    -r|--recursive)
      RECURSIVE=1
      shift
      ;;
    -n|--no-recursive)
      RECURSIVE=0
      shift
      ;;
    -t|--thumb-size)
      [[ $# -lt 2 ]] && die "missing value for $1"
      THUMB_LONG_EDGE="$2"
      shift 2
      ;;
    --theme)
      [[ $# -lt 2 ]] && die "missing value for $1"
      THEME="$2"
      shift 2
      ;;
    -o|--output)
      [[ $# -lt 2 ]] && die "missing value for $1"
      OUTPUT_FILE="$2"
      shift 2
      ;;
    --max-per-sheet)
      [[ $# -lt 2 ]] && die "missing value for $1"
      MAX_PER_SHEET="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      die "unexpected argument: $1"
      ;;
  esac
done

[[ -d "${SOURCE_DIR}" ]] || die "source directory does not exist: ${SOURCE_DIR}"
[[ "${THUMB_LONG_EDGE}" =~ ^[0-9]+$ ]] || die "thumbnail size must be an integer"
[[ "${MAX_PER_SHEET}" =~ ^[0-9]+$ ]] || die "max-per-sheet must be a non-negative integer"
if (( THUMB_LONG_EDGE < 64 || THUMB_LONG_EDGE > 4096 )); then
  die "thumbnail size must be between 64 and 4096"
fi

apply_theme
check_requirements
log "Scanning source folder for images..."
collect_images

temp_dir="$(mktemp -d)"
trap 'rm -rf "${temp_dir}"' EXIT

tile_width=$(( THUMB_LONG_EDGE + (GAP * 2) ))
cols="$(calc_columns "${#IMAGE_FILES[@]}" "${tile_width}")"
rows=$(( (${#IMAGE_FILES[@]} + cols - 1) / cols ))
caption_point_size="$(calc_caption_point_size)"

log "Found ${#IMAGE_FILES[@]} image(s)"
log "Thumbnail long edge: ${THUMB_LONG_EDGE}px"
log "Caption font size: ${caption_point_size}pt"
log "Theme: ${THEME}"
log "Contact sheet geometry: ${cols} columns x ${rows} rows"

build_tiles "${temp_dir}" "${caption_point_size}"

# Split into multiple sheets if --max-per-sheet is set
if [[ ${MAX_PER_SHEET} -gt 0 && ${#TILE_FILES[@]} -gt ${MAX_PER_SHEET} ]]; then
  total_tiles="${#TILE_FILES[@]}"
  sheet_count=$(( (total_tiles + MAX_PER_SHEET - 1) / MAX_PER_SHEET ))
  log "Splitting into ${sheet_count} sheets (max ${MAX_PER_SHEET} images per sheet)"

  # Derive numbered output filenames from OUTPUT_FILE
  out_dir="$(dirname "${OUTPUT_FILE}")"
  out_base="$(basename "${OUTPUT_FILE}")"
  out_stem="${out_base%.*}"
  out_ext="${out_base##*.}"

  for ((s=0; s<sheet_count; s++)); do
    start=$(( s * MAX_PER_SHEET ))
    end=$(( start + MAX_PER_SHEET ))
    if (( end > total_tiles )); then
      end=${total_tiles}
    fi
    chunk=("${TILE_FILES[@]:${start}:${MAX_PER_SHEET}}")
    chunk_count="${#chunk[@]}"

    # Recalculate columns for this chunk
    chunk_cols="$(calc_columns "${chunk_count}" "${tile_width}")"

    sheet_num=$((s + 1))
    sheet_file="${out_dir}/${out_stem}_${sheet_num}.${out_ext}"
    log "Sheet ${sheet_num}/${sheet_count}: ${chunk_count} images -> ${sheet_file}"

    "${MONTAGE_CMD[@]}" "${chunk[@]}" \
      -tile "${chunk_cols}x" \
      -geometry +"${GAP}"+"${GAP}" \
      -background "${SHEET_BACKGROUND}" \
      "${sheet_file}"
  done
  log "Done: ${sheet_count} contact sheet(s) created"
else
  build_contact_sheet "${cols}" "${OUTPUT_FILE}"
fi

log "Wrote contact sheet: ${OUTPUT_FILE}"
