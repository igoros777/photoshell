#!/usr/bin/env bash
#
#                                      |
#                                  ___/"\___
#                          __________/ o \__________
#                            (I) (G) \___/ (O) (R)
#                                Igor Oseledko
#                           igor@comradegeneral.com
#                                 2026-02-17
# ----------------------------------------------------------------------------
set -euo pipefail

EXIF_FIELDS=(
  FileName
  Make
  Model
  XResolution
  YResolution
  ResolutionUnit
  Software
  ModifyDate
  Artist
  Copyright
  Lens
  LensInfo
  LensMake
  LensModel
  LensSerialNumber
  DateTimeOriginal
  CreateDate
  OffsetTime
  OffsetTimeOriginal
  OffsetTimeDigitized
  ISO
  ISOSpeedRatings
  RecommendedExposureIndex
  FNumber
  ExposureTime
  ExposureProgram
  ShutterSpeed
  ExposureBiasValue
  ExposureCompensation
  FocalLength
  UserComment
  SubSecTime
  SubSecTimeOriginal
  SubSecTimeDigitized
  ExifVersion
  ComponentsConfiguration
  FlashpixVersion
  LightSource
  ColorSpace
  SensingMethod
  FileSource
  SceneType
  CustomRendered
  ExposureMode
  FocalLengthIn35mmFormat
  WhiteBalance
  MeteringMode
  Flash
  SceneCaptureType
  GainControl
  Contrast
  Saturation
  Sharpness
  SubjectDistanceRange
  SerialNumber
  GPSVersionID
  GPSLatitude
  GPSLongitude
  GPSAltitude
  ImageWidth
  ImageHeight
  FileType
  MIMEType
)

IPTC_FIELDS=(
  ObjectName
  Headline
  Caption-Abstract
  Keywords
  By-line
  By-lineTitle
  Credit
  Source
  City
  Province-State
  Country-PrimaryLocationName
  DateCreated
  TimeCreated
  CopyrightNotice
)

IMAGE_EXTS=(jpg jpeg jpe tif tiff png heic heif webp gif bmp)
RAW_EXTS=(dng cr2 cr3 nef arw raf orf rw2 rwl srw pef)
VIDEO_EXTS=(mp4 mov m4v avi mkv mts m2ts 3gp)

QUERY=""
FIELDS_SPEC="all"
MEDIA_TYPES_SPEC="all"
RECURSIVE=1
SEARCH_DIR="."
JOBS_SPEC=""
COPY_TO=""

usage() {
  cat <<'EOF'
Usage:
  ./search_exif_iptc.sh --query <text> [options] [path]

Description:
  Search EXIF and IPTC metadata fields in supported media files.
  Recursive search is enabled by default.

Options:
  -q, --query <text>          Search text (case-insensitive substring match).
  -f, --fields <spec>         Metadata fields to search:
                                all            (default; EXIF + IPTC)
                                exif
                                iptc (or ipct)
                                tag1,tag2,...  (custom exiftool tags)
  -m, --media-types <spec>    Media types/extensions to scan:
                                all            (default)
                                image,raw,video
                                ext1,ext2,...  (custom extensions)
  -n, --no-recursive          Search current directory only.
  -r, --recursive             Search recursively (default).
  -j, --jobs <n>              Number of parallel workers (default: CPU cores).
  -c, --copy-to <dir>         Copy matching files to this directory.
  -h, --help                  Show this help text.

Arguments:
  path                        Directory to search (default: current directory).

Examples:
  ./search_exif_iptc.sh -q "Yosemite"
  ./search_exif_iptc.sh -q "Canon" -f Make,Model -m image .
  ./search_exif_iptc.sh -q "wedding" -f iptc -n /photos/exports
  ./search_exif_iptc.sh -q "Nikon" --copy-to /tmp/metadata-hits /photos
EOF
}

cpu_cores() {
  local n=""
  if command -v getconf >/dev/null 2>&1; then
    n="$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)"
  fi
  if [[ -z "$n" ]] && command -v nproc >/dev/null 2>&1; then
    n="$(nproc 2>/dev/null || true)"
  fi
  if [[ -z "$n" ]] && command -v sysctl >/dev/null 2>&1; then
    n="$(sysctl -n hw.ncpu 2>/dev/null || true)"
  fi
  if [[ -z "$n" || ! "$n" =~ ^[0-9]+$ || "$n" -lt 1 ]]; then
    n=1
  fi
  printf '%s' "$n"
}

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

relative_path_from_search_dir() {
  local file="$1"
  local base="$SEARCH_DIR"
  local rel="$file"

  if [[ "$base" == "." ]]; then
    rel="${rel#./}"
    printf '%s' "$rel"
    return
  fi

  base="${base%/}"
  if [[ "$rel" == "$base/"* ]]; then
    rel="${rel#"$base/"}"
  fi
  printf '%s' "$rel"
}

trim() {
  printf '%s' "$1" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}

