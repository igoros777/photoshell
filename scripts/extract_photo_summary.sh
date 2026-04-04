#!/usr/bin/env bash
#                                      |
#                                  ___/"\___
#                          __________/ o \__________
#                            (I) (G) \___/ (O) (R)
#                                   Igor Os
#                              igor@igoros.com
#                                 2026-02-04
# ----------------------------------------------------------------------------
# Extract photo EXIF metadata, rewrite it consicely, and save as a comment
# ----------------------------------------------------------------------------
# Change Log:
# ****************************************************************************
# 2026-02-04	igor@igoros.com	Wrote this script
# 2026-02-05	igor@igoros.com	Added geocoding functionality
# 2026-02-06	igor@igoros.com	Added comment writing functionality
# ****************************************************************************
OVERRIDE_LOCATION=""

while [[ $# -gt 0 ]]; do
  case "${1}" in
    --location)
      OVERRIDE_LOCATION="${2:-}"
      shift 2
      ;;
    -h|--help)
      echo "Usage: ${0} [--location \"City, State\"] <image-file>"
      echo ""
      echo "Options:"
      echo "  --location <name>  Override reverse-geocoded location for photos"
      echo "                     missing GPS coordinates"
      exit 0
      ;;
    *)
      break
      ;;
  esac
done

input_file="${1:-}"
if [ -z "${input_file}" ] || [ ! -f "${input_file}" ]
then
  echo "Usage: ${0} [--location \"City, State\"] <image-file>"
  exit 1
fi

# ----------------------------------------------------------------------------
# FUNCTIONS
# ----------------------------------------------------------------------------
configure() {
  # Geocod.io API key
  v='v1.7'
  apibase="https://api.geocod.io/${v}"
  api_key="${GEOCODIO_API_KEY:-Get your API key from https://www.geocod.io}"
}

convert_function() {
  coordinates="$(exiftool -q -m -n -p '$GPSLatitude,$GPSLongitude' "${input_file}" 2>/dev/null)"

  # If GPS is missing and user provided --location, use that directly
  if [ -z "${coordinates}" ] || [ "${coordinates}" = "," ] ; then
    if [ -n "${OVERRIDE_LOCATION}" ]; then
      location="${OVERRIDE_LOCATION}"
      return
    fi
  fi

  # Skip API call if api_key was cleared (placeholder detected)
  if [ -z "${api_key}" ]; then
    if [ -n "${OVERRIDE_LOCATION}" ]; then
      location="${OVERRIDE_LOCATION}"
    else
      location="Mystery Town, USA"
    fi
    return
  fi

  location="$(curl -s0 -q -k "${apibase}/reverse?q=${coordinates}&api_key=${api_key}&limit=1" | \
    jq -r '.results[]|"\(.formatted_address)"' 2>/dev/null)"
  if [ -z "${location}" ]
  then
    lat="$(echo "${coordinates}" | awk -F, '{print $1}' | sed 's/[0-9]$//')"
    lon="$(echo "${coordinates}" | awk -F, '{print $2}' | sed 's/[0-9]$//')"
    coordinates="${lat},${lon}"
    location="$(curl -s0 -q -k "${apibase}/reverse?q=${coordinates}&api_key=${api_key}&limit=1" | \
    jq -r '.results[]|"\(.formatted_address)"' 2>/dev/null)"
  fi
  if [ -z "${location}" ]
  then
    if [ -n "${OVERRIDE_LOCATION}" ]; then
      location="${OVERRIDE_LOCATION}"
    else
      location="Mystery Town, USA"
    fi
  fi
}
export -f convert_function

