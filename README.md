# PhotoShell
PhotoShell is a practical Bash toolkit for photographers who need fast, repeatable metadata workflows on local files.

It focuses on common archive-cleanup tasks such as repairing missing GPS tags, generating standardized metadata summaries, and renaming photos/videos into searchable, context-rich filenames.

The scripts are designed for batch use in a working directory and built around `exiftool` plus a small set of standard CLI utilities.

![](https://github.com/igoros777/photoshell/blob/main/images/d41k59go09e2ntacd5r2jzjoecg.png?raw=true)

## Scripts
- [`scripts/gps_gap_fill.sh`](scripts/gps_gap_fill.sh): Fill in missing GPS coordinates by copying them from the nearest-in-time photo with geotags.
- [`scripts/extract_photo_summary.sh`](scripts/extract_photo_summary.sh): Extract key EXIF details, build a concise photo summary, and write it into comment/description metadata tags.
- [`scripts/geo_rename_photos.sh`](scripts/geo_rename_photos.sh): Rename photos using capture timestamp, camera model, and reverse-geocoded location, with optional date-based folder structure.
- [`scripts/gopro_geo_rename.sh`](scripts/gopro_geo_rename.sh): Rename GoPro MP4 clips with capture time, reverse-geocoded location, duration, and original filename.

## Documentation
- [`docs/gps_gap_fill.md`](docs/gps_gap_fill.md): Why this script exists, how it works, requirements, usage, and limitations.
- [`docs/extract_photo_summary.md`](docs/extract_photo_summary.md): Why this script exists, how metadata is summarized, geocoding behavior, requirements, usage, and limitations.
- [`docs/geo_rename_photos.md`](docs/geo_rename_photos.md): Why this script exists, how naming and folder structure work, requirements, usage, and limitations.
- [`docs/gopro_geo_rename.md`](docs/gopro_geo_rename.md): Why this script exists, how filename construction works, requirements, usage, and limitations.
