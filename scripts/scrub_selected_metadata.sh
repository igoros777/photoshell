#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
TARGET_DIR="."
TARGET_DIR_SET=0
DRY_RUN=0
FULL_RECURSION=0
RECURSION_LEVEL=0

declare -a FILES=()

usage() {
  cat <<EOF
Usage:
  ${SCRIPT_NAME} [options] [DIRECTORY]

Scrubs these metadata fields:
  - EXIF UserComment
  - EXIF ImageDescription
  - IPTC Caption (Caption-Abstract)
  - IPTC Keywords

Options:
  -n, --dry-run          Print what would be changed without writing
  -r, --recursive [N]    Recursion control:
                         -r 0     no recursion (default)
                         -r N     recurse N levels deep
                         -r       full recursion
  -h, --help             Show this help

Examples:
  ${SCRIPT_NAME}
  ${SCRIPT_NAME} -n
  ${SCRIPT_NAME} -r 0 /photos
  ${SCRIPT_NAME} -r 2 /photos
  ${SCRIPT_NAME} -r /photos
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--dry-run)
      DRY_RUN=1
      shift
      ;;
    -r|--recursive)
      if [[ $# -gt 1 && "$2" =~ ^[0-9]+$ ]]; then
        FULL_RECURSION=0
        RECURSION_LEVEL="$2"
        shift 2
      else
        FULL_RECURSION=1
        shift
      fi
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      die "Unknown option: $1"
      ;;
    *)
      if [[ "${TARGET_DIR_SET}" -eq 1 ]]; then
        die "Unexpected extra argument: $1"
      fi
      TARGET_DIR="$1"
      TARGET_DIR_SET=1
      shift
      ;;
  esac
done

if [[ $# -gt 0 ]]; then
  if [[ "${TARGET_DIR_SET}" -eq 1 ]]; then
    die "Unexpected extra argument(s): $*"
  fi
  TARGET_DIR="$1"
  TARGET_DIR_SET=1
  shift
fi

if [[ $# -gt 0 ]]; then
  die "Unexpected extra argument(s): $*"
fi

if ! command -v exiftool >/dev/null 2>&1; then
  die "exiftool not found. Install it and try again."
fi

if [[ ! -d "${TARGET_DIR}" ]]; then
  die "Directory does not exist: ${TARGET_DIR}"
fi

TARGET_DIR="$(cd "${TARGET_DIR}" && pwd)"

build_find_args() {
  declare -a args
  args=("${TARGET_DIR}")

  if [[ "${FULL_RECURSION}" -eq 0 ]]; then
    local max_depth
    max_depth=$((RECURSION_LEVEL + 1))
    args+=( -maxdepth "${max_depth}" )
  fi

  args+=(
    -type f
    \(
      -iname "*.jpg" -o -iname "*.jpeg" -o
      -iname "*.tif" -o -iname "*.tiff" -o
      -iname "*.png" -o -iname "*.heic" -o -iname "*.heif" -o
      -iname "*.cr2" -o -iname "*.cr3" -o -iname "*.arw" -o
      -iname "*.dng" -o -iname "*.nef" -o -iname "*.raf" -o
      -iname "*.orf" -o -iname "*.rw2"
    \)
    -print0
  )

  printf '%s\0' "${args[@]}"
}

readarray -d '' -t FIND_ARGS < <(build_find_args)
while IFS= read -r -d '' file; do
  FILES+=("${file}")
done < <(find "${FIND_ARGS[@]}")

if [[ "${#FILES[@]}" -eq 0 ]]; then
  echo "No matching image files found in: ${TARGET_DIR}"
  exit 0
fi

declare -a TAG_ARGS
TAG_ARGS=(
  -overwrite_original
  "-EXIF:UserComment="
  "-EXIF:ImageDescription="
  "-IPTC:Caption="
  "-IPTC:Caption-Abstract="
  "-IPTC:Keywords="
)

if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "[DRY-RUN] Files to scrub: ${#FILES[@]}"
  for file in "${FILES[@]}"; do
    echo "[DRY-RUN] ${file}"
  done
  exit 0
fi

echo "Scrubbing metadata from ${#FILES[@]} file(s)..."
for file in "${FILES[@]}"; do
  exiftool -q -q "${TAG_ARGS[@]}" "${file}"
  echo "Scrubbed: ${file}"
done

echo "Done."
