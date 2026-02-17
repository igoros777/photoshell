# PhotoShell
PhotoShell is a practical Bash toolkit for photographers who need fast, repeatable metadata workflows on local files.

It focuses on common archive-cleanup tasks such as repairing missing GPS tags, generating standardized metadata summaries, and renaming photos/videos into searchable, context-rich filenames.

The scripts are designed for batch processing in a working directory and are built around `exiftool` and a small set of standard CLI utilities.

And in case you like photography, here are some of mine: https://fieldexposure.com/

![](https://github.com/igoros777/photoshell/blob/main/images/d41k59go09e2ntacd5r2jzjoecg.png?raw=true)

## Scripts
- [`scripts/photofolders.bat`](scripts/photofolders.bat): Create a standardized photo project folder tree (originals + processed) for multi-camera workflows.
- [`scripts/photofolders.sh`](scripts/photofolders.sh): Linux Bash version of `photofolders` with the same config-driven folder scaffold workflow.
- [`scripts/photofolders.config.cmd`](scripts/photofolders.config.cmd): External folder template used by `photofolders.bat` (categories, equipment, original subfolders, processed outputs).
- [`scripts/photofolders.config.sh`](scripts/photofolders.config.sh): Bash config used by `photofolders.sh` with the same folder model and variable naming.
- [`scripts/detect_blurry_photos.sh`](scripts/detect_blurry_photos.sh): Detect blur with ImageMagick, split photos into scenes by time gap plus visual similarity, and select the sharpest frame per scene.
- [`scripts/gps_gap_fill.sh`](scripts/gps_gap_fill.sh): Fill in missing GPS coordinates by copying them from the nearest-in-time photo with geotags.
- [`scripts/extract_photo_summary.sh`](scripts/extract_photo_summary.sh): Extract key EXIF details, build a concise photo summary, and write it into comment/description metadata tags.
- [`scripts/sync_exif_and_rename.sh`](scripts/sync_exif_and_rename.sh): Sync export JPEG metadata from matching originals and rename files back to source-aligned basenames.
- [`scripts/geo_rename_photos.sh`](scripts/geo_rename_photos.sh): Rename photos using capture timestamp, camera model, and reverse-geocoded location, with optional date-based folder structure.
- [`scripts/gopro_geo_rename.sh`](scripts/gopro_geo_rename.sh): Rename GoPro MP4 clips with capture time, reverse-geocoded location, duration, and original filename.

## Documentation
- [`docs/photofolders.md`](docs/photofolders.md): `photofolders` behavior, rationale, usage, and workflow integration for Windows and Linux variants.
- [`docs/photofolders_config.md`](docs/photofolders_config.md): Detailed config schema/format for `photofolders.config.cmd` and `photofolders.config.sh` with examples and rules.
- [`docs/detect_blurry_photos.md`](docs/detect_blurry_photos.md): Blur detection workflow with ImageMagick, scene splitting logic, and best-frame selection usage.
- [`docs/gps_gap_fill.md`](docs/gps_gap_fill.md): Why this script exists, how it works, requirements, usage, and limitations.
- [`docs/extract_photo_summary.md`](docs/extract_photo_summary.md): Why this script exists, how metadata is summarized, geocoding behavior, requirements, usage, and limitations.
- [`docs/sync_exif_and_rename.md`](docs/sync_exif_and_rename.md): Why this script exists, matching/metadata sync behavior, usage, safety, and limitations.
- [`docs/geo_rename_photos.md`](docs/geo_rename_photos.md): Why this script exists, how naming and folder structure work, requirements, usage, and limitations.
- [`docs/gopro_geo_rename.md`](docs/gopro_geo_rename.md): Why this script exists, how filename construction works, requirements, usage, and limitations.
