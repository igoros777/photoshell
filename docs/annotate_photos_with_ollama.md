# annotate_photos_with_ollama.sh

`annotate_photos_with_ollama.sh` runs one Ollama metadata workflow at a time:

- `--description` (default): generate a concise technical description and replace:
  - `EXIF:ImageDescription`
  - `IPTC:Caption-Abstract`
- `--keywords`: generate keywords and populate `IPTC:Keywords` only when it is empty.

## Why This Script Exists

Photo collections often have inconsistent captions and missing keyword tags.

This script provides repeatable, model-driven enrichment while preserving a strict write policy per workflow.

## Workflows

Description workflow:

1. Runs `ollama run` with a description prompt.
2. Normalizes output.
3. Replaces `EXIF:ImageDescription` and `IPTC:Caption-Abstract`.
4. Leaves `EXIF:UserComment` unchanged.

Keywords workflow:

1. Reads `IPTC:Keywords`.
2. Skips files where keywords are already populated.
3. Runs `ollama run` with a keyword prompt.
4. Parses model output into keyword values.
5. Writes `IPTC:Keywords` when originally empty.

## Workflow Selection Rules

- Workflows are mutually exclusive.
- Use at most one of:
  - `--description` (default if neither flag is passed)
  - `--keywords`

## Input Modes

Exactly one input mode is used:

- directory scan (default): current directory or provided `DIRECTORY`
- single file: `--file <path>`
- list file: `--list <path>` (one file path per line)

Rules:

- `--file` and `--list` cannot be used together.
- `DIRECTORY` cannot be combined with `--file` or `--list`.
- `--recursive` is relevant only for directory mode.

## Prompt Selection

Each workflow has a built-in fallback prompt plus a default prompt file:

- Description: `scripts/annotate_photos_with_ollama.prompts.txt`
- Keywords: `scripts/annotate_photos_with_ollama.keywords.prompts.txt`

Prompt file format:

- One prompt per line: `<integer>|<prompt text>`
- Example: `1|Describe the image...`

Prompt options (apply to the active workflow):

- `--list-prompts`: list prompts from the active workflow prompt file and exit.
- `--prompt-id <id>`: choose a prompt by integer ID.
- `--prompt-id 0`: force built-in fallback prompt.
- `--prompt-file <path>`: use a custom prompt file for the active workflow.

## Requirements

- Bash
- `ollama`
- `exiftool`
- `find`

## Usage

Description workflow (default), recursive:

```bash
./scripts/annotate_photos_with_ollama.sh -r /photos/archive
```

Keywords workflow, recursive:

```bash
./scripts/annotate_photos_with_ollama.sh --keywords -r /photos/archive
```

Keywords workflow with prompt ID 1:

```bash
./scripts/annotate_photos_with_ollama.sh --keywords --prompt-id 1 -r /photos/archive
```

List prompts for keywords workflow:

```bash
./scripts/annotate_photos_with_ollama.sh --keywords --list-prompts
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

## Sample Output

Here's a sample contact sheet generated using the `./scripts/contact_sheet.sh` script after running `annotate_photos_with_ollama.sh` in description mode.

![](https://raw.githubusercontent.com/igoros777/photoshell/main/images/proof_dark.jpg)

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
- Description mode overwrites `EXIF:ImageDescription` and `IPTC:Caption-Abstract`.
- Keywords mode writes `IPTC:Keywords` only when the field is empty, and skips already-populated files.
- `EXIF:UserComment` is intentionally left unchanged by this script.
- Test on a copy first if you need a reversible workflow.
