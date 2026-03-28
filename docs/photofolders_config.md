# photofolders config (CMD + Bash)

This file defines the folder template consumed by:

- `scripts/photofolders.bat` via `scripts/photofolders.config.cmd`
- `scripts/photofolders.sh` via `scripts/photofolders.config.sh`

![](../images/xmjygj1jbywn6ui1ajuxed3rfxm.jpg)

## Purpose

`photofolders` handles argument parsing, validation, and directory creation.

The config file defines:

- which equipment categories exist
- which devices belong to each category
- which original-media subfolders each category gets
- which processed-output folders should exist

This separation keeps operational logic stable while letting you change structure without editing script code.

## File Format

Windows (CMD):

```cmd
set "VARIABLE_NAME=value"
```

Linux (Bash):

```bash
VARIABLE_NAME="value"
```

Recommendations:

- CMD: keep `@echo off` at the top and use `rem` for comments
- Bash: use `#` for comments
- always quote assignments

## Required Variables

You must define all of these.

### 1) Category index

`CFG_CATEGORY_IDS`

- semicolon-separated list of category IDs
- example:

```cmd
set "CFG_CATEGORY_IDS=cell_phones;photo_cameras;drones;video_cameras"
```

### 2) Per-category values

For each `<id>` listed in `CFG_CATEGORY_IDS`, define:

- `CFG_CATEGORY_PATH_<id>`
- `CFG_CATEGORY_EQUIPMENT_<id>`
- `CFG_CATEGORY_SUBFOLDERS_<id>`

Example for `cell_phones`:

```cmd
set "CFG_CATEGORY_PATH_cell_phones=cell_phones"
set "CFG_CATEGORY_EQUIPMENT_cell_phones=iPhone;Pixel"
set "CFG_CATEGORY_SUBFOLDERS_cell_phones=photos;photos\jpg;photos\raw;videos;videos\original;videos\clips"
```

```bash
CFG_CATEGORY_PATH_cell_phones="cell_phones"
CFG_CATEGORY_EQUIPMENT_cell_phones="iPhone;Pixel"
CFG_CATEGORY_SUBFOLDERS_cell_phones="photos;photos/jpg;photos/raw;videos;videos/original;videos/clips"
```

Meaning:

- `CFG_CATEGORY_PATH_<id>`: folder name under `originals\`
- `CFG_CATEGORY_EQUIPMENT_<id>`: device folders created under that category
- `CFG_CATEGORY_SUBFOLDERS_<id>`: folder template created under every device in that category

### 3) Processed folders

`CFG_PROCESSED_SUBFOLDERS`

- semicolon-separated list of paths created under `processed\`
- example:

```cmd
set "CFG_PROCESSED_SUBFOLDERS=photos;photos\working;photos\exports;social;social\instagram;stock;stock\adobe\submitted"
```

```bash
CFG_PROCESSED_SUBFOLDERS="photos;photos/working;photos/exports;social;social/instagram;stock;stock/adobe/submitted"
```

## Delimiter Rules

All list variables use semicolon (`;`) separators.

Important constraints:

- do not use semicolons inside values
- avoid spaces around separators
- nested folder separators:
  - CMD: backslashes (`\`)
  - Bash: forward slashes (`/`)

Good:

```cmd
set "CFG_CATEGORY_EQUIPMENT_drones=DJI;Autel"
```

Avoid:

```cmd
set "CFG_CATEGORY_EQUIPMENT_drones=DJI; Autel"
```

## Path Rules

Folder names/segments should not contain:

```text
\ / : * ? < > |
```

Also avoid:

- empty segments
- `.` or `..`

## How The Script Expands The Config

For each category ID:

1. Create `originals\<CFG_CATEGORY_PATH_id>`.
2. For each equipment name in `CFG_CATEGORY_EQUIPMENT_id`:
3. Create `originals\<category_path>\<equipment>`.
4. For each subfolder in `CFG_CATEGORY_SUBFOLDERS_id`:
5. Create `originals\<category_path>\<equipment>\<subfolder>`.

Then:

1. Create `processed\`.
2. Create each entry in `CFG_PROCESSED_SUBFOLDERS` under `processed\`.

## Full Minimal Example

```cmd
@echo off
set "CFG_CATEGORY_IDS=cell_phones;photo_cameras"

set "CFG_CATEGORY_PATH_cell_phones=phones"
set "CFG_CATEGORY_EQUIPMENT_cell_phones=iPhone"
set "CFG_CATEGORY_SUBFOLDERS_cell_phones=photos;photos\jpg;videos;videos\original"

set "CFG_CATEGORY_PATH_photo_cameras=cameras"
set "CFG_CATEGORY_EQUIPMENT_photo_cameras=Z9"
set "CFG_CATEGORY_SUBFOLDERS_photo_cameras=photos;photos\raw;photos\jpg"

set "CFG_PROCESSED_SUBFOLDERS=photos;photos\working;photos\exports"
```

Run with:

```bat
scripts\photofolders.bat "Demo Project" --config "D:\Templates\my_photofolders.config.cmd" --dry-run
```

```bash
scripts/photofolders.sh "Demo Project" --config "/opt/templates/my_photofolders.config.sh" --dry-run
```

## Security Note

The config file is executed (`call` in CMD / `source` in Bash). Treat it as executable code.

Only use trusted config files.
