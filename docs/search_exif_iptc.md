# search_exif_iptc.sh

`search_exif_iptc.sh` searches EXIF and IPTC metadata text across supported media files in a folder.

## Why This Script Exists

When archives grow, metadata search inside file managers is often inconsistent across formats.

This script gives you one CLI search pass over common EXIF/IPTC fields so you can quickly find files by camera info, captions, keywords, location tags, and other metadata values.

The default EXIF field set follows the Nikon-style sample in `exif_example.txt` (for example: `DateTimeOriginal`, `ISOSpeedRatings`, `LensInfo`, `UserComment`, `GPSVersionID`).

## What The Script Does

The script:

1. Scans media files in the target directory (recursive by default).
2. Reads selected EXIF/IPTC tags with `exiftool`.
3. Performs a case-insensitive text search against tag values.
4. Prints each matching file and matching metadata lines.
5. Prints scan and match totals at the end.

## Requirements

- Bash
- `exiftool`
- Standard shell utilities: `find`, `grep`, `sed`

## Usage

Search all standard EXIF + IPTC fields in all supported types (recursive):

```bash
./scripts/search_exif_iptc.sh --query "Yosemite" /photos/archive
```

Search only specific fields:

```bash
./scripts/search_exif_iptc.sh -q "Canon" -f Make,Model .
```

Search using sample-style field labels with spaces:

```bash
./scripts/search_exif_iptc.sh -q "Manual" -f "White Balance,Lens Info,User Comment" .
```

Search only IPTC fields in current directory (non-recursive):

```bash
./scripts/search_exif_iptc.sh -q "wedding" -f iptc --no-recursive /photos/processed
```

Search only selected media types:

```bash
./scripts/search_exif_iptc.sh -q "DJI" -m image,video /photos
```

## Options

- `-q`, `--query <text>`: search text (required).
- `-f`, `--fields <spec>`:
  - `all` (default)
  - `exif`
  - `iptc` (also accepts `ipct`)
  - comma-separated custom exiftool tags (for example: `Make,Model,Keywords`)
  - also accepts common sample-style aliases like `User Comment`, `White Balance`, `Lens Info`, `DateTime`
- `-m`, `--media-types <spec>`:
  - `all` (default)
  - `image`, `raw`, `video`
  - comma-separated custom extensions (for example: `jpg,heic,mp4`)
- `-n`, `--no-recursive`: current directory only.
- `-r`, `--recursive`: recursive search (default).
- `-h`, `--help`: help text.

## Supported Media Types

Built-in groups:

- `image`: `jpg`, `jpeg`, `jpe`, `tif`, `tiff`, `png`, `heic`, `heif`, `webp`, `gif`, `bmp`
- `raw`: `dng`, `cr2`, `cr3`, `nef`, `arw`, `raf`, `orf`, `rw2`, `rwl`, `srw`, `pef`
- `video`: `mp4`, `mov`, `m4v`, `avi`, `mkv`, `mts`, `m2ts`, `3gp`

You can pass additional/custom extensions via `--media-types`.
