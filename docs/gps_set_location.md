# gps_set_location.sh

`gps_set_location.sh` geocodes a named location via the Geocod.io API and writes GPS coordinates to photo EXIF metadata. Optionally randomizes coordinates within a radius for natural-looking distribution.

![](../images/gaac25strlj9za0xel1bx484tt9.jpg)

## Why This Script Exists

Many photos have no GPS data at all — the camera lacks a GPS module, or GPS was disabled. When you know where the photos were taken, this script lets you write GPS coordinates in bulk from a place name, without manually looking up coordinates.

The randomized spread feature prevents all photos from landing on the exact same map point, which looks unnatural in catalogs and can trigger duplicate-location flags on stock agencies.

## What The Script Does

1. Calls the [Geocod.io](https://www.geocod.io/) forward geocoding API with the location name.
2. Gets the center latitude and longitude.
3. For each matching photo file:
   - Skips files that already have GPS (unless `--force` is used).
   - If spread is enabled, generates a random offset within the radius using uniform circular distribution.
   - Writes GPS latitude, longitude, and reference tags to EXIF via `exiftool`.

## Spread Algorithm

When a spread radius is specified, each photo gets coordinates randomly distributed within a circle centered on the geocoded location. The algorithm uses `sqrt(random)` scaling to ensure uniform area distribution (not clustered at the center).

Supported units: **miles**, **km**, **yards**, **meters**. Conversion to degrees uses the approximation 1° latitude ≈ 111,320 meters.

## Requirements

- Bash (GNU/Linux, WSL, macOS with GNU tools)
- `exiftool`
- `curl`
- `python3` (for URL encoding, JSON parsing, and random offset calculation)
- `GEOCODIO_API_KEY` environment variable — get a free key at [geocod.io](https://www.geocod.io/). The free tier allows 2,500 lookups per day. See [pricing](https://www.geocod.io/pricing/).

## Usage

```bash
# Basic — set all photos to one location
gps_set_location.sh -l "Cape Lookout, NC" /path/to/photos

# With spread — randomize within a quarter mile
gps_set_location.sh -l "Cape Lookout, NC" -s 0.25 -u miles /path/to/photos

# Metric spread
gps_set_location.sh -l "Tokyo Tower" -s 500 -u meters /path/to/photos

# Recursive with file type filter
gps_set_location.sh -l "Central Park, New York" -s 0.5 -u km -r -t jpg,cr3 /path/to/photos

# Force overwrite existing GPS data
gps_set_location.sh -l "Big Sur, CA" --force /path/to/photos

# Dry run — preview without writing
gps_set_location.sh -l "Longwood Gardens, PA" -s 100 -u yards -n /path/to/photos
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `-l, --location NAME` | Location to geocode (required) | — |
| `-s, --spread RADIUS` | Randomize GPS within this radius | 0 (exact center) |
| `-u, --unit UNIT` | Spread unit: miles, km, yards, meters | miles |
| `-r, --recursive` | Include subfolders | off |
| `-t, --types EXT,...` | File extensions to process | all image types |
| `-f, --force` | Overwrite existing GPS data | skip files with GPS |
| `-n, --dry-run` | Preview without writing | off |

## Output

```
Geocoding: Cape Lookout, NC
Coordinates: 34.6244, -76.5394 (accuracy: place)
Spread: 0.25 miles (~0.00000402 degrees)

Files found: 128
  TAG   DSCF3254.JPG -> 34.62418932, -76.53901247
  TAG   DSCF3255.JPG -> 34.62462108, -76.53978534
  SKIP  DSCF3256.JPG (has GPS)
  ...

Done: 126 tagged, 2 skipped, 0 failed
```

## Limitations

- Geocod.io coverage is strongest in the US and Canada. International locations may have lower accuracy.
- The spread radius is approximate — it uses a flat-earth approximation for degree conversion, which is accurate within a few miles but less precise at extreme latitudes or very large radii.
- The script does not validate that the geocoded location is correct — review the coordinates in the output before processing large batches.
