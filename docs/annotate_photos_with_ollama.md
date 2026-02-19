# annotate_photos_with_ollama.sh

`annotate_photos_with_ollama.sh` generates concise technical photo descriptions with Ollama and appends the result to both IPTC and EXIF comment fields.

## Why This Script Exists

Photo collections often have partial or inconsistent descriptive metadata.

This script automates dense, photography-focused annotation by combining model output with existing per-file metadata context, then writing the generated description back into standard tags used by many photo tools.

## What The Script Does

For each selected image, it:

1. Runs `ollama run` with a prompt focused on technical photographic description and location-aware subject context.
2. Captures and normalizes the model output.
3. Reads existing values from:
   - `IPTC:Caption-Abstract`
   - `EXIF:UserComment`
4. Appends the new description to both fields (preserving existing text).
5. Writes metadata using `exiftool -overwrite_original`.

## Input Modes

Exactly one of these modes is used:

- directory scan (default): current directory or provided `DIRECTORY`
- single file: `--file <path>`
- list file: `--list <path>` (one file path per line)

Rules:

- `--file` and `--list` cannot be used together.
- `DIRECTORY` cannot be combined with `--file` or `--list`.
- `--recursive` is relevant only for directory mode.

## Requirements

- Bash
- `ollama`
- `exiftool`
- `find`

## Usage

Directory mode (current directory):

```bash
./scripts/annotate_photos_with_ollama.sh
```

Directory mode (recursive):

```bash
./scripts/annotate_photos_with_ollama.sh -r /photos/archive
```

Single file:

```bash
./scripts/annotate_photos_with_ollama.sh --file /photos/archive/img001.cr3
```

List file:

```bash
./scripts/annotate_photos_with_ollama.sh --list /photos/archive/file_list.txt
```

Custom model:

```bash
./scripts/annotate_photos_with_ollama.sh -m gemma3:12b -r /photos/archive
```

## List File Format

- One path per line.
- Blank lines are ignored.
- Lines starting with `#` are treated as comments.
- Relative paths are resolved relative to the list file location.
- Missing or unsupported entries are skipped with warnings.

## Supported Image Extensions

`jpg`, `jpeg`, `jpe`, `png`, `tif`, `tiff`, `heic`, `heif`, `webp`, `bmp`, `gif`, `dng`, `arw`, `cr2`, `cr3`, `nef`, `nrw`, `orf`, `raf`, `rw2`, `pef`, `srw`, `x3f`

## Safety Notes

- Metadata writes use `exiftool -overwrite_original` (the original file is replaced).
- Because text is appended, repeated runs add additional entries to both metadata fields.
- Test on a copy first if you need a reversible workflow.
