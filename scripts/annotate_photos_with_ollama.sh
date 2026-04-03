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
# Generate photo metadata with Ollama using one of three workflows:
#   1) Description workflow: replace EXIF ImageDescription and IPTC Caption-Abstract
#   2) Keywords workflow: populate IPTC Keywords only when currently empty
#   3) Headline workflow: populate IPTC Headline only when currently empty
# ----------------------------------------------------------------------------

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="."
RECURSIVE=0
MODEL="gemma3:27b"
SINGLE_FILE=""
LIST_FILE=""
WORKFLOW="description"
WORKFLOW_EXPLICIT=0
SELECTED_PROMPT_ID=""
LIST_PROMPTS_ONLY=0
PROMPT_FILE_OVERRIDE=""

DESCRIPTION_DEFAULT_PROMPT_TEXT="Provide a concise description about the scene and photographic aspects. Include some details about the photo's location: LOCATION. Do not include any formatting or commentary."
KEYWORDS_DEFAULT_PROMPT_TEXT="Generate 8 to 15 concise, search-friendly keywords for this photo. Focus on subject, scene type, location, lighting, weather, mood, and photographic technique. Incorporate the location naturally: LOCATION. Return keywords only as a comma-separated list. No numbering, quotes, or commentary."
HEADLINE_DEFAULT_PROMPT_TEXT="Write a short, punchy headline (8 words max) for this photo. Capture the essence of the scene in the style of a newspaper photo caption. Location context: LOCATION. Return only the headline text — no quotes, no commentary."
DESCRIPTION_PROMPT_FILE_DEFAULT="${SCRIPT_DIR}/annotate_photos_with_ollama.prompts.txt"
KEYWORDS_PROMPT_FILE_DEFAULT="${SCRIPT_DIR}/annotate_photos_with_ollama.keywords.prompts.txt"
HEADLINE_PROMPT_FILE_DEFAULT="${SCRIPT_DIR}/annotate_photos_with_ollama.headline.prompts.txt"
LOCATION_PLACEHOLDER="LOCATION"
LOCATION_FALLBACK_TEXT="not available"

WORKFLOW_LABEL="description"
DEFAULT_PROMPT_TEXT="${DESCRIPTION_DEFAULT_PROMPT_TEXT}"
PROMPT_TEXT="${DEFAULT_PROMPT_TEXT}"
PROMPT_FILE="${DESCRIPTION_PROMPT_FILE_DEFAULT}"

declare -a IMAGE_FILES=()
declare -a PROMPT_IDS=()
declare -a PROMPT_VALUES=()
declare -a GENERATED_KEYWORDS=()

usage() {
  cat <<EOF
Usage:
  ${SCRIPT_NAME} [options] [DIRECTORY]

Purpose:
  Find image files (directory scan, single file, or list file) and, for each file:
    1) Run one workflow at a time (description or keywords)
    2) Description workflow (default):
       - Generate concise technical description with Ollama
       - Replace EXIF ImageDescription and IPTC Caption-Abstract
       - Leave EXIF UserComment unchanged
    3) Keywords workflow (--keywords):
       - Skip files with populated IPTC Keywords
       - Generate keywords with Ollama
       - Populate IPTC Keywords when empty
    4) Headline workflow (--headline):
       - Skip files with populated IPTC Headline
       - Generate a short headline with Ollama
       - Populate IPTC Headline when empty

Options:
  -r, --recursive            Include subfolders
  -n, --no-recursive         Current folder only (default)
  -f, --file FILE            Process exactly one image file
  -l, --list FILE            Read image paths from a text file (one per line)
  -m, --model NAME           Ollama model (default: ${MODEL})
      --description          Use description workflow (default)
      --keywords             Use keywords workflow
      --headline             Use headline workflow
  -p, --prompt-id ID         Use prompt ID from active workflow prompt file
                             (0 = built-in fallback)
      --list-prompts         List prompts from active workflow prompt file and exit
      --prompt-file FILE     Prompt file path for active workflow
                             (default description: ${DESCRIPTION_PROMPT_FILE_DEFAULT})
                             (default keywords:    ${KEYWORDS_PROMPT_FILE_DEFAULT})
  -h, --help                 Show this help

Prompt file format:
  One prompt per line: <integer>|<prompt text>
  Example: 1|Describe the image...

