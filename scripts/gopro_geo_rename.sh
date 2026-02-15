#!/usr/bin/env bash
#                                      |
#                                  ___/"\___
#                          __________/ o \__________
#                            (I) (G) \___/ (O) (R)
#                                   Igor Os
#                              igor@igoros.com
#                                 2023-09-04
# ----------------------------------------------------------------------------
# Rename GoPro MP4 clips in the current folder using EXIF/GPS metadata.
# Why this exists:
# GoPro default names (for example GH010135.MP4) are not descriptive and make
# archive/search workflows difficult after offloading many clips.
# This script builds filename context directly from metadata:
# - capture datetime
# - reverse-geocoded address from GPS
# - clip duration in seconds
# - original filename (preserved at the end)
# Requirements: exiftool, curl, jq, geocod.io API key
# ----------------------------------------------------------------------------
# Change Log:
# ****************************************************************************
# 2023-09-04	igor@igoros.com	Wrote this script
# ****************************************************************************
#
# Example:
# 20220706-1128-000-190_s_park_st_lake_city_co_81235-31s-GH010135.MP4.mp4

v='v1.7'
apibase="https://api.geocod.io/${v}"
api_key="${GEOCODIO_API_KEY:-Get your API key from https://www.geocod.io}"

convert_function() {
  echo "Renaming ${1}"
  orig_name="$(basename "${1}")"

  coordinates="$(exiftool -q -m -n -p '$GPSLatitude,$GPSLongitude' "${1}")"

  location="$(curl -s0 -q -k "${apibase}/reverse?q=${coordinates}&api_key=${api_key}&limit=1" | \
    jq -r '.results[]|"\(.formatted_address)"' 2>/dev/null | \
    sed -e 's/\(.*\)/\L\1/' -e 's/[^A-Za-z0-9._-]/_/g' -e 's/__/_/g')"

  if [ -z "${location}" ]
  then
    lat="$(echo "${coordinates}" | awk -F, '{print $1}' | sed 's/[0-9]$//')"
    lon="$(echo "${coordinates}" | awk -F, '{print $2}' | sed 's/[0-9]$//')"
    coordinates="${lat},${lon}"
    location="$(curl -s0 -q -k "${apibase}/reverse?q=${coordinates}&api_key=${api_key}&limit=1" | \
    jq -r '.results[]|"\(.formatted_address)"' 2>/dev/null | \
    sed -e 's/\(.*\)/\L\1/' -e 's/[^A-Za-z0-9._-]/_/g' -e 's/__/_/g')"
  fi

  if [ -z "${location}" ]
  then
    location="mystery_town"
  fi

  dt="$(exiftool -duration "${1}" | grep -oE "([0-9]{1,}:){1,}?([0-9]{1,}){1,}([0-9]{1,}\.[0-9]{1,})?")"
  if [ $(echo ${dt} | grep -c :) -eq 0 ]; then dt="00:00:${dt}"; fi

  duration="$(date -d "1970-01-01 ${dt}Z" +%s)s"
  if [ -z "${duration}" ]; then duration=0s; fi

  exiftool '-filename<${CreateDate}.%le' -d "%Y%m%d-%H%M%%-03.c-${location}-${duration}-${orig_name}" "${1}" 2>/dev/null
}
export -f convert_function

find . -mindepth 1 -maxdepth 1 -type f -name "*\.MP4" | while read -r i; do convert_function "${i}"; done
