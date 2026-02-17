#!/usr/bin/env bash
#
#                                      |
#                                  ___/"\___
#                          __________/ o \__________
#                            (I) (G) \___/ (O) (R)
#                                Igor Oseledko
#                           igor@comradegeneral.com
#                                 2025-11-02
# ----------------------------------------------------------------------------
set -euo pipefail

# Usage:
#   ./sync_exif_and_rename.sh /path/to/.../processed/adobe [--dry-run]
#
# Does:
#   a) Only processes JPG/JPEG in the given "adobe" folder (non-recursive)
#   b) Finds a matching original under "../../originals" by filename stem (stripping trailing edit/LuminarAI/HDR suffixes)
#   c) Copies all EXIF from original to target JPEG, overwriting metadata
#   d) Renames the target JPEG to match the original's basename (stem) with .jpg
# ----------------------------------------------------------------------------
DRY_RUN=0
if [[ "${2:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

ADOBE_DIR="${1:-}"
if [[ -z "$ADOBE_DIR" ]]; then
  echo "Give me the 'processed/adobe' path. This isn't telepathy."
  exit 1
fi

if ! command -v exiftool >/dev/null 2>&1; then
  echo "exiftool not found. Install it and try again."
  exit 1
fi

# Resolve originals dir relative to adobe dir
ADOBE_DIR="$(cd "$ADOBE_DIR" && pwd)"
ORIG_DIR="$(cd "$ADOBE_DIR/../../originals" 2>/dev/null && pwd || true)"
if [[ -z "$ORIG_DIR" || ! -d "$ORIG_DIR" ]]; then
  echo "Can't find originals at: $ADOBE_DIR/../../originals"
  exit 1
fi

echo "Adobe: $ADOBE_DIR"
echo "Originals: $ORIG_DIR"
[[ $DRY_RUN -eq 1 ]] && echo "[DRY-RUN mode]"

# Prefer raw-ish originals first if multiple are found
# Extend this list to taste; first match wins.
PREFERRED_EXTS=(
  NEF CR3 CR2 ARW RAF DNG ORF RW2 RWL SRW
  HEIC HEIF
  JPG JPEG
  DNG TIFF TIF PNG BMP GIF
)

shopt -s nullglob

# Find JPGs only at this level
while IFS= read -r -d '' jpg; do
  base="$(basename "$jpg")"
  dir="$(dirname "$jpg")"
  # stem is the export basename without common editor suffixes
  base_no_ext="${base%.*}"
  stem="$base_no_ext"
  # Peel trailing editor/upscale noise tokens
  noise_regex='(.*)[_-](edit|enhanced|nr|luminarai|luminarneo|hdr|cloud|redefine|realistic|gigapixel|pano|panorama)$'
  while :; do
    lower="${stem,,}"
    if [[ "$lower" =~ $noise_regex ]]; then
      stem="${BASH_REMATCH[1]}"
      continue
    fi
    # Drop trailing upscale markers like "-2x"
    if [[ "$lower" =~ (.*)[_-][0-9]+x$ ]]; then
      stem="${BASH_REMATCH[1]}"
      continue
    fi
    # Drop trailing duplicate counters like "-2" or "_3" (but keep 4-digit shot numbers)
    if [[ "$lower" =~ (.*)[_-][0-9]{1,2}$ ]]; then
      stem="${BASH_REMATCH[1]}"
      continue
    fi
    break
  done
  # Strip any leftover embedded extension like "foo.JPG-Edit.jpg"
  stem="${stem%.*}"

  stem_with_prefix="$stem"
  stem_no_prefix="$stem_with_prefix"
  # Drop leading datetime prefixes like 2022-07-06_16-08-22_
  if [[ "${stem_no_prefix,,}" =~ ^[0-9]{4}[-_][0-9]{2}[-_][0-9]{2}([-_][0-9]{2}[-_][0-9]{2}[-_][0-9]{2})?[-_]+(.+)$ ]]; then
    stem_no_prefix="${BASH_REMATCH[2]}"
  fi

  stem_candidates=()
  if [[ "$stem_no_prefix" != "$stem_with_prefix" ]]; then
    stem_candidates+=("$stem_no_prefix" "$stem_with_prefix")
  else
    stem_candidates+=("$stem_with_prefix")
  fi

  candidates=()
  stem_used=""
  stems_tried=()

  for candidate_stem in "${stem_candidates[@]}"; do
    stems_tried+=("$candidate_stem")
    mapfile -d '' -t candidates < <(find "$ORIG_DIR" -type f -iname "$candidate_stem.*" -print0)

    # Fallback: try replacing underscores with hyphens if nothing matched
    if [[ ${#candidates[@]} -eq 0 ]]; then
      alt_stem="${candidate_stem//_/-}"
      if [[ "$alt_stem" != "$candidate_stem" ]]; then
        stems_tried+=("$alt_stem")
        mapfile -d '' -t candidates < <(find "$ORIG_DIR" -type f -iname "$alt_stem.*" -print0)
        [[ ${#candidates[@]} -gt 0 ]] && echo "  fallback stem: $alt_stem"
        [[ ${#candidates[@]} -gt 0 ]] && candidate_stem="$alt_stem"
      fi
    fi

    if [[ ${#candidates[@]} -gt 0 ]]; then
      stem_used="$candidate_stem"
      break
    fi
  done

  if [[ ${#candidates[@]} -eq 0 ]]; then
    echo "No original found for: $base (stems tried: ${stems_tried[*]})"
    continue
  fi

  pick=""
  # Try preferred extensions first
  for ext in "${PREFERRED_EXTS[@]}"; do
    for c in "${candidates[@]}"; do
      if [[ "${c,,}" == *".${ext,,}" ]]; then
        pick="$c"
        break 2
      fi
    done
  done
  # If none matched preferred list, just take the first candidate
  if [[ -z "$pick" ]]; then
    pick="${candidates[0]}"
  fi

  orig_base="$(basename "$pick")"
  orig_stem="${orig_base%.*}"
  new_name="${orig_stem}.jpg"
  new_path="$dir/$new_name"

  echo "Processing:"
  echo "  target: $base"
  echo "  source: $(realpath --relative-to="$ADOBE_DIR" "$pick")"
  echo "  rename: $base -> $new_name"

  if [[ $DRY_RUN -eq 0 ]]; then

    # Preserve existing Orientation, wipe other tags
    orientation=$(exiftool -Orientation -b "$jpg" || true)
    exiftool -q -q -overwrite_original -all= "$jpg"

    # Restore the original JPEG's orientation tag if present
    if [[ -n "$orientation" ]]; then
      exiftool -q -q -overwrite_original "-Orientation=$orientation" "$jpg"
    fi

    # Copy all tags from source except Orientation
    exiftool -q -q -overwrite_original "-TagsFromFile" "$pick" "-all:all>all:all" "-Orientation=" "$jpg"

    touch -r "$pick" "$jpg"

    # Rename to match original's basename
    if [[ "$jpg" != "$new_path" ]]; then
      if [[ -e "$new_path" ]]; then
        echo "  WARN: $new_name already exists. Appending suffix."
        i=1
        while [[ -e "${dir}/${orig_stem}_$i.jpg" ]]; do ((i++)); done
        new_path="${dir}/${orig_stem}_$i.jpg"
      fi
      mv -f -- "$jpg" "$new_path"
      jpg="$new_path"
    fi
  fi

done < <(find "$ADOBE_DIR" -maxdepth 1 -type f \( -iname '*.jpg' -o -iname '*.jpeg' \) -print0)
# ----------------------------------------------------------------------------
# RUNTIME
# \(^_^)                                      __|__
#                                     __|__ *---o0o---*
#                            __|__ *---o0o---*
#                         *---o0o---*
# ----------------------------------------------------------------------------