Examples:
  ${SCRIPT_NAME}
  ${SCRIPT_NAME} -r
  ${SCRIPT_NAME} -r /photos/session42
  ${SCRIPT_NAME} -f /photos/session42/img001.cr3
  ${SCRIPT_NAME} -l /photos/batch_file_list.txt
  ${SCRIPT_NAME} --list-prompts
  ${SCRIPT_NAME} --prompt-id 1 -r /photos/session42
  ${SCRIPT_NAME} --keywords --prompt-id 1 -r /photos/session42
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

set_workflow_from_flag() {
  local requested="$1"
  if [[ "${WORKFLOW_EXPLICIT}" -eq 1 && "${WORKFLOW}" != "${requested}" ]]; then
    die "--description and --keywords cannot be used together"
  fi
  WORKFLOW="${requested}"
  WORKFLOW_EXPLICIT=1
}

select_workflow_settings() {
  case "${WORKFLOW}" in
    description)
      WORKFLOW_LABEL="description"
      DEFAULT_PROMPT_TEXT="${DESCRIPTION_DEFAULT_PROMPT_TEXT}"
      PROMPT_FILE="${DESCRIPTION_PROMPT_FILE_DEFAULT}"
      ;;
    keywords)
      WORKFLOW_LABEL="keywords"
      DEFAULT_PROMPT_TEXT="${KEYWORDS_DEFAULT_PROMPT_TEXT}"
      PROMPT_FILE="${KEYWORDS_PROMPT_FILE_DEFAULT}"
      ;;
    headline)
      WORKFLOW_LABEL="headline"
      DEFAULT_PROMPT_TEXT="${HEADLINE_DEFAULT_PROMPT_TEXT}"
      PROMPT_FILE="${HEADLINE_PROMPT_FILE_DEFAULT}"
      ;;
    *)
      die "unsupported workflow: ${WORKFLOW}"
      ;;
  esac

  if [[ -n "${PROMPT_FILE_OVERRIDE}" ]]; then
    PROMPT_FILE="${PROMPT_FILE_OVERRIDE}"
  fi

  PROMPT_TEXT="${DEFAULT_PROMPT_TEXT}"
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
  log "Prompt file (${WORKFLOW_LABEL} workflow): ${PROMPT_FILE}"
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
      log "Prompt file detected for ${WORKFLOW_LABEL} workflow: ${PROMPT_FILE} (use --list-prompts or --prompt-id ID)"
    fi
    PROMPT_TEXT="${DEFAULT_PROMPT_TEXT}"
    return 0
  fi

  if [[ "${SELECTED_PROMPT_ID}" == "0" ]]; then
    PROMPT_TEXT="${DEFAULT_PROMPT_TEXT}"
    log "Using built-in fallback prompt (ID 0) for ${WORKFLOW_LABEL} workflow"
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

read_exif_user_comment() {
  local file="$1"
  local value

  if ! value="$(exiftool -s3 "-EXIF:UserComment" "${file}" 2>/dev/null)"; then
    return 1
  fi

  value="$(trim_text "${value}")"
  [[ -n "${value}" ]] || return 1
  printf '%s' "${value}"
}

extract_location_from_user_comment() {
  local file="$1"
  local user_comment location_value

  if ! user_comment="$(read_exif_user_comment "${file}")"; then
    return 1
  fi

  location_value="${user_comment##*|}"
  location_value="$(trim_edges "${location_value}")"
  [[ -n "${location_value}" ]] || return 1
  printf '%s' "${location_value}"
}

render_prompt_for_file() {
  local file="$1"
  # Accept optional pre-read user_comment to avoid redundant exiftool calls
  local cached_comment="${2:-}"
  local rendered_prompt location_value user_comment

  rendered_prompt="${PROMPT_TEXT}"
  if [[ "${rendered_prompt}" == *"${LOCATION_PLACEHOLDER}"* || "${WORKFLOW}" == "keywords" ]]; then
    # Use cached UserComment if provided, otherwise read it once
    if [[ -n "${cached_comment}" ]]; then
      user_comment="${cached_comment}"
    else
      user_comment="$(read_exif_user_comment "${file}" 2>/dev/null)" || user_comment=""
    fi

    # Extract location from the cached user comment
    if [[ -n "${user_comment}" ]]; then
      location_value="${user_comment##*|}"
      location_value="$(trim_edges "${location_value}")"
    fi
    [[ -z "${location_value:-}" ]] && location_value="${LOCATION_FALLBACK_TEXT}"

    if [[ "${rendered_prompt}" == *"${LOCATION_PLACEHOLDER}"* ]]; then
      rendered_prompt="${rendered_prompt//${LOCATION_PLACEHOLDER}/${location_value}}"
    elif [[ "${WORKFLOW}" == "keywords" ]]; then
      rendered_prompt="${rendered_prompt} Use this location context: ${location_value}."
    fi
  fi

  printf '%s' "${rendered_prompt}"
}

