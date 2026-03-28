# scrub_selected_metadata.sh

`scrub_selected_metadata.sh` removes selected EXIF/IPTC metadata fields from supported image files in a directory.

![](../images/fjgstzwvekzs316k0a3q5pdlu2c.jpg)

## Why This Script Exists

Photo workflows often need targeted metadata cleanup before publishing, sharing, or downstream processing.

This script gives you a fast batch scrub that can either:

- use a safe default field set, or
- scrub an exact custom set of EXIF/IPTC fields that you provide.

## What The Script Does

The script:

1. Collects supported image/raw files in a target directory.
2. Applies optional recursion controls (`-r`, `-r N`, `-r 0`).
3. Builds an `exiftool` tag-clear list from:
   - default fields (when no selectors are provided), or
   - your exact selectors from `--exif` and/or `--iptc`.
4. Clears matching tags in place with `exiftool -overwrite_original`.

Supported file extensions:

- `jpg`, `jpeg`
- `tif`, `tiff`
- `png`
- `heic`, `heif`
- `cr2`, `cr3`, `arw`, `dng`, `nef`, `raf`, `orf`, `rw2`

## Defaults

If you do not pass `--exif` or `--iptc`, the script clears:

- `EXIF:UserComment`
- `EXIF:ImageDescription`
- `IPTC:Caption`
- `IPTC:Caption-Abstract`
- `IPTC:Keywords`

## Requirements

- Bash
- `exiftool`
- Standard shell utilities: `find`

## Usage

Use defaults in current directory:

```bash
./scripts/scrub_selected_metadata.sh
```

Preview without writing:

```bash
./scripts/scrub_selected_metadata.sh --dry-run /photos/working
```

Scrub exact EXIF and IPTC selections:

```bash
./scripts/scrub_selected_metadata.sh \
  --exif "UserComment,ImageDescription" \
  --iptc "Caption*" \
  /photos/working
```

Scrub only IPTC keyword-related fields recursively:

```bash
./scripts/scrub_selected_metadata.sh -r --iptc "Keywords*" /photos/archive
```

## Options

- `-n`, `--dry-run`: print files and selected tags, do not modify files.
- `--exif TAGS`: comma-separated EXIF tags/patterns to clear (for example: `UserComment,ImageDescription`).
- `--iptc TAGS`: comma-separated IPTC tags/patterns to clear (for example: `Caption*`).
- `-r`, `--recursive [N]`:
  - `-r 0`: no recursion (default behavior)
  - `-r N`: recurse `N` levels deep
  - `-r`: full recursion
- `-h`, `--help`: show usage.

## Safety Notes

- Metadata is modified in place via `exiftool -overwrite_original`.
- Run `--dry-run` first when using broad wildcard selectors (for example `Caption*`).
- Keep backups before running large batch metadata operations.
