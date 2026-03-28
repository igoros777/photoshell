# sync_exif_and_rename.sh

`sync_exif_and_rename.sh` repairs exported JPEG metadata by copying EXIF from matching source files in your originals archive, then renames exports to the original base filename.

![](../images/moybidf7n3jwyyvbjp9l5ba5wg8.jpg)

## Why This Script Exists

Many edit/export workflows produce files with:

- stripped or inconsistent metadata,
- tool-generated suffixes like `-edit`, `-hdr`, `-2x`,
- names that no longer match archive originals.

That makes DAM import, search, and long-term organization harder. This script restores metadata consistency and normalizes filenames so exports align with their source material.

## What The Script Does

For `jpg`/`jpeg` files in the given target folder (non-recursive), the script:

1. Builds candidate source stems by stripping common editor/upscale suffixes.
2. Finds matching original files in the originals directory.
3. Prefers raw-like formats first when multiple matches exist (`NEF`, `CR3`, `ARW`, etc.).
4. Clears target metadata, preserves current orientation, then copies EXIF from the chosen source.
5. Aligns file mtime with the source file timestamp.
6. Renames the target to `<original_stem>.jpg` and resolves collisions with `_1`, `_2`, etc.

## Originals Directory Resolution

The script can locate originals in two ways:

- explicit: `--orig-dir /path/to/originals`
- automatic: walk up from target folder and pick the first sibling directory named `originals`

Auto-discovery works well with project layouts where `processed/...` and `originals/...` share the same root.

## Requirements

- Bash
- `exiftool`
- Standard shell utilities used by the script: `find`, `touch`, `mv`, `realpath`

## Usage

Dry run first:

```bash
./scripts/sync_exif_and_rename.sh /path/to/processed/exports --dry-run
```

Apply changes with auto-detected originals:

```bash
./scripts/sync_exif_and_rename.sh /path/to/processed/exports
```

Apply changes with explicit originals directory:

```bash
./scripts/sync_exif_and_rename.sh /path/to/processed/exports --orig-dir /path/to/originals
```

## Workflow Diagram

```mermaid
flowchart TD
    A([Start]) --> B[Parse CLI args]
    B --> C{Target dir provided?}
    C -->|No| Z1([Exit with usage error])
    C -->|Yes| D{exiftool installed?}
    D -->|No| Z2([Exit with dependency error])
    D -->|Yes| E{Target dir exists?}
    E -->|No| Z3([Exit with path error])
    E -->|Yes| F{--orig-dir passed?}

    F -->|Yes| G[Validate and resolve ORIG_DIR]
    F -->|No| H[Walk up from TARGET_DIR to find sibling 'originals']
    G --> I{ORIG_DIR resolved?}
    H --> I
    I -->|No| Z4([Exit: cannot find originals])
    I -->|Yes| J[Find top-level JPG/JPEG in TARGET_DIR]

    J --> K{Next target JPEG}
    K -->|None left| Z5([Done])
    K -->|Found| L[Build stem candidates<br/>strip suffixes/prefixes]
    L --> M[Find source candidates in ORIG_DIR]
    M --> N{Any source candidates?}
    N -->|No| O[Log 'No original found'] --> K
    N -->|Yes| P[Pick preferred source by extension order]
    P --> Q[Compute new name: original_stem.jpg]
    Q --> R{Dry run?}

    R -->|Yes| S[Print planned source and rename] --> K
    R -->|No| T[Read target Orientation]
    T --> U[Clear all target metadata]
    U --> V{Orientation existed?}
    V -->|Yes| W[Restore target Orientation]
    V -->|No| X[Continue]
    W --> X
    X --> Y[Copy all tags from source except Orientation]
    Y --> AA[Set target mtime from source]
    AA --> AB{Name conflict at destination?}
    AB -->|Yes| AC[Append _1/_2/... suffix]
    AB -->|No| AD[Use direct destination]
    AC --> AE[Rename target file]
    AD --> AE
    AE --> K
```

## Safety Notes

- Metadata changes and renames are in place.
- Run `--dry-run` before write mode.
- Keep a backup before batch processing.

## Known Limitations

- Non-recursive: only scans the target folder itself.
- Matching is stem-based; unusual naming patterns may require manual cleanup.
- Depends on EXIF/metadata presence in source files for best results.