split_csv() {
  local raw="$1"
  local -n out_ref="$2"
  local token=""
  out_ref=()
  IFS=',' read -r -a out_ref <<< "$raw"
  for token in "${out_ref[@]}"; do
    token="$(trim "$token")"
    if [[ -n "$token" ]]; then
      printf '%s\0' "$token"
    fi
  done
}

append_unique() {
  local -n arr_ref="$1"
  local value="$2"
  local existing=""
  for existing in "${arr_ref[@]}"; do
    if [[ "$(lower "$existing")" == "$(lower "$value")" ]]; then
      return
    fi
  done
  arr_ref+=("$value")
}

normalize_field_tag() {
  local raw="$1"
  local key=""

  raw="$(trim "$raw")"
  raw="${raw#-}"
  [[ -z "$raw" ]] && return 1

  key="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+//g')"

  case "$key" in
    datetime) echo "ModifyDate" ;;
    datetimedigitized) echo "CreateDate" ;;
    isospeedratings|isoratings) echo "ISO" ;;
    recommendedexposureindex) echo "RecommendedExposureIndex" ;;
    whitebalance) echo "WhiteBalance" ;;
    focallengthin35mmfilm|focallengthin35mmformat) echo "FocalLengthIn35mmFormat" ;;
    usercomment) echo "UserComment" ;;
    lensinfo) echo "LensInfo" ;;
    serialnumber) echo "SerialNumber" ;;
    lensserialnumber) echo "LensSerialNumber" ;;
    lensmake) echo "LensMake" ;;
    lensmodel) echo "LensModel" ;;
    gpsversionid) echo "GPSVersionID" ;;
    byline) echo "By-line" ;;
    bylinetitle) echo "By-lineTitle" ;;
    captionabstract) echo "Caption-Abstract" ;;
    provincestate) echo "Province-State" ;;
    countryprimarylocationname) echo "Country-PrimaryLocationName" ;;
    *)
      raw="${raw// /}"
      raw="${raw//_/}"
      echo "$raw"
      ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -q|--query)
      [[ $# -lt 2 ]] && { echo "Missing value for $1."; usage; exit 1; }
      QUERY="$2"
      shift 2
      ;;
    -f|--fields)
      [[ $# -lt 2 ]] && { echo "Missing value for $1."; usage; exit 1; }
      FIELDS_SPEC="$2"
      shift 2
      ;;
    -m|--media-types)
      [[ $# -lt 2 ]] && { echo "Missing value for $1."; usage; exit 1; }
      MEDIA_TYPES_SPEC="$2"
      shift 2
      ;;
    -n|--no-recursive)
      RECURSIVE=0
      shift
      ;;
    -r|--recursive)
      RECURSIVE=1
      shift
      ;;
    -j|--jobs)
      [[ $# -lt 2 ]] && { echo "Missing value for $1."; usage; exit 1; }
      JOBS_SPEC="$2"
      shift 2
      ;;
    -c|--copy-to)
      [[ $# -lt 2 ]] && { echo "Missing value for $1."; usage; exit 1; }
      COPY_TO="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
    *)
      if [[ "$SEARCH_DIR" != "." ]]; then
        echo "Unexpected extra argument: $1"
        usage
        exit 1
      fi
      SEARCH_DIR="$1"
      shift
      ;;
  esac
done

if [[ -z "$QUERY" ]]; then
  echo "Missing required --query."
  usage
  exit 1
fi

if [[ ! -d "$SEARCH_DIR" ]]; then
  echo "Directory does not exist: $SEARCH_DIR"
  exit 1
fi

if ! command -v exiftool >/dev/null 2>&1; then
  echo "exiftool not found. Install it and try again."
  exit 1
fi

if [[ -n "$COPY_TO" ]]; then
  if [[ -e "$COPY_TO" && ! -d "$COPY_TO" ]]; then
    echo "Copy destination exists and is not a directory: $COPY_TO"
    exit 1
  fi
  mkdir -p "$COPY_TO"
fi

if [[ -z "$JOBS_SPEC" ]]; then
  JOBS_SPEC="$(cpu_cores)"
fi
if [[ ! "$JOBS_SPEC" =~ ^[0-9]+$ || "$JOBS_SPEC" -lt 1 ]]; then
  echo "Invalid --jobs value: $JOBS_SPEC"
  exit 1
fi

declare -a SELECTED_FIELDS=()
declare -a SELECTED_EXTS=()
declare -a CSV_TOKENS=()

fields_key="$(lower "$FIELDS_SPEC")"
case "$fields_key" in
  all)
    SELECTED_FIELDS=("${EXIF_FIELDS[@]}" "${IPTC_FIELDS[@]}")
    ;;
  exif)
    SELECTED_FIELDS=("${EXIF_FIELDS[@]}")
    ;;
  iptc|ipct)
    SELECTED_FIELDS=("${IPTC_FIELDS[@]}")
    ;;
  *)
    while IFS= read -r -d '' token; do
      normalized_tag="$(normalize_field_tag "$token" || true)"
      [[ -n "$normalized_tag" ]] && append_unique SELECTED_FIELDS "$normalized_tag"
    done < <(split_csv "$FIELDS_SPEC" CSV_TOKENS)
    ;;
