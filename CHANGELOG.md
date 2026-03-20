# Changelog

## 1.1.0 — 2026-03-19

### Search & Discovery
- Search results now display as a thumbnail grid with photo preview modal — click any result to see a larger image with filename, caption, summary, and keywords
- Thumbnails generated in-memory via exiftool embedded JPEG extraction (no temp files)
- Metadata coverage panel now includes Keywords alongside GPS, Caption, and UserComment
- "Scan all" button lets you scan every file in the folder instead of just a sample

### Contact Sheet
- New `--max-per-sheet N` option splits large collections across numbered sheets (e.g., `proof_1.jpg`, `proof_2.jpg`) — UI auto-defaults to 60 for folders with 60+ photos
- Fixed crash on large TIFF files (HDR panoramas, multi-layer edits) with ImageMagick memory limits and first-layer-only reading
- Filename now renders in italic, caption text in normal style, with proper horizontal padding

### Keyboard Shortcuts
- `V` validates the workflow (tool check + advisory + step ordering)
- `?` opens an in-app help modal with full documentation and Mermaid pipeline flowchart
- Completion sounds: ascending chime on success, descending tone on failure

### Bug Fixes
- Fixed form data collection — step settings were silently ignored because config panels moved outside the `<form>` element when clicked in the sidebar
- Fixed step config panels destroyed when navigating between steps (now preserved across clicks)
- Fixed `gps_gap_fill.sh` returning exit code 1 when all photos already have GPS
- Fixed `sync_exif_and_rename.sh` corrupting paths when multiple originals match the same stem (null bytes can't be stored in bash variables)
- Fixed `search_exif_iptc.sh` missing matches due to binary data in exiftool output (`grep -a`)
- Fixed UTF-8 decode crash on Windows-1252 encoded metadata (smart quotes, accented characters)
- Fixed Windows path normalization for thumbnail and search endpoints on WSL
- Added cache-busting to static CSS/JS files to prevent stale browser cache

### Ollama Integration
- Preflight now verifies `ollama serve` is running (not just that the binary exists)
- Model dropdown auto-discovers installed models and flags vision-capable ones
- Prompt selector with preview, inline editing, and save-to-file

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
