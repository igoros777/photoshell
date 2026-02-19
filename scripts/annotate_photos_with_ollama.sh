#!/usr/bin/env bash
#
#                                      |
#                                  ___/"\___
#                          __________/ o \__________
#                            (I) (G) \___/ (O) (R)
#                                Igor Oseledko
#                               igor@igoros.com
#                                 2026-02-19
# ----------------------------------------------------------------------------
# Generate concise technical photo descriptions with Ollama and append them to
# IPTC Caption-Abstract and EXIF UserComment metadata fields.
# ----------------------------------------------------------------------------

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
SOURCE_DIR="."
RECURSIVE=0
MODEL="gemma3:27b"

PROMPT_TEXT="Provide a concise description most relevant to the technical photographic aspects. Inspect the IPTC Comment field and the EXIF UserComment field for location information. Use this location data to enhance your description with subject details. Do not mention the source of the location data. If both fields have location data, then use both to construct the most complete location. Present your response in a concise and information-dense format. Do not include any formatting or commentary."

declare -a IMAGE_FILES=()

usage() {
  cat <<EOF
Usage:
  ${SCRIPT_NAME} [options] [DIRECTORY]

Purpose:
  Find image files and, for each file:
    1) Run Ollama to generate a concise technical description
    2) Append that description to IPTC Caption-Abstract
    3) Append that description to EXIF UserComment

Options:
  -r, --recursive            Include subfolders
  -n, --no-recursive         Current folder only (default)
  -m, --model NAME           Ollama model (default: ${MODEL})
  -h, --help                 Show this help

Examples:
  ${SCRIPT_NAME}
  ${SCRIPT_NAME} -r
  ${SCRIPT_NAME} -r /photos/session42
  ${SCRIPT_NAME} -m gemma3:12b /photos
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

log() {
  echo "$*"
}

warn() {
  echo "Warning: $*" >&2
}

trim_text() {
  local value="$1"
  value="$(printf '%s' "${value}" | tr '\r\n\t' '   ' | sed -E 's/[[:cntrl:]]//g; s/[[:space:]]+/ /g; s/^[[:space:]]+//; s/[[:space:]]+$//')"
  printf '%s' "${value}"
}

check_requirements() {
  command -v find >/dev/null 2>&1 || die "find is required but not found in PATH"
  command -v ollama >/dev/null 2>&1 || die "ollama is required but not found in PATH"
  command -v exiftool >/dev/null 2>&1 || die "exiftool is required but not found in PATH"
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
      -iname '*.png' -o -iname '*.tif' -o -iname '*.tiff' -o
      -iname '*.heic' -o -iname '*.heif' -o -iname '*.webp' -o
      -iname '*.bmp' -o -iname '*.gif' -o -iname '*.dng' -o
      -iname '*.arw' -o -iname '*.cr2' -o -iname '*.cr3' -o
      -iname '*.nef' -o -iname '*.nrw' -o -iname '*.orf' -o
      -iname '*.raf' -o -iname '*.rw2' -o -iname '*.pef' -o
      -iname '*.srw' -o -iname '*.x3f'
    \)
    -print0
  )

  mapfile -d '' -t IMAGE_FILES < <(find "${find_args[@]}")

  if [[ "${#IMAGE_FILES[@]}" -eq 0 ]]; then
    die "no supported image files found in ${SOURCE_DIR}"
  fi
}

append_text() {
  local existing="$1"
  local addition="$2"

  if [[ -z "${existing}" ]]; then
    printf '%s' "${addition}"
    return
  fi

  printf '%s\n%s' "${existing}" "${addition}"
}

read_tag() {
  local tag="$1"
  local file="$2"
  exiftool -s3 "-${tag}" "${file}" 2>/dev/null || true
}

generate_description() {
  local file="$1"
  local output

  if ! output="$(ollama run "${MODEL}" "${PROMPT_TEXT}" "${file}" 2>/dev/null)"; then
    return 1
  fi

  output="$(trim_text "${output}")"
  [[ -n "${output}" ]] || return 1
  printf '%s' "${output}"
}

append_metadata() {
  local file="$1"
  local description="$2"
  local current_iptc current_user updated_iptc updated_user

  current_iptc="$(read_tag "IPTC:Caption-Abstract" "${file}")"
  current_user="$(read_tag "EXIF:UserComment" "${file}")"

  updated_iptc="$(append_text "${current_iptc}" "${description}")"
  updated_user="$(append_text "${current_user}" "${description}")"

  exiftool -overwrite_original \
    "-IPTC:Caption-Abstract=${updated_iptc}" \
    "-EXIF:UserComment=${updated_user}" \
    "${file}" >/dev/null
}

process_images() {
  local file total idx base description
  total="${#IMAGE_FILES[@]}"
  idx=0

  for file in "${IMAGE_FILES[@]}"; do
    idx=$((idx + 1))
    base="$(basename "${file}")"
    log "[${idx}/${total}] ${base}"

    if ! description="$(generate_description "${file}")"; then
      warn "skipping ${file}: failed to get description from ollama"
      continue
    fi

    if ! append_metadata "${file}" "${description}"; then
      warn "failed to write metadata for ${file}"
      continue
    fi

    log "  appended description to IPTC + EXIF"
  done
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -r|--recursive)
      RECURSIVE=1
      shift
      ;;
    -n|--no-recursive)
      RECURSIVE=0
      shift
      ;;
    -m|--model)
      [[ $# -lt 2 ]] && die "missing value for $1"
      MODEL="$2"
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
      if [[ "${SOURCE_DIR}" != "." ]]; then
        die "only one DIRECTORY argument is supported"
      fi
      SOURCE_DIR="$1"
      shift
      ;;
  esac
done

[[ -d "${SOURCE_DIR}" ]] || die "source directory does not exist: ${SOURCE_DIR}"

check_requirements
log "Scanning for image files in: ${SOURCE_DIR}"
collect_images
log "Found ${#IMAGE_FILES[@]} image(s)"
log "Model: ${MODEL}"

process_images

log "Done."
