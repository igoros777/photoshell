# geo_rename_photos.sh

`geo_rename_photos.sh` renames photo files into consistent, metadata-rich filenames using capture time, camera model, and reverse-geocoded location.

## Why This Script Exists

Camera filenames like `DSC01234.JPG` or `IMG_8472.HEIC` are not descriptive and become hard to manage in large archives.

This script solves that by embedding useful context directly into each filename so files are sortable and recognizable without opening them in a DAM tool.

It is especially useful when:

- photo sets come from multiple cameras and file naming conventions,
- location context matters for search and archival workflows,
- you want optional date-based folder structures without changing the actual image metadata.

## What The Script Does

For supported photo files in the current directory (non-recursive), the script:

1. Reads capture time (`DateTimeOriginal`, fallback `CreateDate`) with `exiftool`.
2. Reads camera model (`Model`) and normalizes it for safe filename use.
3. Reads GPS coordinates and reverse-geocodes them via geocod.io.
4. Falls back to `mystery_town` when location lookup is unavailable or fails.
5. Builds a target filename from timestamp + model + location.
6. Optionally moves files into date-based folders (`none`, `daily`, `monthly`).
7. Resolves name collisions by appending `-1`, `-2`, etc.

It also writes `XMP-xmpMM:PreservedFileName` with the prior base filename before moving/renaming.

## Filename Format

Output name pattern:

```text
YYYYMMDD-HHMMSS-<camera_model>-<location>.<ext>
```

Example:

```text
20240215-173045-sonya7iv-123_main_st_lake_city_co_81235.jpg
```

If metadata is missing:

- camera model fallback: `unknowncamera`
- location fallback: `mystery_town`

## Folder Structure Options

- `none` (default): keep files in current folder
- `daily`: `YYYY/YYYY-MM-DD`
- `monthly`: `YYYY/YYYY-MM`

## Requirements

- Bash with GNU-compatible `date -d`
- `exiftool`
- `curl`
- `jq`
- standard shell tools used by the script: `find`, `sed`, `grep`, `awk`
- Internet access for reverse geocoding (optional but recommended)

## Configuration

Set your geocod.io API key with environment variable:

```bash
export GEOCODIO_API_KEY="your_api_key_here"
```

If no API key is set, the script still runs and uses `mystery_town` for location.

## Usage

Run from the folder that contains the photos you want to process.

Dry run (recommended first):

```bash
./scripts/geo_rename_photos.sh --dry-run
```

Apply changes in place:

```bash
./scripts/geo_rename_photos.sh
```

Apply changes with daily folder structure:

```bash
./scripts/geo_rename_photos.sh --structure daily
```

## Workflow Diagram

```mermaid
flowchart TD
    A([Start]) --> B[Load config and defaults]
    B --> C[Parse command line arguments]
    C --> D[Check required commands]
    D --> E[Find supported photo files in current folder]
    E --> F{Any files found}
    F -->|No| Z1([Exit with no work])
    F -->|Yes| G[Initialize counters]
    G --> H{Next photo file}
    H -->|No| Z2([Print summary and exit])
    H -->|Yes| I[Read capture datetime from EXIF]

    I --> J{Datetime available}
    J -->|No| K[Skip file and increment skipped]
    J -->|Yes| L[Normalize datetime and compute timestamp]
    L --> M{Datetime valid}
    M -->|No| K
    M -->|Yes| N[Read and sanitize camera model]
    N --> O[Read GPS coordinates]
    O --> P{Coordinates valid}
    P -->|No| Q[Set location to mystery_town]
    P -->|Yes| R[Resolve location by reverse geocoding]
    R --> S{Location resolved}
    S -->|No| Q
    S -->|Yes| T[Use resolved location]
    Q --> U[Build target path from stamp model location extension]
    T --> U

    U --> V[Apply structure mode none daily or monthly]
    V --> W[Resolve filename collision if needed]
    W --> X{Target equals source}
    X -->|Yes| K
    X -->|No| Y{Dry run mode}
    Y -->|Yes| AA[Print plan and increment planned]
    Y -->|No| AB[Write preserved filename tag]
    AB --> AC[Create target directory if needed]
    AC --> AD[Move file and increment renamed]

    K --> H
    AA --> H
    AD --> H
```

## Safety Notes

- Renaming and moves are done in place.
- Always run `--dry-run` first to validate naming and folder outcomes.
- Keep a backup before batch rename/move operations.

## Known Limitations

- Non-recursive: scans only the current directory.
- Date parsing depends on GNU-style `date -d`.
- Geocoding quality depends on GPS precision and geocod.io coverage.
- Files without usable capture time are skipped.
