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
# Generate concise technical photo descriptions with Ollama, replacing IPTC
# Caption-Abstract and appending to EXIF UserComment metadata fields.
# ----------------------------------------------------------------------------

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="."
RECURSIVE=0
MODEL="gemma3:27b"
SINGLE_FILE=""
LIST_FILE=""
SELECTED_PROMPT_ID=""
LIST_PROMPTS_ONLY=0

DEFAULT_PROMPT_TEXT="Provide a concise description most relevant to the technical photographic aspects. Inspect the IPTC Comment field and the EXIF UserComment field for location information. Use this location data to enhance your description with subject details. Do not mention the source of the location data. If both fields have location data, then use both to construct the most complete location. Present your response in a concise and information-dense format. Do not include any formatting or commentary."
PROMPT_TEXT="${DEFAULT_PROMPT_TEXT}"
PROMPT_FILE="${SCRIPT_DIR}/annotate_photos_with_ollama.prompts.txt"

declare -a IMAGE_FILES=()
declare -a PROMPT_IDS=()
declare -a PROMPT_VALUES=()

usage() {
  cat <<EOF
Usage:
  ${SCRIPT_NAME} [options] [DIRECTORY]

Purpose:
  Find image files (directory scan, single file, or list file) and, for each file:
    1) Run Ollama to generate a concise technical description
    2) Replace IPTC Caption-Abstract with that description
    3) Append that description to EXIF UserComment

Options:
  -r, --recursive            Include subfolders
  -n, --no-recursive         Current folder only (default)
  -f, --file FILE            Process exactly one image file
  -l, --list FILE            Read image paths from a text file (one per line)
  -m, --model NAME           Ollama model (default: ${MODEL})
  -p, --prompt-id ID         Use prompt ID from prompt file (0 = built-in fallback)
      --list-prompts         List prompts from prompt file and exit
      --prompt-file FILE     Prompt file path (default: ${PROMPT_FILE})
  -h, --help                 Show this help

Examples:
  ${SCRIPT_NAME}
  ${SCRIPT_NAME} -r
  ${SCRIPT_NAME} -r /photos/session42
  ${SCRIPT_NAME} -f /photos/session42/img001.cr3
  ${SCRIPT_NAME} -l /photos/batch_file_list.txt
  ${SCRIPT_NAME} --list-prompts
  ${SCRIPT_NAME} --prompt-id 1 -r /photos/session42
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

trim_edges() {
  local value="$1"
  value="$(printf '%s' "${value}" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  printf '%s' "${value}"
}