extract_metadata() {
  local file="${input_file}"
  local make model lens iso aperture shutter focal wb meter flash exp_comp
  local width height resolution file_size color_space orientation dt offset
  local gps_lat gps_lon gps_alt gps location_out
  local dt_human

  human_time() {
    local raw="${1}"
    local normalized date_str dow hour phrase time_of_day timing

    if [ -z "${raw}" ] || [ "${raw}" = "N/A" ]; then
      echo "N/A"
      return
    fi

    normalized="${raw}"
    if echo "${normalized}" | grep -qE '^[0-9]{4}:[0-9]{2}:[0-9]{2}'; then
      normalized="$(echo "${normalized}" | sed 's/^\([0-9]\{4\}\):\([0-9]\{2\}\):\([0-9]\{2\}\)/\1-\2-\3/')"
    fi

    date_str="$(date -d "${normalized}" '+%b %e, %Y' 2>/dev/null | sed 's/  / /g')"
    dow="$(date -d "${normalized}" '+%a' 2>/dev/null)"
    hour="$(date -d "${normalized}" '+%H' 2>/dev/null)"

    if [ -z "${date_str}" ] || [ -z "${dow}" ] || [ -z "${hour}" ]; then
      echo "${raw}"
      return
    fi

    case "${hour}" in
      00|01|02|03|04) timing="late"; time_of_day="night" ;;
      05|06|07)       timing="early"; time_of_day="morning" ;;
      08|09|10)       timing=""; time_of_day="morning" ;;
      11|12)          timing="late"; time_of_day="morning" ;;
      13|14|15)       timing="early"; time_of_day="afternoon" ;;
      16|17)          timing="late"; time_of_day="afternoon" ;;
      18|19)          timing="early"; time_of_day="evening" ;;
      20|21)          timing="late"; time_of_day="evening" ;;
      22|23)          timing=""; time_of_day="night" ;;
      *)              timing=""; time_of_day="day" ;;
    esac

    if [ -n "${timing}" ]; then
      phrase="${timing} ${dow} ${time_of_day}"
    else
      phrase="${dow} ${time_of_day}"
    fi

    echo "${date_str}, ${phrase}"
  }

  # Batch exiftool: read all needed tags in one call to avoid repeated process spawns
  local _exif_data
  _exif_data="$(exiftool -T -n \
    -Make -Model \
    -LensModel -Lens -LensID \
    -ISO \
    -FNumber -ApertureValue \
    -ExposureTime -ShutterSpeed \
    -FocalLength -FocalLengthIn35mmFormat \
    -WhiteBalance -WhiteBalanceMode \
    -MeteringMode -Flash -ExposureCompensation \
    -ImageWidth -ImageHeight -ImageSize -FileSize \
    -ColorSpace -ProfileDescription -ICCProfileName \
    -Orientation \
    -DateTimeOriginal -CreateDate -FileModifyDate -OffsetTimeOriginal \
    -GPSLatitude -GPSLongitude -GPSAltitude \
    "${file}" 2>/dev/null)" || true

  local _t_make _t_model \
    _t_lensmodel _t_lens _t_lensid \
    _t_iso \
    _t_fnumber _t_apertureval \
    _t_exptime _t_shutterspd \
    _t_focal _t_focal35 \
    _t_wb _t_wbmode \
    _t_meter _t_flash _t_expcomp \
    _t_width _t_height _t_imgsize _t_filesize \
    _t_colorspace _t_profiledesc _t_iccname \
    _t_orientation \
    _t_dto _t_createdate _t_filemoddate _t_offsettime \
    _t_gpslat _t_gpslon _t_gpsalt

  IFS=$'\t' read -r \
    _t_make _t_model \
    _t_lensmodel _t_lens _t_lensid \
    _t_iso \
    _t_fnumber _t_apertureval \
    _t_exptime _t_shutterspd \
    _t_focal _t_focal35 \
    _t_wb _t_wbmode \
    _t_meter _t_flash _t_expcomp \
    _t_width _t_height _t_imgsize _t_filesize \
    _t_colorspace _t_profiledesc _t_iccname \
    _t_orientation \
    _t_dto _t_createdate _t_filemoddate _t_offsettime \
    _t_gpslat _t_gpslon _t_gpsalt \
    <<< "${_exif_data}"

  # Helper: convert exiftool "-" (missing) to empty string
  _clean() { [[ "$1" == "-" ]] && echo "" || echo "$1"; }

  make="$(_clean "${_t_make}")"
  [ -z "${make}" ] && make="N/A"

  model="$(_clean "${_t_model}")"
  [ -z "${model}" ] && model="N/A"

  lens="$(_clean "${_t_lensmodel}")"
  [ -z "${lens}" ] && lens="$(_clean "${_t_lens}")"
  [ -z "${lens}" ] && lens="$(_clean "${_t_lensid}")"
  [ -z "${lens}" ] && lens="N/A"

  iso="$(_clean "${_t_iso}")"
  [ -z "${iso}" ] && iso="N/A"

  aperture="$(_clean "${_t_fnumber}")"
  [ -z "${aperture}" ] && aperture="$(_clean "${_t_apertureval}")"
  if [ -n "${aperture}" ]; then
    case "${aperture}" in
      f/*) : ;;
      *) aperture="f/${aperture}" ;;
    esac
  else
    aperture="N/A"
  fi

  shutter="$(_clean "${_t_exptime}")"
  [ -z "${shutter}" ] && shutter="$(_clean "${_t_shutterspd}")"
  [ -z "${shutter}" ] && shutter="N/A"

  focal="$(_clean "${_t_focal}")"
  [ -z "${focal}" ] && focal="$(_clean "${_t_focal35}")"
  [ -z "${focal}" ] && focal="N/A"

  wb="$(_clean "${_t_wb}")"
  [ -z "${wb}" ] && wb="$(_clean "${_t_wbmode}")"
  [ -z "${wb}" ] && wb="N/A"

  meter="$(_clean "${_t_meter}")"
  [ -z "${meter}" ] && meter="N/A"

  flash="$(_clean "${_t_flash}")"
  [ -z "${flash}" ] && flash="N/A"

  exp_comp="$(_clean "${_t_expcomp}")"
  if [ -n "${exp_comp}" ]; then
    case "${exp_comp}" in
      *EV*) : ;;
      *) exp_comp="${exp_comp} EV" ;;
    esac
  else
    exp_comp="N/A"
  fi

  width="$(_clean "${_t_width}")"
  height="$(_clean "${_t_height}")"
  if [ -n "${width}" ] && [ -n "${height}" ]; then
    resolution="${width}x${height}"
  else
    resolution="$(_clean "${_t_imgsize}")"
  fi
  [ -z "${resolution}" ] && resolution="N/A"

  file_size="$(_clean "${_t_filesize}")"
  [ -z "${file_size}" ] && file_size="N/A"

  color_space="$(_clean "${_t_colorspace}")"
  [ -z "${color_space}" ] && color_space="$(_clean "${_t_profiledesc}")"
  [ -z "${color_space}" ] && color_space="$(_clean "${_t_iccname}")"
  [ -z "${color_space}" ] && color_space="N/A"

  orientation="$(_clean "${_t_orientation}")"
  [ -z "${orientation}" ] && orientation="N/A"

  dt="$(_clean "${_t_dto}")"
  [ -z "${dt}" ] && dt="$(_clean "${_t_createdate}")"
  [ -z "${dt}" ] && dt="$(_clean "${_t_filemoddate}")"
  offset="$(_clean "${_t_offsettime}")"
  if [ -n "${offset}" ] && ! echo "${dt}" | grep -qE "[+-][0-9]{2}:?[0-9]{2}"; then
    dt="${dt} ${offset}"
  fi
  [ -z "${dt}" ] && dt="N/A"
  dt_human="$(human_time "${dt}")"

  gps_lat="$(_clean "${_t_gpslat}")"
  gps_lon="$(_clean "${_t_gpslon}")"
  gps_alt="$(_clean "${_t_gpsalt}")"
  if [ -n "${gps_alt}" ]; then
    gps_alt="${gps_alt} m"
  else
    gps_alt="N/A"
  fi
  if [ -n "${gps_lat}" ] && [ -n "${gps_lon}" ]; then
    gps="${gps_lat}, ${gps_lon}, ${gps_alt}"
  else
    gps="N/A"
  fi
  convert_function 
  location_out="${location:-Unknown Location}"

  photo_summary="$(printf '%s | %s | ISO: %s | %s | %s | %s | WB: %s | Metering: %s | Flash: %s | ExpComp: %s | %s | %s | %s' \
    "${model}" "${lens}" "${iso}" "${aperture}" "${shutter}" "${focal}" "${wb}" "${meter}" "${flash}" "${exp_comp}" "${resolution}" "${dt_human}" "${location_out}")"
  echo "${photo_summary}"
}
export -f extract_metadata

write_comment() {
  local file="${input_file}"
  local comment="${photo_summary}"
  if [ -z "${comment}" ]; then
    echo "Error: no summary to write" >&2
    return 1
  fi
  # Write the technical summary to EXIF fields only.
  # IPTC:Caption-Abstract is reserved for the AI-generated description
  # (written by annotate_photos_with_ollama.sh).
  if exiftool -overwrite_original \
    -EXIF:ImageDescription="${comment}" \
    -EXIF:UserComment="${comment}" \
    "${file}" >/dev/null 2>&1; then
    echo "Summary written to ${file}"
  else
    # Fallback: some JPEGs (e.g. Nikon Z exports) have multi-segment EXIF
    # with external pointers that exiftool cannot modify.  Write via XMP.
    echo "NOTE: EXIF write failed (multi-segment EXIF?), falling back to XMP: ${file}" >&2
    if exiftool -m -overwrite_original \
      -XMP:Description="${comment}" \
      -XMP:UserComment="${comment}" \
      "${file}" >/dev/null 2>&1; then
      echo "Summary written to ${file} (XMP only)"
    else
      echo "Error: failed to write summary to ${file}" >&2
      return 1
    fi
  fi
}
export -f write_comment

# ----------------------------------------------------------------------------
# RUNTIME
# \(^_^)/                                      __|__
#                                     __|__ *---o0o---*
#                            __|__ *---o0o---*
#                         *---o0o---*
# ----------------------------------------------------------------------------
configure

# Early detection of placeholder API key to avoid confusing API errors
if [[ "${GEOCODIO_API_KEY:-}" == *"Get your"* ]] || [[ "${GEOCODIO_API_KEY:-}" == *"geocod.io"* ]]; then
    echo "NOTE: GEOCODIO_API_KEY appears to be the default placeholder."
    echo "      Reverse geocoding will be skipped."
    echo "      To enable: export GEOCODIO_API_KEY='your-key-here'"
    echo "      Get a free key at: https://www.geocod.io/"
    GEOCODIO_API_KEY=""
    api_key=""
fi

extract_metadata
write_comment
