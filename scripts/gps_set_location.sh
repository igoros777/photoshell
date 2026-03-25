#!/usr/bin/env bash
#
#                                      |
#                                  ___/"\___
#                          __________/ o \__________
#                            (I) (G) \___/ (O) (R)
#                                   Igor Os
#                              igor@igoros.com
#                                 2026-03-25
# ----------------------------------------------------------------------------
# Set GPS coordinates on photos using forward geocoding via Geocod.io API.
# Supports randomized spread within a radius for natural-looking distribution.
# ----------------------------------------------------------------------------
# Change Log:
# ****************************************************************************
# 2026-03-25	igor@igoros.com	Wrote this script
# ****************************************************************************

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

INPUT_DIR="."
LOCATION=""
SPREAD_RADIUS=0
SPREAD_UNIT="miles"    # miles | km | yards | meters
RECURSIVE=0
FORCE=0
DRY_RUN=0
FILE_TYPES=""          # empty = all image types

# Default image extensions
DEFAULT_TYPES="jpg,jpeg,png,tif,tiff,heic,heif,webp,bmp,gif,dng,nef,cr2,cr3,arw,orf,rw2,srw,raf,pef,x3f"

usage() {
  cat <<EOF
Usage:
  ${SCRIPT_NAME} [options] -l "Location Name" [DIRECTORY]

Purpose:
  Look up GPS coordinates for a named location using the Geocod.io API
  (forward geocoding) and write them to photo EXIF metadata. Optionally
  randomize coordinates within a radius for natural-looking distribution.

Options:
  -l, --location NAME        Location to geocode (required)
                             e.g. "Cape Lookout, NC" or "Longwood Gardens, PA"
  -s, --spread RADIUS        Randomize GPS within this radius of the center
                             (default: 0 = exact center for all files)
  -u, --unit UNIT            Spread unit: miles, km, yards, meters (default: miles)
  -r, --recursive            Include subfolders
  -t, --types EXT,EXT,...    File extensions to process (default: all image types)
  -f, --force                Overwrite existing GPS data (default: skip files with GPS)
  -n, --dry-run              Show what would be done without writing
  -h, --help                 Show this help

Environment:
  GEOCODIO_API_KEY           Required. Get a free key at https://www.geocod.io/

Examples:
  ${SCRIPT_NAME} -l "Cape Lookout, NC" /photos/trip
  ${SCRIPT_NAME} -l "Longwood Gardens, PA" -s 0.25 -u miles /photos
  ${SCRIPT_NAME} -l "Tokyo Tower" -s 500 -u meters -r /photos
  ${SCRIPT_NAME} -l "Central Park, New York" -s 0.5 -u km --force /photos
  ${SCRIPT_NAME} -l "Big Sur, CA" -s 100 -u yards -t jpg,cr3 /photos
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
# Geocoding
# ---------------------------------------------------------------------------

geocode_location() {
  local location="$1"
  local api_key="${GEOCODIO_API_KEY:-}"

  if [[ -z "${api_key}" ]]; then
    die "GEOCODIO_API_KEY environment variable is not set. Get a free key at https://www.geocod.io/"
  fi

  local encoded
  encoded="$(python3 -c "import urllib.parse; print(urllib.parse.quote('${location}'))")"

  local response
  response="$(curl -sf "https://api.geocod.io/v1.7/geocode?q=${encoded}&api_key=${api_key}" 2>/dev/null)" || {
    die "Geocoding API request failed. Check your API key and network connection."
  }

  # Parse lat/lng from response
  local lat lng accuracy
  lat="$(echo "${response}" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r['results'][0]['location']['lat'])" 2>/dev/null)" || {
    die "Could not parse coordinates from Geocodio response. Location may not be found: ${location}"
  }
  lng="$(echo "${response}" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r['results'][0]['location']['lng'])" 2>/dev/null)" || {
    die "Could not parse coordinates from Geocodio response."
  }
  accuracy="$(echo "${response}" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r['results'][0].get('accuracy_type','unknown'))" 2>/dev/null)" || accuracy="unknown"

  echo "${lat} ${lng} ${accuracy}"
}

# ---------------------------------------------------------------------------
# Random spread calculation
# ---------------------------------------------------------------------------

# Convert spread radius to degrees (approximate)
# 1 degree latitude ≈ 111,320 meters
# 1 degree longitude ≈ 111,320 * cos(latitude) meters
radius_to_degrees() {
  local radius="$1"
  local unit="$2"

  # Convert everything to meters first
  local meters
  case "${unit}" in
    miles)   meters="$(awk "BEGIN { printf \"%.6f\", ${radius} * 1609.344 }")" ;;
    km)      meters="$(awk "BEGIN { printf \"%.6f\", ${radius} * 1000.0 }")" ;;
    yards)   meters="$(awk "BEGIN { printf \"%.6f\", ${radius} * 0.9144 }")" ;;
    meters)  meters="${radius}" ;;
    *)       die "Unknown unit: ${unit}. Use miles, km, yards, or meters." ;;
  esac

  # Convert meters to approximate degrees
  awk "BEGIN { printf \"%.8f\", ${meters} / 111320.0 }"
}