load_prompts_file() {
  local file="$1"
  local line trimmed prompt_id prompt_value idx replaced

  PROMPT_IDS=()
  PROMPT_VALUES=()

  [[ -f "${file}" ]] || return 1

  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    trimmed="$(trim_edges "${line}")"

    [[ -z "${trimmed}" ]] && continue
    [[ "${trimmed}" == \#* ]] && continue

    if [[ "${trimmed}" =~ ^([0-9]+)[[:space:]]*\|[[:space:]]*(.+)$ ]]; then
      prompt_id="${BASH_REMATCH[1]}"
      prompt_value="$(trim_text "${BASH_REMATCH[2]}")"
      [[ -z "${prompt_value}" ]] && continue

      replaced=0
      for idx in "${!PROMPT_IDS[@]}"; do
        if [[ "${PROMPT_IDS[$idx]}" == "${prompt_id}" ]]; then
          PROMPT_VALUES[$idx]="${prompt_value}"
          replaced=1
          break
        fi
      done

      if [[ "${replaced}" -eq 0 ]]; then
        PROMPT_IDS+=("${prompt_id}")
        PROMPT_VALUES+=("${prompt_value}")
      fi
    else
      warn "ignoring invalid prompt entry in ${file}: ${trimmed}"
    fi
  done < "${file}"

  [[ "${#PROMPT_IDS[@]}" -gt 0 ]] || return 2
}

find_prompt_text_by_id() {
  local wanted_id="$1"
  local idx

  for idx in "${!PROMPT_IDS[@]}"; do
    if [[ "${PROMPT_IDS[$idx]}" == "${wanted_id}" ]]; then
      printf '%s' "${PROMPT_VALUES[$idx]}"
      return 0
    fi
  done

  return 1
}

list_available_prompts() {
  local idx
  log "Prompt file: ${PROMPT_FILE}"
  for idx in "${!PROMPT_IDS[@]}"; do
    log "  ${PROMPT_IDS[$idx]} | ${PROMPT_VALUES[$idx]}"
  done
  log "  0 | ${DEFAULT_PROMPT_TEXT} (built-in fallback)"
}

configure_prompt() {
  local load_status=0
  local selected_prompt=""

  if load_prompts_file "${PROMPT_FILE}"; then
    load_status=0
  else
    load_status=$?
  fi

  if [[ "${LIST_PROMPTS_ONLY}" -eq 1 ]]; then
    if [[ "${load_status}" -ne 0 ]]; then
      die "prompt file not found or has no valid prompts: ${PROMPT_FILE}"
    fi
    list_available_prompts
    exit 0
  fi

  if [[ -z "${SELECTED_PROMPT_ID}" ]]; then
    if [[ "${load_status}" -eq 0 ]]; then
      log "Prompt file detected: ${PROMPT_FILE} (use --list-prompts or --prompt-id ID)"
    fi
    PROMPT_TEXT="${DEFAULT_PROMPT_TEXT}"
    return 0
  fi

  if [[ "${SELECTED_PROMPT_ID}" == "0" ]]; then
    PROMPT_TEXT="${DEFAULT_PROMPT_TEXT}"
    log "Using built-in fallback prompt (ID 0)"
    return 0
  fi

  if [[ "${load_status}" -ne 0 ]]; then
    warn "prompt file not found or has no valid prompts; using built-in fallback prompt"
    PROMPT_TEXT="${DEFAULT_PROMPT_TEXT}"
    return 0
  fi

  if selected_prompt="$(find_prompt_text_by_id "${SELECTED_PROMPT_ID}")"; then
    PROMPT_TEXT="${selected_prompt}"
    log "Using prompt ID ${SELECTED_PROMPT_ID} from ${PROMPT_FILE}"
  else
    warn "prompt ID ${SELECTED_PROMPT_ID} not found in ${PROMPT_FILE}; using built-in fallback prompt"
    PROMPT_TEXT="${DEFAULT_PROMPT_TEXT}"
  fi
}

check_requirements() {
  command -v find >/dev/null 2>&1 || die "find is required but not found in PATH"
  command -v ollama >/dev/null 2>&1 || die "ollama is required but not found in PATH"
  command -v exiftool >/dev/null 2>&1 || die "exiftool is required but not found in PATH"
}

is_supported_image_file() {
  local file="$1"
  local lower
  lower="$(printf '%s' "${file}" | tr '[:upper:]' '[:lower:]')"

  case "${lower}" in
    *.jpg|*.jpeg|*.jpe|*.png|*.tif|*.tiff|*.heic|*.heif|*.webp|*.bmp|*.gif|*.dng|*.arw|*.cr2|*.cr3|*.nef|*.nrw|*.orf|*.raf|*.rw2|*.pef|*.srw|*.x3f)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

collect_images_from_directory() {
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

collect_images_from_single_file() {
  if [[ ! -f "${SINGLE_FILE}" ]]; then
    die "file does not exist: ${SINGLE_FILE}"
  fi

  if ! is_supported_image_file "${SINGLE_FILE}"; then
    die "unsupported image format for --file: ${SINGLE_FILE}"
  fi

  IMAGE_FILES=("${SINGLE_FILE}")
}

collect_images_from_list_file() {
  local line trimmed list_dir candidate

  [[ -f "${LIST_FILE}" ]] || die "list file does not exist: ${LIST_FILE}"
  list_dir="$(cd "$(dirname "${LIST_FILE}")" && pwd)"
  IMAGE_FILES=()

  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    trimmed="$(printf '%s' "${line}" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"

    [[ -z "${trimmed}" ]] && continue
    [[ "${trimmed}" == \#* ]] && continue

    if [[ "${trimmed}" == /* ]]; then
      candidate="${trimmed}"
    else
      candidate="${list_dir}/${trimmed}"
    fi

    if [[ ! -f "${candidate}" ]]; then
      warn "skipping missing file from list: ${candidate}"
      continue
    fi

    if ! is_supported_image_file "${candidate}"; then
      warn "skipping unsupported file from list: ${candidate}"
      continue
    fi

    IMAGE_FILES+=("${candidate}")
  done < "${LIST_FILE}"

  if [[ "${#IMAGE_FILES[@]}" -eq 0 ]]; then
    die "no supported image files found in list: ${LIST_FILE}"
  fi
}

append_text() {
  local existing="$1"
  local addition="$2"
  local existing_clean
  local addition_clean

  existing_clean="$(printf '%s' "${existing}" | sed -E 's/[[:space:]]+$//')"
  addition_clean="$(printf '%s' "${addition}" | sed -E 's/^[[:space:]]+//')"

  if [[ -z "${existing_clean}" ]]; then
    printf '%s' "${addition_clean}"
    return
  fi

  printf '%s %s' "${existing_clean}" "${addition_clean}"
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
  local current_user updated_iptc updated_user

  current_user="$(read_tag "EXIF:UserComment" "${file}")"

  updated_iptc="${description}"
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

    log "  replaced IPTC description and appended EXIF comment"
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
    -f|--file)
      [[ $# -lt 2 ]] && die "missing value for $1"
      SINGLE_FILE="$2"
      shift 2
      ;;
    -l|--list)
      [[ $# -lt 2 ]] && die "missing value for $1"
      LIST_FILE="$2"
      shift 2
      ;;
    -m|--model)
      [[ $# -lt 2 ]] && die "missing value for $1"
      MODEL="$2"
      shift 2
      ;;
    -p|--prompt-id)
      [[ $# -lt 2 ]] && die "missing value for $1"
      SELECTED_PROMPT_ID="$2"
      shift 2
      ;;
    --list-prompts)
      LIST_PROMPTS_ONLY=1
      shift
      ;;
    --prompt-file)
      [[ $# -lt 2 ]] && die "missing value for $1"
      PROMPT_FILE="$2"
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

if [[ -n "${SELECTED_PROMPT_ID}" && ! "${SELECTED_PROMPT_ID}" =~ ^[0-9]+$ ]]; then
  die "prompt ID must be a non-negative integer: ${SELECTED_PROMPT_ID}"
fi

configure_prompt

check_requirements

if [[ -n "${SINGLE_FILE}" && -n "${LIST_FILE}" ]]; then
  die "--file and --list cannot be used together"
fi

if [[ -n "${SINGLE_FILE}" || -n "${LIST_FILE}" ]]; then
  [[ "${SOURCE_DIR}" == "." ]] || die "DIRECTORY argument cannot be used with --file or --list"
fi

if [[ -n "${SINGLE_FILE}" ]]; then
  if [[ "${RECURSIVE}" -eq 1 ]]; then
    warn "--recursive is ignored when --file is used"
  fi
  log "Using single image file: ${SINGLE_FILE}"
  collect_images_from_single_file
elif [[ -n "${LIST_FILE}" ]]; then
  if [[ "${RECURSIVE}" -eq 1 ]]; then
    warn "--recursive is ignored when --list is used"
  fi
  log "Reading image list from: ${LIST_FILE}"
  collect_images_from_list_file
else
  [[ -d "${SOURCE_DIR}" ]] || die "source directory does not exist: ${SOURCE_DIR}"
  log "Scanning for image files in: ${SOURCE_DIR}"
  collect_images_from_directory
fi

log "Found ${#IMAGE_FILES[@]} image(s)"
log "Model: ${MODEL}"

process_images

log "Done."
