# photoshell
A collection of shell scripts for photographers

## Scripts
- [`scripts/gps_gap_fill.sh`](scripts/gps_gap_fill.sh): Fill missing GPS coordinates by copying coordinates from the nearest-in-time photo that already has geotags.
- [`scripts/extract_photo_summary.sh`](scripts/extract_photo_summary.sh): Extract key EXIF details, build a concise photo summary, and write it into comment/description metadata tags.

## Documentation
- [`docs/gps_gap_fill.md`](docs/gps_gap_fill.md): Why this script exists, how it works, requirements, usage, and limitations.
- [`docs/extract_photo_summary.md`](docs/extract_photo_summary.md): Why this script exists, how metadata is summarized, geocoding behavior, requirements, usage, and limitations.