generate_model_output() {
  local file="$1"
  # Accept optional pre-read user_comment to avoid redundant exiftool calls
  local cached_comment="${2:-}"
  local output rendered_prompt

  rendered_prompt="$(render_prompt_for_file "${file}" "${cached_comment}")"

  if ! output="$(ollama run "${MODEL}" "${rendered_prompt}" "${file}" 2>/dev/null)"; then
    return 1
  fi

  output="$(trim_text "${output}")"
  [[ -n "${output}" ]] || return 1
  printf '%s' "${output}"
}

append_description_metadata() {
  local file="$1"
  local description="$2"

  if ! exiftool -overwrite_original \
    "-EXIF:ImageDescription=${description}" \
    "-IPTC:Caption-Abstract=${description}" \
    "${file}" >/dev/null 2>&1; then
    # Fallback for multi-segment EXIF (e.g. Nikon Z exports with large MakerNotes)
    exiftool -m -overwrite_original \
      "-IPTC:Caption-Abstract=${description}" \
      "-XMP:Description=${description}" \
      "${file}" >/dev/null 2>&1 || echo "WARNING: metadata write failed for ${file}" >&2
  fi
}

read_existing_iptc_keywords() {
  local file="$1"
  local value

  if ! value="$(exiftool -s3 -sep ', ' "-IPTC:Keywords" "${file}" 2>/dev/null)"; then
    return 1
  fi

  value="$(trim_text "${value}")"
  printf '%s' "${value}"
}

split_keywords_from_output() {
  local output="$1"
  local token cleaned normalized seen

  GENERATED_KEYWORDS=()
  seen="|"

  while IFS= read -r token || [[ -n "${token}" ]]; do
    cleaned="$(trim_edges "${token}")"
    cleaned="$(printf '%s' "${cleaned}" | sed -E 's/^[-*]+[[:space:]]*//; s/^[0-9]+[.)][[:space:]]*//')"
    cleaned="${cleaned#\"}"
    cleaned="${cleaned%\"}"
    cleaned="$(trim_edges "${cleaned}")"
    [[ -z "${cleaned}" ]] && continue

    normalized="$(printf '%s' "${cleaned}" | tr '[:upper:]' '[:lower:]')"
    if [[ "${seen}" == *"|${normalized}|"* ]]; then
      continue
    fi

    seen="${seen}${normalized}|"
    GENERATED_KEYWORDS+=("${cleaned}")
  done < <(
    printf '%s' "${output}" \
      | tr '\r' '\n' \
      | sed -E 's/[|;]/,/g' \
      | tr ',' '\n'
  )

  [[ "${#GENERATED_KEYWORDS[@]}" -gt 0 ]]
}

append_keywords_metadata() {
  local file="$1"
  shift
  local -a keywords=("$@")
  local -a exif_args=()
  local keyword

  [[ "${#keywords[@]}" -gt 0 ]] || return 1

  exif_args=(-overwrite_original "-IPTC:Keywords=")
  for keyword in "${keywords[@]}"; do
    exif_args+=("-IPTC:Keywords+=${keyword}")
  done
  exif_args+=("${file}")

  if ! exiftool "${exif_args[@]}" >/dev/null 2>&1; then
    # Fallback with -m for multi-segment EXIF files
    exif_args[0]="-m"
    exiftool -overwrite_original "${exif_args[@]}" >/dev/null 2>&1 || return 1
  fi
}

process_description_workflow() {
  local file total idx base description cached_comment
  total="${#IMAGE_FILES[@]}"
  idx=0

  for file in "${IMAGE_FILES[@]}"; do
    idx=$((idx + 1))
    base="$(basename "${file}")"
    log "[${idx}/${total}] ${base}"

    # Cache UserComment once per file to avoid redundant exiftool calls
    cached_comment="$(read_exif_user_comment "${file}" 2>/dev/null)" || cached_comment=""

    if ! description="$(generate_model_output "${file}" "${cached_comment}")"; then
      warn "skipping ${file}: failed to get description from ollama"
      continue
    fi

    if ! append_description_metadata "${file}" "${description}"; then
      warn "failed to write metadata for ${file}"
      continue
    fi

    log "  replaced EXIF ImageDescription and IPTC Caption-Abstract"
  done
}

