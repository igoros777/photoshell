# metadata_replace.sh

`metadata_replace.sh` finds and replaces text in selected EXIF/IPTC metadata fields across photos. Keywords are handled individually — replacing within a keyword list replaces the matching keyword, not the entire field.

![](../images/ilx4dzqw6mnkf5do1fwq3qsbj3b.jpg)

## Why This Script Exists

After generating metadata with Ollama or importing from other tools, photographers often need to fix inconsistencies in bulk: typos across hundreds of files, outdated tags that need renaming, or location names that need standardizing.

Manual exiftool commands for search/replace are error-prone, especially with keyword lists. This script handles the edge cases (array vs string keywords, empty replacements, regex safety) so you don't have to.

## What The Script Does

1. Reads target fields from all matching files using `exiftool -json`.
2. Matches the search pattern against each field value (plain text, whole word, or regex).
3. For Keywords: splits the list, replaces within individual keywords, removes empty entries.
4. For other fields: replaces within the string value.
5. Writes changes with `exiftool`, preserving `_original` backup files by default.

## Requirements

- Bash (GNU/Linux, WSL, macOS with GNU tools)
- `exiftool`
- `python3` (for JSON parsing and regex matching)

## Usage

```bash
# Basic find/replace across all fields
metadata_replace.sh -s "sunset" -R "golden hour" /photos

# Target specific fields
metadata_replace.sh -s "sunset" -R "golden hour" -F Keywords,Headline /photos

# Case-insensitive
metadata_replace.sh -s "NYC" -R "New York City" -i /photos

# Regex mode — delete keywords matching a pattern
metadata_replace.sh -s "IMG_\d{4}" -R "" -x -F Keywords /photos

# Whole word matching
metadata_replace.sh -s "sun" -R "star" -w /photos

# Dry run (preview without writing)
metadata_replace.sh -s "typo" -R "fixed" -n /photos

# Recursive with file type filter
metadata_replace.sh -s "old tag" -R "new tag" -r -t jpg,cr3 /photos
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `-s, --search TEXT` | Text to find (required) | — |
| `-R, --replace TEXT` | Replacement text (required; `""` to delete) | — |
| `-F, --fields FIELD,...` | Fields to operate on | all supported fields |
| `-i, --ignore-case` | Case-insensitive matching | off |
| `-w, --whole-word` | Match whole words only | off |
| `-x, --regex` | Treat search as Python regex | off |
| `-r, --recursive` | Include subfolders | off |
| `-t, --types EXT,...` | File extensions to process | all image types |
| `--no-backup` | Skip creating `_original` backup files | backup enabled |
| `-n, --dry-run` | Preview changes without writing | off |

## Supported Fields

Keywords, Caption-Abstract, Headline, ImageDescription, UserComment, Copyright, Credit, Source, City, Province-State, Country-PrimaryLocationName

## Keyword Handling

Keywords are treated as a list. When replacing:
- `"sunset, beach"` with search `"sunset"` → replace `"golden hour"` → produces `"golden hour, beach"`
- Replacing with empty string removes the keyword from the list entirely
- Both comma-separated strings and JSON arrays are handled

## Limitations

- Regex patterns use Python's `re` module syntax, not PCRE. Most common patterns work the same.
- The script processes files sequentially. For very large directories (10,000+ files), this may be slow.
- Backups create `_original` files which double disk usage. Use `--no-backup` if disk space is tight (but test with `--dry-run` first).