# Generate a random point within a circle of given radius (in degrees)
# Uses rejection sampling for uniform distribution within a circle
random_offset() {
  local radius_deg="$1"

  python3 -c "
import random, math
r = float('${radius_deg}')
# Random point in circle using sqrt for uniform distribution
angle = random.uniform(0, 2 * math.pi)
dist = r * math.sqrt(random.random())
dlat = dist * math.cos(angle)
dlng = dist * math.sin(angle)
print(f'{dlat:.8f} {dlng:.8f}')
"
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

  # Build extension filters
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
# GPS writing
# ---------------------------------------------------------------------------

has_gps() {
  local file="$1"
  local lat
  lat="$(exiftool -s3 -n -GPSLatitude "${file}" 2>/dev/null)" || return 1
  [[ -n "${lat}" && "${lat}" != "0" ]]
}

write_gps() {
  local file="$1"
  local lat="$2"
  local lng="$3"

  # Determine N/S and E/W references
  local lat_ref="N"
  local lng_ref="E"
  local abs_lat abs_lng

  abs_lat="$(awk "BEGIN { v=${lat}; if(v<0) v=-v; printf \"%.8f\", v }")"
  abs_lng="$(awk "BEGIN { v=${lng}; if(v<0) v=-v; printf \"%.8f\", v }")"

  if awk "BEGIN { exit (${lat} < 0) ? 0 : 1 }"; then
    lat_ref="S"
  fi
  if awk "BEGIN { exit (${lng} < 0) ? 0 : 1 }"; then
    lng_ref="W"
  fi

  if [[ "${DRY_RUN}" -eq 1 ]]; then
    log "  [plan] Would set GPS: ${lat}, ${lng} (${lat_ref}, ${lng_ref})"
    return 0
  fi

  exiftool -overwrite_original -n \
    "-GPSLatitude=${abs_lat}" \
    "-GPSLongitude=${abs_lng}" \
    "-GPSLatitudeRef=${lat_ref}" \
    "-GPSLongitudeRef=${lng_ref}" \
    "${file}" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    -l|--location)
      [[ $# -lt 2 ]] && die "$1 requires a location name"
      LOCATION="$2"
      shift 2
      ;;
    -s|--spread)
      [[ $# -lt 2 ]] && die "$1 requires a radius value"
      SPREAD_RADIUS="$2"
      shift 2
      ;;
    -u|--unit)
      [[ $# -lt 2 ]] && die "$1 requires a unit (miles, km, yards, meters)"
      SPREAD_UNIT="$2"
      shift 2
      ;;
    -r|--recursive)
      RECURSIVE=1
      shift
      ;;
    -t|--types)
      [[ $# -lt 2 ]] && die "$1 requires comma-separated extensions"
      FILE_TYPES="$2"
      shift 2
      ;;
    -f|--force)
      FORCE=1
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
    -*)
      die "Unknown option: $1"
      ;;
    *)
      if [[ "${INPUT_DIR}" != "." ]]; then
        die "Only one DIRECTORY argument is supported"
      fi
      INPUT_DIR="$1"
      shift
      ;;
  esac
done

# Validate
if [[ -z "${LOCATION}" ]]; then
  die "Location is required. Use -l \"Location Name\""
fi

if [[ ! -d "${INPUT_DIR}" ]]; then
  die "Directory not found: ${INPUT_DIR}"
fi

command -v exiftool >/dev/null 2>&1 || die "exiftool is required"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v python3 >/dev/null 2>&1 || die "python3 is required"

# Geocode the location
log "Geocoding: ${LOCATION}"
read -r CENTER_LAT CENTER_LNG ACCURACY <<< "$(geocode_location "${LOCATION}")"
log "Coordinates: ${CENTER_LAT}, ${CENTER_LNG} (accuracy: ${ACCURACY})"

if [[ "${SPREAD_RADIUS}" != "0" ]]; then
  RADIUS_DEG="$(radius_to_degrees "${SPREAD_RADIUS}" "${SPREAD_UNIT}")"
  log "Spread: ${SPREAD_RADIUS} ${SPREAD_UNIT} (~${RADIUS_DEG} degrees)"
else
  RADIUS_DEG="0"
  log "Spread: none (all files get exact center coordinates)"
fi

if [[ "${DRY_RUN}" -eq 1 ]]; then
  log "Mode: dry run"
fi

if [[ "${FORCE}" -eq 1 ]]; then
  log "Force: overwriting existing GPS data"
else
  log "Skip: files with existing GPS data"
fi

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

# Process files
tagged=0
skipped=0
failed=0

while IFS= read -r file; do
  [[ -z "${file}" ]] && continue
  fname="$(basename "${file}")"

  # Check existing GPS
  if [[ "${FORCE}" -eq 0 ]] && has_gps "${file}"; then
    skipped=$((skipped + 1))
    log "  SKIP  ${fname} (has GPS)"
    continue
  fi

  # Calculate coordinates (with optional spread)
  if [[ "${RADIUS_DEG}" != "0" ]]; then
    read -r DLAT DLNG <<< "$(random_offset "${RADIUS_DEG}")"
    FILE_LAT="$(awk "BEGIN { printf \"%.8f\", ${CENTER_LAT} + ${DLAT} }")"
    FILE_LNG="$(awk "BEGIN { printf \"%.8f\", ${CENTER_LNG} + ${DLNG} }")"
  else
    FILE_LAT="${CENTER_LAT}"
    FILE_LNG="${CENTER_LNG}"
  fi

  # Write GPS
  if write_gps "${file}" "${FILE_LAT}" "${FILE_LNG}"; then
    tagged=$((tagged + 1))
    log "  TAG   ${fname} -> ${FILE_LAT}, ${FILE_LNG}"
  else
    failed=$((failed + 1))
    log "  FAIL  ${fname}"
  fi
done < "${tmpfile}"

log ""
log "Done: ${tagged} tagged, ${skipped} skipped, ${failed} failed"