process_keywords_workflow() {
  local file total idx base output existing_keywords cached_comment
  total="${#IMAGE_FILES[@]}"
  idx=0

  for file in "${IMAGE_FILES[@]}"; do
    idx=$((idx + 1))
    base="$(basename "${file}")"
    log "[${idx}/${total}] ${base}"

    if ! existing_keywords="$(read_existing_iptc_keywords "${file}")"; then
      warn "skipping ${file}: failed to read IPTC Keywords"
      continue
    fi

    if [[ -n "${existing_keywords}" ]]; then
      log "  skipped: IPTC Keywords already populated"
      continue
    fi

    # Cache UserComment once per file to avoid redundant exiftool calls
    cached_comment="$(read_exif_user_comment "${file}" 2>/dev/null)" || cached_comment=""

    if ! output="$(generate_model_output "${file}" "${cached_comment}")"; then
      warn "skipping ${file}: failed to get keywords from ollama"
      continue
    fi

    if ! split_keywords_from_output "${output}"; then
      warn "skipping ${file}: ollama returned no valid keywords"
      continue
    fi

    if ! append_keywords_metadata "${file}" "${GENERATED_KEYWORDS[@]}"; then
      warn "failed to write IPTC Keywords for ${file}"
      continue
    fi

    log "  populated IPTC Keywords with ${#GENERATED_KEYWORDS[@]} keyword(s)"
  done
}

read_existing_iptc_headline() {
  local file="$1"
  local value

  if ! value="$(exiftool -s3 "-IPTC:Headline" "${file}" 2>/dev/null)"; then
    return 1
  fi

  value="$(trim_text "${value}")"
  printf '%s' "${value}"
}

append_headline_metadata() {
  local file="$1"
  local headline="$2"

  if ! exiftool -overwrite_original \
    "-IPTC:Headline=${headline}" \
    "${file}" >/dev/null 2>&1; then
    # Fallback for multi-segment EXIF
    exiftool -m -overwrite_original \
      "-IPTC:Headline=${headline}" \
      "-XMP:Headline=${headline}" \
      "${file}" >/dev/null 2>&1 || echo "WARNING: headline write failed for ${file}" >&2
  fi
}

process_headline_workflow() {
  local file total idx base headline existing_headline cached_comment
  total="${#IMAGE_FILES[@]}"
  idx=0

  for file in "${IMAGE_FILES[@]}"; do
    idx=$((idx + 1))
    base="$(basename "${file}")"
    log "[${idx}/${total}] ${base}"

    if ! existing_headline="$(read_existing_iptc_headline "${file}")"; then
      warn "skipping ${file}: failed to read IPTC Headline"
      continue
    fi

    if [[ -n "${existing_headline}" ]]; then
      log "  skipped: IPTC Headline already populated"
      continue
    fi

    # Cache UserComment once per file to avoid redundant exiftool calls
    cached_comment="$(read_exif_user_comment "${file}" 2>/dev/null)" || cached_comment=""

    if ! headline="$(generate_model_output "${file}" "${cached_comment}")"; then
      warn "skipping ${file}: failed to get headline from ollama"
      continue
    fi

    if ! append_headline_metadata "${file}" "${headline}"; then
      warn "failed to write IPTC Headline for ${file}"
      continue
    fi

    log "  populated IPTC Headline"
  done
}

process_images() {
  case "${WORKFLOW}" in
    description)
      process_description_workflow
      ;;
    keywords)
      process_keywords_workflow
      ;;
    headline)
      process_headline_workflow
      ;;
    *)
      die "unsupported workflow: ${WORKFLOW}"
      ;;
  esac
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
    --description)
      set_workflow_from_flag "description"
      shift
      ;;
    --keywords)
      set_workflow_from_flag "keywords"
      shift
      ;;
    --headline)
      set_workflow_from_flag "headline"
      shift
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
      PROMPT_FILE_OVERRIDE="$2"
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

select_workflow_settings

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
log "Workflow: ${WORKFLOW_LABEL}"

process_images

log "Done."
