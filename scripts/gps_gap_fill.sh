#!/usr/bin/env bash
#
#                                      |
#                                  ___/"\___
#                          __________/ o \__________
#                            (I) (G) \___/ (O) (R)
#                                Igor Oseledko
#                               igor@igoros.com
#                                  2026-02-06
# ----------------------------------------------------------------------------
# Fill missing GPS coordinates using nearest-in-time donor photos.
#
# Workflow:
# 1) Scan the current directory (non-recursive) for supported photo formats.
# 2) Read EXIF metadata with exiftool:
#    - DateTimeOriginal (fallback: CreateDate)
#    - GPSLatitude / GPSLongitude
# 3) Build a donor list from files that have both timestamp and GPS, sorted by
#    capture time.
# 4) For each file missing GPS:
#    - Skip if it has no timestamp.
#    - Find the donor with the smallest absolute time difference.
#    - Apply donor coordinates only if the gap is within MAX_GAP (default 2h).
# 5) Write GPS tags with exiftool (-overwrite_original) or print planned
#    actions in --dry-run mode.
# ----------------------------------------------------------------------------
# Change Log:
# ****************************************************************************
# 2026-02-06	igor@igoros.com	Wrote this script
# ****************************************************************************
set -euo pipefail

# ----------------------------------------------------------------------------
# CONFIGURATION
# ----------------------------------------------------------------------------
configure() {
  MAX_GAP=7200  # seconds (2 hours)
  DRY_RUN=0
  if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN=1
  fi

  PHOTO_EXTS=(
    jpg jpeg
    nef cr2 cr3 arw orf rw2 rwl srw raf dng pef
  )
}

