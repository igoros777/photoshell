# photofolders.bat

`photofolders.bat` creates a repeatable folder scaffold for a photo/video project.

The script logic is intentionally generic. The actual folder model comes from an external config file (`scripts/photofolders.config.cmd` by default).

## Why This Exists

Using a deterministic on-disk structure solves a different problem than a catalog app:

- predictable ingest targets before editing starts
- consistent archive layout across machines and teammates
- easier backups/sync to NAS/cloud because path conventions stay stable
- CLI-friendly workflows (`exiftool`, rename scripts, batch exports) without app lock-in
- portability even if you stop using one specific DAM app

This is not an anti-Lightroom approach. Lightroom is still great for culling/editing/catalog search. The folder scaffold is the storage contract underneath it.

## What It Creates

The script builds:

- `originals/<category>/<equipment>/...` trees from config
- `processed/...` trees from config

With the current default config, categories are:

- `cell_phones`
- `photo_cameras`
- `drones`
- `video_cameras`

## Usage

```bat
scripts\photofolders.bat [project_name] [options]
```

Options:

- `-p, --project NAME`: project name (if omitted, script prompts)
- `-r, --root PATH`: root archive folder
- `-c, --config PATH`: external template config file
- `-n, --dry-run`: print planned folders, do not create
- `-h, --help`: show help

Examples:

```bat
scripts\photofolders.bat "Iceland Trip 2026"
scripts\photofolders.bat --project "Wedding_Boston" --root "D:\Photos"
scripts\photofolders.bat "ClientA" --config "D:\Templates\photofolders.config.cmd"
scripts\photofolders.bat "ClientA" --dry-run
```

## Defaults

Root path lookup order:

1. `--root`
2. `PHOTOSHELL_ROOT`
3. `%USERPROFILE%\Pictures\Photography`

Default config:

- `scripts\photofolders.config.cmd` (same directory as `photofolders.bat`)

## Validation And Safety

Rejected project names:

- empty values
- `.` or `..`
- any value containing `\ / : * ? < > |`

The script only creates directories. It does not move, rename, or delete media.

## Config Format

Configuration is a CMD file that sets variables (`set "NAME=value"`). The script `call`s that file at runtime.

Detailed format reference:

- [`docs/photofolders_config.md`](photofolders_config.md)

## Practical Workflow

Typical flow:

1. Create project skeleton with `photofolders.bat`.
2. Copy camera cards into `originals/...`.
3. Run metadata/rename scripts from this repo.
4. Export derivatives into `processed/...`.
5. Optionally import project into Lightroom/Bridge/C1 using this same structure.