esac

for i in "${!SELECTED_FIELDS[@]}"; do
  normalized_tag="$(normalize_field_tag "${SELECTED_FIELDS[$i]}" || true)"
  [[ -n "$normalized_tag" ]] && SELECTED_FIELDS[$i]="$normalized_tag"
done

if [[ ${#SELECTED_FIELDS[@]} -eq 0 ]]; then
  echo "No metadata fields selected."
  exit 1
fi

while IFS= read -r -d '' token; do
  token_lower="$(lower "$token")"
  case "$token_lower" in
    all)
      for ext in "${IMAGE_EXTS[@]}"; do append_unique SELECTED_EXTS "$ext"; done
      for ext in "${RAW_EXTS[@]}"; do append_unique SELECTED_EXTS "$ext"; done
      for ext in "${VIDEO_EXTS[@]}"; do append_unique SELECTED_EXTS "$ext"; done
      ;;
    image)
      for ext in "${IMAGE_EXTS[@]}"; do append_unique SELECTED_EXTS "$ext"; done
      ;;
    raw)
      for ext in "${RAW_EXTS[@]}"; do append_unique SELECTED_EXTS "$ext"; done
      ;;
    video)
      for ext in "${VIDEO_EXTS[@]}"; do append_unique SELECTED_EXTS "$ext"; done
      ;;
    *)
      append_unique SELECTED_EXTS "${token_lower#.}"
      ;;
  esac
done < <(split_csv "$MEDIA_TYPES_SPEC" CSV_TOKENS)

if [[ ${#SELECTED_EXTS[@]} -eq 0 ]]; then
  echo "No media types/extensions selected."
  exit 1
fi

declare -a FIND_ARGS=("$SEARCH_DIR")
if [[ $RECURSIVE -eq 0 ]]; then
  FIND_ARGS+=("-maxdepth" "1")
fi
FIND_ARGS+=("-type" "f" "(")
for ((i = 0; i < ${#SELECTED_EXTS[@]}; i++)); do
  if [[ $i -gt 0 ]]; then
    FIND_ARGS+=("-o")
  fi
  FIND_ARGS+=("-iname" "*.${SELECTED_EXTS[$i]}")
done
FIND_ARGS+=(")" "-print0")

declare -a FILES=()
while IFS= read -r -d '' file; do
  FILES+=("$file")
done < <(find "${FIND_ARGS[@]}")

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "No supported media files found in: $SEARCH_DIR"
  exit 0
fi

declare -a TAG_ARGS=()
for tag in "${SELECTED_FIELDS[@]}"; do
  TAG_ARGS+=("-${tag#-}")
done

scanned_files=0
matched_files=0
copied_files=0

TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t search_exif_iptc)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

running_jobs_count() {
  jobs -rp | wc -l
}

wait_for_slot() {
  if wait -n 2>/dev/null; then
    return
  fi
  while [[ "$(running_jobs_count)" -ge "$JOBS_SPEC" ]]; do
    sleep 0.05
  done
}

scanned_files="${#FILES[@]}"
for idx in "${!FILES[@]}"; do
  file="${FILES[$idx]}"
  (
    safe_file="$file"
    if [[ "$safe_file" == -* ]]; then
      safe_file="./$safe_file"
    fi

    metadata="$(exiftool -charset exif=UTF8 -charset iptc=UTF8 -s -G1 -a -u "${TAG_ARGS[@]}" "$safe_file" 2>/dev/null || true)"
    [[ -z "$metadata" ]] && exit 0

    matches="$(printf '%s\n' "$metadata" | grep -iF -- "$QUERY" || true)"
    [[ -z "$matches" ]] && exit 0

    {
      printf 'File: %s\n' "$file"
      printf '%s\n' "$matches"
      printf '\n'
    } >"$TMP_DIR/$idx.out"
    : >"$TMP_DIR/$idx.match"
  ) &

  if [[ "$(running_jobs_count)" -ge "$JOBS_SPEC" ]]; then
    wait_for_slot
  fi
done

wait || true

for idx in "${!FILES[@]}"; do
  if [[ -f "$TMP_DIR/$idx.match" ]]; then
    matched_files=$((matched_files + 1))
    cat "$TMP_DIR/$idx.out"

    if [[ -n "$COPY_TO" ]]; then
      source_file="${FILES[$idx]}"
      rel_path="$(relative_path_from_search_dir "$source_file")"
      destination_file="$COPY_TO/$rel_path"
      mkdir -p "$(dirname "$destination_file")"
      cp -p -- "$source_file" "$destination_file"
      copied_files=$((copied_files + 1))
    fi
  fi
done

printf 'Scanned files: %d\n' "$scanned_files"
printf 'Matched files: %d\n' "$matched_files"
if [[ -n "$COPY_TO" ]]; then
  printf 'Copied files: %d\n' "$copied_files"
  printf 'Copy destination: %s\n' "$COPY_TO"
fi

if [[ $matched_files -eq 0 ]]; then
  exit 1
fi
