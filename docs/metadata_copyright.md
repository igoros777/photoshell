# metadata_copyright.sh

`metadata_copyright.sh` batch-writes photographer name, copyright notice, and contact information to IPTC/EXIF fields across photos. By default it only fills empty fields — use `--force` to overwrite existing values.

## Why This Script Exists

Every photo shoot needs copyright and creator attribution stamped into the metadata. Without it, images lose provenance when shared, uploaded to stock sites, or archived. Doing this manually per file or per folder is tedious and easy to forget.

This script writes all copyright/creator fields in one pass, supports year substitution, and respects existing values by default.

## What The Script Does

For each matching photo file:

1. Checks which target fields are currently empty (unless `--force` is used).
2. Writes the provided values to the appropriate IPTC and EXIF tags.
3. Preserves `_original` backup files by default.

## Fields Written

| Option | IPTC Tag | EXIF Tag |
|--------|----------|----------|
| `--author` | By-line | Artist |
| `--copyright` | CopyrightNotice | Copyright |
| `--email` | XMP-iptcCore:CiEmailWork | — |
| `--website` | XMP-iptcCore:CiUrlWork | — |
| `--credit` | Credit | — |
| `--source` | Source | — |

## Requirements

- Bash (GNU/Linux, WSL, macOS with GNU tools)
- `exiftool`

## Usage

```bash
# Basic — author and copyright with year substitution
metadata_copyright.sh -a "Igor Oseledko" -c "© %Y Igor Oseledko" /photos

# Full contact info
metadata_copyright.sh -a "Igor Oseledko" \
  -c "© %Y Igor Oseledko" \
  -e "igor@igoros.com" \
  -w "https://fieldexposure.com" \
  --credit "Igor Oseledko / Field Exposure" \
  --source "Field Exposure" /photos

# Force overwrite existing values
metadata_copyright.sh -a "Igor Oseledko" -c "© %Y Igor Oseledko" --force /photos

# Recursive with file type filter
metadata_copyright.sh -a "Igor Oseledko" -c "© %Y Igor Oseledko" -r -t jpg,cr3 /photos

# Dry run
metadata_copyright.sh -a "Igor Oseledko" -c "© %Y Igor Oseledko" -n /photos
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `-a, --author NAME` | Photographer/creator name | — |
| `-c, --copyright TEXT` | Copyright notice (`%Y` = current year) | — |
| `-e, --email EMAIL` | Contact email | — |
| `-w, --website URL` | Contact website | — |
| `--credit TEXT` | Credit line | — |
| `--source TEXT` | Source | — |
| `-f, --force` | Overwrite existing values | fill empty only |
| `-r, --recursive` | Include subfolders | off |
| `-t, --types EXT,...` | File extensions to process | all image types |
| `--no-backup` | Skip creating `_original` backup files | backup enabled |
| `-n, --dry-run` | Preview changes without writing | off |

## Year Substitution

Use `%Y` in the copyright text to insert the current year at runtime:

```bash
-c "© %Y Igor Oseledko"    # becomes "© 2026 Igor Oseledko"
-c "Copyright %Y"           # becomes "Copyright 2026"
```

## Fill-Empty vs Force

By default, the script checks each field per file and only writes if the field is currently empty. This prevents accidentally overwriting metadata that was set intentionally (e.g., a different copyright holder on contributed photos).

Use `--force` when you want to standardize all files to the same values, overwriting any existing metadata.

## Limitations

- The IPTC Contact fields (email, website) are written to the XMP-iptcCore namespace. Some older software may not read these fields — they will be visible in exiftool, Lightroom, and Photoshop but may not appear in simpler viewers.
- `%Y` is the only supported substitution. Other date formats (month, day) are not supported.
