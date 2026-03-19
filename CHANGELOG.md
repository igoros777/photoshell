# Changelog

## 1.0.0 — 2026-03-19

First versioned release. PhotoShell has been in active development since February 2026 — this release marks the point where the toolkit is stable, documented, and has a web UI.

### Web UI
- New Flask-based web interface for workflow orchestration (`ui/flask/`)
- Sidebar + inspector layout with DaVinci Resolve-inspired dark aesthetic
- Configure and run all workflow steps from the browser
- Folder browser modal with drive bar, breadcrumb navigation, and path validation
- Pipeline visualization showing step progress in real-time
- Advisory pre-flight checks that warn about missing GPS, existing metadata, ordering issues
- Tool dependency preflight (verifies exiftool, ImageMagick, Ollama, curl, jq are installed)
- Ollama integration: auto-discovers installed models, flags vision-capable models, validates server health
- Prompt management: browse, preview, edit, and save prompts for annotation workflows
- EXIF/IPTC metadata search with folder browsing and validation on directory fields
- Backup with size estimation and disk space check
- Keyboard shortcuts: `R` (run), `Esc` (cancel), `/` (focus path)
- Mobile responsive layout (sidebar stacks on small viewports)
- CSRF protection, rate limiting, structured logging, script execution timeout

### Script Hardening
- Batched exiftool calls in `extract_photo_summary.sh` (20+ per file → 1) and `contact_sheet.sh` (8+ → 1)
- Fixed pipe-to-while subshell variable loss in `gopro_geo_rename.sh`
- Fixed null-terminated tar input in `backup_folder.sh`
- Added collision loop bound (max 1000) in `geo_rename_photos.sh`
- Added mktemp error checking in `detect_blurry_photos.sh`
- Added API key placeholder detection in `extract_photo_summary.sh`
- Cached exiftool reads in `annotate_photos_with_ollama.sh`
- Optimized donor search with early termination in `gps_gap_fill.sh`
- Built upfront originals index in `sync_exif_and_rename.sh` (find-per-file → hash map)

### Security
- Fixed command injection in extract summary step (replaced `bash -c` with `find -exec`)
- Fixed XSS in docs modal (`textContent` instead of `innerHTML` for user data)
- Added Origin/Referer CSRF validation on all state-changing requests
- Added per-IP rate limiting (120 req/min)
- Sanitized error messages returned to clients

### Infrastructure
- Extracted shared constants (`PHOTO_EXTENSIONS`, step labels, tool deps) to `constants.py`
- Added `DESIGN.md` as the project's design system source of truth
- Batched advisory checks exiftool calls (5 process spawns → 1)
- Added job TTL cleanup, script execution timeout, symlink detection in folder browser
