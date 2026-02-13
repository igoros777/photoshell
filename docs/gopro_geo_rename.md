# gopro_geo_rename.sh

`gopro_geo_rename.sh` renames GoPro MP4 files into descriptive filenames that include capture time, location, and duration.

## Why This Script Exists

GoPro clips are usually exported with generic names such as `GH010135.MP4`, which are hard to search and sort in large archives.

This script solves that by embedding key context directly into each filename so clips are readable without opening them in an editor or DAM.

## What The Script Does

For `.MP4` files in the current directory (non-recursive), the script:

1. Reads GPS coordinates from EXIF with `exiftool`.
2. Reverse-geocodes coordinates with geocod.io.
3. Retries geocoding with slightly reduced coordinate precision if needed.
4. Falls back to `mystery_town` when location lookup fails.
5. Reads clip duration from metadata and converts it to seconds.
6. Renames each file with capture date/time + location + duration + original name.

## Filename Format

The output name pattern is:

```text
YYYYMMDD-HHMM-###-<location>-<duration>s-<original_name>.mp4
```

Example:

```text
20220706-1128-000-190_s_park_st_lake_city_co_81235-31s-GH010135.MP4.mp4
```

## Requirements

- Bash
- `exiftool`
- `curl`
- `jq`
- Internet access (for reverse geocoding)
- geocod.io API key configured in the script

## Configuration

Set your geocod.io API key in `scripts/gopro_geo_rename.sh`:

```bash
api_key="Get your API key from https://www.geocod.io"
```

Replace that string with your actual key before running.

## Usage

Run from the directory that contains target GoPro clips:

```bash
./scripts/gopro_geo_rename.sh
```

## Safety Notes

- Renaming is done in place; original filenames are changed.
- Test on copied files first if your workflow depends on original camera names.
- Keep a backup before batch renaming.

## Known Limitations

- Non-recursive: only processes files in the current directory.
- Matches uppercase `.MP4` only (not lowercase `.mp4`).
- Requires valid GPS metadata for accurate location naming.
- Uses network geocoding; results depend on geocod.io coverage and coordinate quality.
