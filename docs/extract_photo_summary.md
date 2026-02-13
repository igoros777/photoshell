# extract_photo_summary.sh

`extract_photo_summary.sh` reads EXIF data from one image, builds a concise human-readable technical summary, and writes that summary into common comment/description metadata fields.

## Why This Script Exists

Photo files often contain rich EXIF data, but it is spread across many tags and not easy to scan quickly inside DAM tools or file viewers.

This script creates a single compact summary string so each file carries a quick "what/when/where/how shot" description directly in metadata.

It is useful for:

- faster browsing and filtering in catalog tools,
- consistent captions for archival workflows,
- improving portability of key metadata across apps.

## What The Script Does

Given one input image file, it:

1. Validates input file existence.
2. Extracts camera/lens/exposure/image/date/GPS metadata using `exiftool`.
3. Converts capture time into a human-friendly phrase (for example: `Feb 5, 2026, late Wed afternoon`).
4. Reverse-geocodes GPS coordinates through geocod.io.
5. Builds a single summary line.
6. Writes that summary into:
   - `Comment`
   - `UserComment`
   - `IPTC:Caption-Abstract`
   - `XMP:Description`

## Summary Format

The script outputs and writes a line in this shape:

```text
<Model> | <Lens> | ISO: <ISO> | <Aperture> | <Shutter> | <Focal Length> | WB: <White Balance> | Metering: <Metering> | Flash: <Flash> | ExpComp: <Exposure Compensation> | <Resolution> | <Human Date> | <Location>
```

Missing metadata is replaced with `N/A` when possible.

## Requirements

- Bash
- `exiftool`
- `curl`
- `jq`
- Internet access for reverse geocoding
- Valid geocod.io API key configured in the script

## Usage

Run against a single image:

```bash
./scripts/extract_photo_summary.sh /path/to/photo.jpg
```

If no valid file is provided, the script prints:

```text
Usage: ./scripts/extract_photo_summary.sh <image-file>
```

## Geocoding Behavior

- Reads `GPSLatitude,GPSLongitude` from EXIF.
- Calls geocod.io reverse endpoint (`/reverse`) for formatted address.
- If first lookup fails, retries with slightly reduced coordinate precision.
- If geocoding still fails, falls back to `Mystery Town, USA`.

## Safety Notes

- Metadata writes use `exiftool -overwrite_original` (original file is replaced).
- Test on copied files first if you need a reversible workflow.
- The script currently embeds an API key value directly in source; prefer moving this to an environment variable for safer key handling.

## Known Limitations

- Single-file workflow only (one image per run).
- No `--dry-run` mode.
- Requires network for accurate location text.
- Reverse geocoding result quality depends on GPS precision and geocod.io coverage.
- Writing multiple caption/comment tags may overwrite existing descriptive text.
