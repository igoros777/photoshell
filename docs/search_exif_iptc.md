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
5. Optionally copies matching files to a destination directory.
6. Prints scan and match totals at the end.

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

Search in parallel and copy matches to another directory:

```bash
./scripts/search_exif_iptc.sh -q "Nikon" --jobs 8 --copy-to /tmp/metadata-hits /photos
```

## Workflow Diagram

```mermaid
flowchart TD
    A([Start]) --> B[Parse command line arguments]
    B --> C{Help requested}
    C -->|Yes| D[Print usage and exit]
    C -->|No| E{Query provided}
    E -->|No| Z1([Exit with error])
    E -->|Yes| F{Search directory exists}
    F -->|No| Z2([Exit with error])
    F -->|Yes| G{exiftool available}
    G -->|No| Z3([Exit with error])
    G -->|Yes| H[Resolve selected metadata fields]

    H --> I{Fields selection valid}
    I -->|No| Z4([Exit with error])
    I -->|Yes| J[Resolve media extensions from media types spec]
    J --> K{Media extension selection valid}
    K -->|No| Z5([Exit with error])
    K -->|Yes| L[Build find arguments with recursive or maxdepth]
    L --> M[Collect matching files]
    M --> N{Any files found}
    N -->|No| Z6([Exit with status zero no files])
    N -->|Yes| O[Build exiftool tag arguments]

    O --> P[Initialize scanned and matched counters]
    P --> Q{Next file}
    Q -->|No| R[Print scanned and matched totals]
    Q -->|Yes| S[Read selected metadata via exiftool]
    S --> T{Metadata returned}
    T -->|No| Q
    T -->|Yes| U[Search metadata lines with case insensitive match]
    U --> V{Any lines matched query}
    V -->|No| Q
    V -->|Yes| W[Print file and matching lines and increment matched]
    W --> Q

    R --> X{Matched count equals zero}
    X -->|Yes| Z7([Exit with status one])
    X -->|No| Z8([Done])
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
- `-j`, `--jobs <n>`: number of parallel workers (default: detected CPU cores).
- `-c`, `--copy-to <dir>`: copy matching files to this directory, preserving path relative to the search root.
- `-h`, `--help`: help text.

## Supported Media Types

Built-in groups:

- `image`: `jpg`, `jpeg`, `jpe`, `tif`, `tiff`, `png`, `heic`, `heif`, `webp`, `gif`, `bmp`
- `raw`: `dng`, `cr2`, `cr3`, `nef`, `arw`, `raf`, `orf`, `rw2`, `rwl`, `srw`, `pef`
- `video`: `mp4`, `mov`, `m4v`, `avi`, `mkv`, `mts`, `m2ts`, `3gp`

You can pass additional/custom extensions via `--media-types`.
