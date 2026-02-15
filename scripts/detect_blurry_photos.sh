#!/usr/bin/env bash

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

INPUT_DIR="."
ANALYZED_DIR="./analyzed"
SCENES_DIR="./scenes"
SELECTED_DIR="./selected"
TIME_GAP=5
WINDOW="5x5"
MODE="all"
DRY_RUN=0
CLEAN_OUTPUT=0

declare -a IMAGES=()
declare -a SCENE_DIRS=()
declare -A SCENE_IMAGES=()

IM_STYLE=""
IDENTIFY_CMD=()
CONVERT_CMD=()

usage() {
  cat <<EOF
Usage:
  ${SCRIPT_NAME} [options]

Purpose:
  Detect blur level in JPG/JPEG files using ImageMagick StandardDeviation.
  Can also split images into scenes by EXIF time gap and select one sharpest
  image per scene.

Modes:
  analyze   Score all images and copy to analyzed dir as <score>_<filename>
  select    Split into scenes, score each scene, copy best of each to selected
  all       Run analyze + select (default)

Options:
  -i, --input DIR            Input directory (default: .)
  --analyzed-dir DIR         Output dir for scored copies (default: ./analyzed)
  --scenes-dir DIR           Output dir for scenes (default: ./scenes)
  --selected-dir DIR         Output dir for chosen images (default: ./selected)
  -t, --time-gap SECONDS     New scene gap threshold (default: 5)
  -w, --window WxH           Statistic window size (default: 5x5)
  -m, --mode MODE            analyze | select | all (default: all)
  --clean                    Remove output dirs before running
  -n, --dry-run              Print actions without writing files
  -h, --help                 Show this help

Examples:
  ${SCRIPT_NAME} --mode analyze
  ${SCRIPT_NAME} --mode select --time-gap 8
  ${SCRIPT_NAME} --mode all --input "./trip" --clean
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

log() {
  echo "$*"
}

prepare_dir() {
  local dir="$1"

  if [[ -z "${dir}" || "${dir}" == "/" || "${dir}" == "." ]]; then
    die "refusing to clean unsafe output path: ${dir}"
  fi

  if [[ "${CLEAN_OUTPUT}" -eq 1 ]]; then
    if [[ -d "${dir}" ]]; then
      if [[ "${DRY_RUN}" -eq 1 ]]; then
        log "[plan] rm -rf \"${dir}\""
      else
        rm -rf "${dir}"
      fi
    fi
    if [[ "${DRY_RUN}" -eq 1 ]]; then
      log "[plan] mkdir -p \"${dir}\""
      return 0
    fi
  fi

  if [[ -d "${dir}" ]]; then
    if find "${dir}" -mindepth 1 -print -quit | grep -q .; then
      die "output directory is not empty: ${dir} (use --clean to reset it)"
    fi
  else
    if [[ "${DRY_RUN}" -eq 1 ]]; then
      log "[plan] mkdir -p \"${dir}\""
    else
      mkdir -p "${dir}"
    fi
  fi
}

copy_file() {
  local src="$1"
  local dst="$2"
  local dst_dir

  dst_dir="$(dirname "${dst}")"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    log "[plan] cp -p \"${src}\" \"${dst}\""
    return 0
  fi

  mkdir -p "${dst_dir}"
  cp -p "${src}" "${dst}"
}

detect_imagemagick() {
  if command -v magick >/dev/null 2>&1; then
    IM_STYLE="im7"
    IDENTIFY_CMD=(magick identify)
    CONVERT_CMD=(magick)
    return 0
  fi

  if command -v identify >/dev/null 2>&1 && command -v convert >/dev/null 2>&1; then
    IM_STYLE="im6"
    IDENTIFY_CMD=(identify)
    CONVERT_CMD=(convert)
    return 0
  fi

  die "ImageMagick not found. Install IM7 (magick) or IM6 (identify + convert)."
}

list_images() {
  mapfile -d '' -t IMAGES < <(
    find "${INPUT_DIR}" -maxdepth 1 -mindepth 1 -type f \
      \( -iname '*.jpg' -o -iname '*.jpeg' \) -print0 | sort -z
  )

  if [[ "${#IMAGES[@]}" -eq 0 ]]; then
    die "no JPG/JPEG files found in ${INPUT_DIR}"
  fi
}

blur_score() {
  local image="$1"
  local raw

  raw="$("${CONVERT_CMD[@]}" "${image}" -statistic StandardDeviation "${WINDOW}" -format "%[fx:maxima]" info: 2>/dev/null || true)"

  awk -v v="${raw}" '
    BEGIN {
      if (v == "" || v == "nan" || v == "-nan") {
        printf "0000\n";
        exit;
      }
      n = int((v * 10000) + 0.5);
      if (n < 0) n = 0;
      if (n > 9999) n = 9999;
      printf "%04d\n", n;
    }
  '
}

image_epoch() {
  local image="$1"
  local dt
  local normalized
  local epoch

  dt="$("${IDENTIFY_CMD[@]}" -quiet -format '%[EXIF:DateTimeOriginal]' "${image}" 2>/dev/null || true)"
  if [[ -z "${dt}" ]]; then
    dt="$("${IDENTIFY_CMD[@]}" -quiet -format '%[EXIF:DateTime]' "${image}" 2>/dev/null || true)"
  fi

  epoch=""
  if [[ -n "${dt}" ]]; then
    normalized="$(echo "${dt}" | sed -E 's/^([0-9]{4}):([0-9]{2}):([0-9]{2})/\1-\2-\3/')"
    epoch="$(date -d "${normalized}" +%s 2>/dev/null || true)"
  fi

  if [[ -z "${epoch}" ]]; then
    epoch="$(stat -c %Y "${image}" 2>/dev/null || true)"
  fi

  if [[ -z "${epoch}" ]]; then
    epoch=0
  fi

  echo "${epoch}"
}

run_analyze() {
  local image
  local name
  local score

  prepare_dir "${ANALYZED_DIR}"
  log "Scoring ${#IMAGES[@]} image(s) into ${ANALYZED_DIR}"

  for image in "${IMAGES[@]}"; do
    name="$(basename "${image}")"
    score="$(blur_score "${image}")"
    copy_file "${image}" "${ANALYZED_DIR}/${score}_${name}"
    log "  ${score}  ${name}"
  done
}

split_scenes() {
  local map_file
  local sorted_file
  local image
  local epoch
  local prev_epoch=""
  local scene_index=0
  local scene_dir=""
  local line_epoch
  local line_image

  prepare_dir "${SCENES_DIR}"
  map_file="$(mktemp)"
  sorted_file="$(mktemp)"

  for image in "${IMAGES[@]}"; do
    epoch="$(image_epoch "${image}")"
    printf "%s\t%s\n" "${epoch}" "${image}" >> "${map_file}"
  done

  sort -n -k1,1 -k2,2 "${map_file}" > "${sorted_file}"

  while IFS=$'\t' read -r line_epoch line_image; do
    [[ -z "${line_image}" ]] && continue

    if [[ -z "${prev_epoch}" ]]; then
      scene_index=1
      scene_dir="${SCENES_DIR}/scene_$(printf '%010d' "${scene_index}")"
      SCENE_DIRS+=("${scene_dir}")
      if [[ "${DRY_RUN}" -eq 1 ]]; then
        log "[plan] mkdir -p \"${scene_dir}\""
      else
        mkdir -p "${scene_dir}"
      fi
    else
      if (( line_epoch - prev_epoch > TIME_GAP )); then
        ((scene_index += 1))
        scene_dir="${SCENES_DIR}/scene_$(printf '%010d' "${scene_index}")"
        SCENE_DIRS+=("${scene_dir}")
        if [[ "${DRY_RUN}" -eq 1 ]]; then
          log "[plan] mkdir -p \"${scene_dir}\""
        else
          mkdir -p "${scene_dir}"
        fi
      fi
    fi

    SCENE_IMAGES["${scene_dir}"]+=$'\n'"${line_image}"
    copy_file "${line_image}" "${scene_dir}/$(basename "${line_image}")"
    prev_epoch="${line_epoch}"
  done < "${sorted_file}"

  rm -f "${map_file}" "${sorted_file}"
  log "Created ${#SCENE_DIRS[@]} scene(s) in ${SCENES_DIR}"
}

pick_best_per_scene() {
  local scene_dir
  local scene_name
  local scene_analyzed
  local selected_target
  local scene_data
  local scene_images
  local image
  local image_name
  local score
  local best_score=-1
  local best_image=""
  local count

  prepare_dir "${SELECTED_DIR}"

  for scene_dir in "${SCENE_DIRS[@]}"; do
    scene_name="$(basename "${scene_dir}")"
    scene_data="${SCENE_IMAGES[${scene_dir}]-}"
    mapfile -t scene_images < <(printf '%s\n' "${scene_data}" | sed '/^$/d')
    count="${#scene_images[@]}"
    if [[ "${count}" -eq 0 ]]; then
      continue
    fi

    best_score=-1
    best_image=""

    if [[ "${count}" -gt 1 ]]; then
      scene_analyzed="${scene_dir}/analyzed"
      if [[ "${DRY_RUN}" -eq 1 ]]; then
        log "[plan] mkdir -p \"${scene_analyzed}\""
      else
        mkdir -p "${scene_analyzed}"
      fi
    fi

    for image in "${scene_images[@]}"; do
      image_name="$(basename "${image}")"
      score="$(blur_score "${image}")"

      if [[ "${count}" -gt 1 ]]; then
        copy_file "${image}" "${scene_analyzed}/${score}_${image_name}"
      fi

      if (( 10#${score} > best_score )); then
        best_score=$((10#${score}))
        best_image="${image}"
      fi
    done

    selected_target="${SELECTED_DIR}/$(basename "${best_image}")"
    if [[ -e "${selected_target}" ]]; then
      selected_target="${SELECTED_DIR}/${scene_name}__$(basename "${best_image}")"
    fi

    copy_file "${best_image}" "${selected_target}"
    log "Selected ${scene_name}: score ${best_score} -> $(basename "${selected_target}")"
  done
}

run_select() {
  split_scenes
  pick_best_per_scene
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -i|--input)
        [[ $# -lt 2 ]] && die "$1 requires a directory path"
        INPUT_DIR="$2"
        shift 2
        ;;
      --analyzed-dir)
        [[ $# -lt 2 ]] && die "$1 requires a directory path"
        ANALYZED_DIR="$2"
        shift 2
        ;;
      --scenes-dir)
        [[ $# -lt 2 ]] && die "$1 requires a directory path"
        SCENES_DIR="$2"
        shift 2
        ;;
      --selected-dir)
        [[ $# -lt 2 ]] && die "$1 requires a directory path"
        SELECTED_DIR="$2"
        shift 2
        ;;
      -t|--time-gap)
        [[ $# -lt 2 ]] && die "$1 requires seconds"
        TIME_GAP="$2"
        shift 2
        ;;
      -w|--window)
        [[ $# -lt 2 ]] && die "$1 requires a window size (e.g., 5x5)"
        WINDOW="$2"
        shift 2
        ;;
      -m|--mode)
        [[ $# -lt 2 ]] && die "$1 requires a mode (analyze|select|all)"
        MODE="$2"
        shift 2
        ;;
      --clean)
        CLEAN_OUTPUT=1
        shift
        ;;
      -n|--dry-run)
        DRY_RUN=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "unknown option: $1"
        ;;
    esac
  done

  if [[ ! -d "${INPUT_DIR}" ]]; then
    die "input directory not found: ${INPUT_DIR}"
  fi

  if [[ ! "${TIME_GAP}" =~ ^[0-9]+$ ]]; then
    die "time gap must be a non-negative integer"
  fi

  case "${MODE}" in
    analyze|select|all) ;;
    *)
      die "invalid mode: ${MODE} (use analyze|select|all)"
      ;;
  esac
}

main() {
  parse_args "$@"
  detect_imagemagick
  list_images

  log "Mode: ${MODE}"
  log "Input: ${INPUT_DIR}"
  log "Images found: ${#IMAGES[@]}"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    log "Dry run: yes"
  fi
  log

  case "${MODE}" in
    analyze)
      run_analyze
      ;;
    select)
      run_select
      ;;
    all)
      run_analyze
      run_select
      ;;
  esac

  log
  log "Done."
}

main "$@"
