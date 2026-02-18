# contact_sheet.sh

`contact_sheet.sh` builds a contact/proof sheet from photos in a folder.

Each tile includes:

1. A thumbnail (long edge controlled by `--thumb-size`).
2. Caption text selected with fallback priority:
   1. `IPTC:Caption-Abstract`
   2. `EXIF:UserComment`
   3. Brief EXIF summary (`Model`, `Lens`, `FNumber`, `ExposureTime`, `ISO`, `FocalLength`, `DateTimeOriginal`/`CreateDate`)

## Why This Script Exists

Photo review and client proofing often needs one sheet that shows many frames plus useful notes.

This script automates both thumbnail layout and per-image caption extraction from embedded metadata.

## What The Script Does

1. Scans the source folder for supported image files.
2. Optionally scans subfolders (`--recursive`).
3. Builds one tile per image (thumbnail + caption block).
4. Computes sheet geometry (columns/rows) from thumbnail long-edge size and image count.
5. Writes a single contact sheet image.

## Requirements

- Bash
- `exiftool`
- ImageMagick:
  - IM7: `magick`
  - or IM6: `convert` + `montage`
- Standard shell utilities: `find`, `sort`, `awk`, `sed`

## Usage

Default behavior (current folder, non-recursive, 256px thumbnails):

```bash
./scripts/contact_sheet.sh
```

Specify source folder, recursive scan, and custom thumbnail size:

```bash
./scripts/contact_sheet.sh -s /photos/wedding -r -t 320 -o wedding_proof.jpg
```

Non-recursive scan in a specific folder:

```bash
./scripts/contact_sheet.sh --source /photos/exports --no-recursive --thumb-size 192
```

## Options

- `-s`, `--source DIR`: source folder (default: `.`).
- `-r`, `--recursive`: include subfolders.
- `-n`, `--no-recursive`: only the source folder (default).
- `-t`, `--thumb-size PX`: thumbnail long-edge size in pixels (default: `256`).
- `-o`, `--output FILE`: output contact sheet file (default: `contact_sheet.jpg`).
- `-h`, `--help`: show help text.

## Supported Image Types

- `jpg`, `jpeg`, `jpe`
- `tif`, `tiff`
- `png`
- `heic`, `heif`
- `webp`
- `bmp`
- `gif`

## Geometry Notes

The script derives geometry from the thumbnail long-edge size and number of images.

- Caption block height scales from thumbnail size (minimum 64px).
- Column count targets a balanced sheet aspect while respecting a max canvas width.
- Row count is derived from `ceil(image_count / columns)`.

The computed geometry is printed before rendering, for example:

```text
Contact sheet geometry: 6 columns x 4 rows
```
