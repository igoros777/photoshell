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
BACKGROUND="#f5f5f5"
TEXT_COLOR="#1c1c1c"
GAP=12
TARGET_MAX_WIDTH=4096
TARGET_ASPECT=1.6
CAPTION_POINT_SIZE=13

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
  -o, --output FILE          Output contact sheet file (default: contact_sheet.jpg)
  -h, --help                 Show this help

Examples:
  ${SCRIPT_NAME}
  ${SCRIPT_NAME} -s /photos/job42 -r -t 320 -o proof_job42.jpg
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

log() {
  echo "$*"
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

build_exif_summary() {
  local file="$1"
  local model lens aperture shutter iso focal dt
  local -a parts=()

  model="$(normalize_text "$(get_tag "Model" "${file}")")"
  lens="$(normalize_text "$(get_tag "LensModel" "${file}")")"
  if [[ -z "${lens}" ]]; then
    lens="$(normalize_text "$(get_tag "Lens" "${file}")")"
  fi

  aperture="$(normalize_text "$(get_tag "FNumber" "${file}")")"
  if [[ -n "${aperture}" && "${aperture}" != f/* ]]; then
    aperture="f/${aperture}"
  fi

  shutter="$(normalize_text "$(get_tag "ExposureTime" "${file}")")"
  iso="$(normalize_text "$(get_tag "ISO" "${file}")")"
  focal="$(normalize_text "$(get_tag "FocalLength" "${file}")")"
  dt="$(normalize_text "$(get_tag "DateTimeOriginal" "${file}")")"
  if [[ -z "${dt}" ]]; then
    dt="$(normalize_text "$(get_tag "CreateDate" "${file}")")"
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

build_tiles() {
  local temp_dir="$1"
  local file base caption tile
  local index=0
  local current=0
  local total=0

  total="${#IMAGE_FILES[@]}"
  log "Building tiles..."

  for file in "${IMAGE_FILES[@]}"; do
    base="$(basename "${file}")"
    current=$((index + 1))
    log "  [${current}/${total}] ${base}"

    caption="$(caption_for_file "${file}")"
    caption="${base} | ${caption}"

    tile="${temp_dir}/tile_$(printf '%05d' "${index}").png"
    "${CONVERT_CMD[@]}" \
      \( "${file}" -auto-orient -thumbnail "${THUMB_LONG_EDGE}x${THUMB_LONG_EDGE}>" -background white -gravity center -extent "${THUMB_LONG_EDGE}x${THUMB_LONG_EDGE}" \) \
      \( -size "${THUMB_LONG_EDGE}x" -background white -fill "${TEXT_COLOR}" -gravity northwest -pointsize "${CAPTION_POINT_SIZE}" caption:"${caption}" -bordercolor white -border 0x8 \) \
      -append "${tile}"

    TILE_FILES+=("${tile}")
    index=$((index + 1))
  done
}

build_contact_sheet() {
  local cols="$1"
  local output="$2"

  log "Assembling contact sheet..."
  "${MONTAGE_CMD[@]}" "${TILE_FILES[@]}" \
    -tile "${cols}x" \
    -geometry +"${GAP}"+"${GAP}" \
    -background "${BACKGROUND}" \
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
    -o|--output)
      [[ $# -lt 2 ]] && die "missing value for $1"
      OUTPUT_FILE="$2"
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
if (( THUMB_LONG_EDGE < 64 || THUMB_LONG_EDGE > 4096 )); then
  die "thumbnail size must be between 64 and 4096"
fi

check_requirements
log "Scanning source folder for images..."
collect_images

temp_dir="$(mktemp -d)"
trap 'rm -rf "${temp_dir}"' EXIT

tile_width=$(( THUMB_LONG_EDGE + (GAP * 2) ))
cols="$(calc_columns "${#IMAGE_FILES[@]}" "${tile_width}")"
rows=$(( (${#IMAGE_FILES[@]} + cols - 1) / cols ))

log "Found ${#IMAGE_FILES[@]} image(s)"
log "Thumbnail long edge: ${THUMB_LONG_EDGE}px"
log "Contact sheet geometry: ${cols} columns x ${rows} rows"

build_tiles "${temp_dir}"
build_contact_sheet "${cols}" "${OUTPUT_FILE}"

log "Wrote contact sheet: ${OUTPUT_FILE}"