# ----------------------------------------------------------------------------
# FUNCTIONS
# ----------------------------------------------------------------------------
find_photos() {
  local find_expr=()
  for ext in "${PHOTO_EXTS[@]}"; do
    [[ ${#find_expr[@]} -gt 0 ]] && find_expr+=("-o")
    find_expr+=("-iname" "*.${ext}")
  done

  mapfile -d '' -t ALL_FILES < <(
    find . -maxdepth 1 -type f \( "${find_expr[@]}" \) -print0
  )

  if [[ ${#ALL_FILES[@]} -eq 0 ]]; then
    echo "No photo files found in the current directory."
    exit 0
  fi
  echo "Found ${#ALL_FILES[@]} photo file(s)."
}

extract_metadata() {
  local data
  data="$(exiftool -T -n \
    -DateTimeOriginal -CreateDate \
    -GPSLatitude -GPSLongitude \
    "${ALL_FILES[@]}" 2>/dev/null)" || true

  declare -g -a FNAMES=() EPOCHS=() HAS_GPS=() LATS=() LONS=()
  local i=0

  while IFS=$'\t' read -r dto cdate lat lon; do
    FNAMES[i]="${ALL_FILES[i]}"

    # Pick best date: DateTimeOriginal, then CreateDate
    local raw_date="${dto}"
    if [[ "${raw_date}" == "-" || -z "${raw_date}" ]]; then
      raw_date="${cdate}"
    fi

    # Convert EXIF date to epoch
    if [[ "${raw_date}" != "-" && -n "${raw_date}" ]]; then
      # Normalize "2024:03:14 10:30:00" -> "2024-03-14 10:30:00"
      local normalized
      normalized="$(echo "${raw_date}" | sed 's/^\([0-9]\{4\}\):\([0-9]\{2\}\):\([0-9]\{2\}\)/\1-\2-\3/')"
      EPOCHS[i]="$(date -d "${normalized}" +%s 2>/dev/null || echo "")"
    else
      EPOCHS[i]=""
    fi

    # Check GPS presence
    if [[ "${lat}" != "-" && "${lon}" != "-" && -n "${lat}" && -n "${lon}" ]]; then
      HAS_GPS[i]=1
      LATS[i]="${lat}"
      LONS[i]="${lon}"
    else
      HAS_GPS[i]=0
      LATS[i]=""
      LONS[i]=""
    fi

    ((i++)) || true
  done <<< "${data}"

  FILE_COUNT=${i}
}

print_report() {
  local gps_count=0 no_gps_count=0 no_date_count=0

  printf "\n%-40s  %-20s  %-6s  %s\n" "FILE" "DATE" "GPS?" "COORDINATES"
  printf "%-40s  %-20s  %-6s  %s\n" "$(printf '%0.s-' {1..40})" "$(printf '%0.s-' {1..20})" "------" "$(printf '%0.s-' {1..24})"

  for ((j=0; j<FILE_COUNT; j++)); do
    local display_date display_gps display_coords
    if [[ -n "${EPOCHS[j]}" ]]; then
      display_date="$(date -d "@${EPOCHS[j]}" '+%Y-%m-%d %H:%M:%S' 2>/dev/null)"
    else
      display_date="(no date)"
      ((no_date_count++)) || true
    fi

    if [[ "${HAS_GPS[j]}" -eq 1 ]]; then
      display_gps="YES"
      display_coords="${LATS[j]}, ${LONS[j]}"
      ((gps_count++)) || true
    else
      display_gps="NO"
      display_coords=""
      ((no_gps_count++)) || true
    fi

    printf "%-40s  %-20s  %-6s  %s\n" \
      "$(basename "${FNAMES[j]}")" "${display_date}" "${display_gps}" "${display_coords}"
  done

  printf "\nSummary: %d with GPS, %d without GPS, %d without date\n" \
    "${gps_count}" "${no_gps_count}" "${no_date_count}"
}

build_donor_list() {
  # Collect GPS files with valid epochs, sorted by time
  declare -g -a DONOR_EPOCHS=() DONOR_LATS=() DONOR_LONS=() DONOR_NAMES=()

  local sorted
  sorted="$(
    for ((j=0; j<FILE_COUNT; j++)); do
      if [[ "${HAS_GPS[j]}" -eq 1 && -n "${EPOCHS[j]}" ]]; then
        printf '%s\t%s\t%s\t%s\n' "${EPOCHS[j]}" "${LATS[j]}" "${LONS[j]}" "${FNAMES[j]}"
      fi
    done | sort -n -t$'\t' -k1
  )"

  if [[ -z "${sorted}" ]]; then
    echo -e "\nNo files with both GPS and date found. Nothing to donate."
    return 1
  fi

  local d=0
  while IFS=$'\t' read -r ep la lo fn; do
    DONOR_EPOCHS[d]="${ep}"
    DONOR_LATS[d]="${la}"
    DONOR_LONS[d]="${lo}"
    DONOR_NAMES[d]="${fn}"
    ((d++)) || true
  done <<< "${sorted}"

  DONOR_COUNT=${d}
  echo -e "\nGPS donors available: ${DONOR_COUNT}"
}

fill_missing_gps() {
  local tagged=0 skipped=0

  [[ ${DRY_RUN} -eq 1 ]] && echo -e "\n[DRY-RUN mode — no files will be modified]\n"
  [[ ${DRY_RUN} -eq 0 ]] && echo ""

  for ((j=0; j<FILE_COUNT; j++)); do
    # Skip files that already have GPS
    [[ "${HAS_GPS[j]}" -eq 1 ]] && continue
    # Skip files without a date (can't compare time)
    if [[ -z "${EPOCHS[j]}" ]]; then
      echo "SKIP $(basename "${FNAMES[j]}"): no date metadata, cannot match"
      ((skipped++)) || true
      continue
    fi

    local target_epoch="${EPOCHS[j]}"
    local best_diff=999999999
    local best_k=-1

    # Linear scan for nearest donor (donors are sorted by time)
    # Early termination: once time difference starts increasing, we've passed the nearest point
    for ((k=0; k<DONOR_COUNT; k++)); do
      local diff=$(( target_epoch - DONOR_EPOCHS[k] ))
      [[ ${diff} -lt 0 ]] && diff=$(( -diff ))
      if [[ ${diff} -lt ${best_diff} ]]; then
        best_diff=${diff}
        best_k=${k}
      elif [[ ${best_k} -ge 0 && ${DONOR_EPOCHS[k]} -gt ${target_epoch} ]]; then
        # Donors are sorted by time; once we pass the target and diff is increasing, stop
        break
      fi
    done

    if [[ ${best_k} -ge 0 && ${best_diff} -le ${MAX_GAP} ]]; then
      local donor_lat="${DONOR_LATS[best_k]}"
      local donor_lon="${DONOR_LONS[best_k]}"
      local donor_name
      donor_name="$(basename "${DONOR_NAMES[best_k]}")"

      # Format time gap
      local gap_min=$(( best_diff / 60 ))
      local gap_sec=$(( best_diff % 60 ))

      echo "TAG  $(basename "${FNAMES[j]}") <- ${donor_name} (${gap_min}m ${gap_sec}s apart) [${donor_lat}, ${donor_lon}]"

      if [[ ${DRY_RUN} -eq 0 ]]; then
        # Determine ref tags from sign
        local lat_ref="N" lon_ref="E"
        if echo "${donor_lat}" | grep -q '^-'; then
          lat_ref="S"
        fi
        if echo "${donor_lon}" | grep -q '^-'; then
          lon_ref="W"
        fi

        exiftool -overwrite_original -n \
          "-GPSLatitude=${donor_lat}" \
          "-GPSLongitude=${donor_lon}" \
          "-GPSLatitudeRef=${lat_ref}" \
          "-GPSLongitudeRef=${lon_ref}" \
          "${FNAMES[j]}" >/dev/null 2>&1
      fi

      ((tagged++)) || true
    else
      echo "SKIP $(basename "${FNAMES[j]}"): nearest GPS is ${best_diff}s away (exceeds ${MAX_GAP}s)"
      ((skipped++)) || true
    fi
  done

  echo -e "\nDone: ${tagged} file(s) tagged, ${skipped} file(s) skipped."
  if [[ ${DRY_RUN} -eq 1 ]]; then
    echo "(Dry run — re-run without --dry-run to apply changes)"
  fi
}

# ----------------------------------------------------------------------------
# RUNTIME
# \(^_^)/                                      __|__
#                                     __|__ *---o0o---*
#                            __|__ *---o0o---*
#                         *---o0o---*
# ----------------------------------------------------------------------------
configure "$@"
find_photos
extract_metadata
print_report
build_donor_list || exit 0
fill_missing_gps
exit 0
