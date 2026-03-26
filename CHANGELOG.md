# Changelog

## 1.6.0 — 2026-03-25

### Set GPS Location
- New `gps_set_location.sh` geocodes a place name via Geocod.io and writes GPS coordinates to every matching photo
- Randomized spread: distribute coordinates naturally within a radius — choose miles, km, yards, or meters
- Skips files that already have GPS by default, `--force` to overwrite
- Recursive scanning with file type filtering
- New "Set GPS Location" workflow step in the UI with location input, spread radius + unit, and force overwrite toggle

## 1.5.0 — 2026-03-23

### Photo Catalog
- New `catalog_build.sh` script indexes EXIF/IPTC metadata from large photo collections into SQLite for instant searching
- Supports file type filtering, directory depth limits, filename and folder name glob patterns, and parallel exiftool workers with configurable batch size
- Four modes: build (full scan), update (incremental — only new files), prune (remove entries for deleted files), stats (show catalog summary)
- New "Catalog" tab in the Search panel with build/update/prune/remove buttons, collapsible build options, and a real-time progress bar
- Structured search with Discover Fields: numeric ranges, date pickers, camera model/file type checkboxes, keyword and caption search — same layout as the Structured search tab
- Free-text quick search across all indexed fields (filename, camera, lens, keywords, caption, location)
- Detects existing subcatalogs in subdirectories before building and lets you skip them to avoid duplicates
- Clickable search result thumbnails open the full preview modal with metadata footer

### EXIF/IPTC Viewer
- Photo preview modal now has EXIF and IPTC buttons that display the full metadata in a scrollable table
- Shows all fields returned by exiftool, sorted alphabetically with monospace field names

### Preview Modal Enhancements
- Rotate button rotates the image counterclockwise in 90° increments, auto-scaling to fit the container
- Download button serves the original full-resolution file
- Title shows filename, full path displayed in quotes below the image
- Catalog search result thumbnails load eagerly with 3-page ahead prefetch

### Search Improvements
- Text search launches with Enter key from the query field
- Elapsed time indicator on the Search button during text search ("Searching... 12s")
- Structured and text search results now render inline within their own tab panes

## 1.4.0 — 2026-03-22

### Annotate Headline
- New `--headline` workflow generates short headlines via Ollama and writes them to the IPTC Headline metadata field
- Three built-in prompts: newspaper caption style (8 words max), and two Adobe Stock-optimized title prompts (natural phrases under 70 characters, focused on subject, setting, and mood)
- Skips files where the headline is already populated — same safe-write pattern as keywords

### Blur Detection Performance
- Blur detection runs 4-8x faster with parallel scoring via `xargs -P $(nproc)`
- Batch exiftool replaces per-file `identify` calls for date extraction (~50x faster)
- Pre-generated thumbnail cache in `/dev/shm` for visual delta comparison
- New `-j/--jobs` flag to control parallel worker count
- Blur detection now supports 18 image formats including RAW (DNG, NEF, CR2, ARW, etc.)

### Security
- Fixed all 29 CodeQL path injection and command line injection alerts with `_sanitize_dir_path()` and `_sanitize_path()` on all new endpoints

### UI Improvements
- Clicking a sidebar workflow step again closes its configuration panel
- Clicking outside the inspector panel closes it
- New "Reset" button resets all workflow settings to defaults
- Blur comparison slider now loads full-resolution images (2400px) instead of tiny previews
- Scene navigation uses a dropdown + prev/next arrows instead of overflowing button rows

## 1.3.0 — 2026-03-22

### Photo Browsing
- Photo thumbnail grid with lazy loading via IntersectionObserver and "Load more" pagination — browse your photos visually after selecting a folder
- Click any thumbnail to open a full-size preview modal with filename
- Content view tabs let you switch between Thumbnails, Map, and Blur Comparison views

### GPS Map
- Interactive Leaflet.js map with clustered markers — see where your photos were taken at a glance
- Markers colored by camera model so you can see which device shot what
- Click any marker for a popup with thumbnail, filename, date, and camera info
- CartoDB Dark Matter tiles match the DaVinci Resolve dark theme (vendored for offline use)
- GPS coverage banner shows "N of M photos have GPS coordinates"

### Blur Comparison
- Before/after slider comparing the blurriest and sharpest photos from each scene — drag the handle to reveal the difference
- Scene navigation buttons when blur detection found multiple scenes
- Filmstrip with blur score badges on each thumbnail — click any to compare against the sharpest

### Streaming Logs
- Offset-based log polling sends only new content instead of the entire log on each poll
- Line numbers on every log line with step headers highlighted in accent color
- Scroll lock indicator when you scroll up — click to resume auto-scroll

### Metadata Panel
- Camera model breakdown showing which cameras were used and how many photos each took
- Date range display (earliest to latest photo date)

### Workflow Presets
- Save your current workflow configuration as a named preset and reload it later
- Presets stored as JSON files in `.photoshell/presets/`, named with `[a-zA-Z0-9_-]`
- Sidebar dropdown to select, save, and delete presets

### Undo / Revert
- One-click undo restores metadata from exiftool `_original` backup files
- Undo button appears in the sidebar when backup files exist in the current folder
- Operations logged to `.photoshell/operations.jsonl`

### Multi-Folder Project Mode
- Select a parent folder and PhotoShell auto-detects subfolders containing photos
- Runs the full pipeline across all subfolders sequentially — skip failed folders and continue with the rest
- Per-folder status tracking in job log output

### Drag-and-Drop
- Drop a folder from your file manager onto the UI to set the photo directory
- Full-page overlay with dashed accent border appears while dragging

### Testing
- 24 new integration tests covering all Flask API endpoints (browse, validate, photos, presets, undo, blur, GPS, run, status, log)
- Total test count: 81 passing

## 1.2.0 — 2026-03-20

### Structured Search
- Search photos by EXIF/IPTC field values: numeric ranges (aperture, focal length, ISO, exposure), date ranges, camera model, lens model, file type, keywords, and captions
- Field discovery scans a sample of photos to detect available fields, value ranges, and camera models — with stratified sampling across file types and parallel exiftool for speed
- PCRE regex support for filename, caption, and keyword searches (e.g., `IMG_\d{4}`, space-separated keyword terms with all-must-match logic)
- Tabbed search UI: "Structured" tab for field-based queries, "Text Search" tab for the original grep-style search
- Paginated results (50 per page) with Previous/Next navigation — handles thousands of matches without overloading the browser
- Thumbnail prefetching: current page loads eagerly, next 3 pages preload in the background
- Cancel button for long-running searches with elapsed time indicator
- Auto-recursive: discovers photos in subfolders when the selected folder has none at the top level

### Performance
- Parallel exiftool: structured search splits files across multiple exiftool processes (up to 8 workers) for ~4-6x speedup on multi-core systems
- Parallel directory scanning: 8-thread BFS for recursive file listing
- Tiered thumbnail strategy: embedded JPEG for grid (fast), camera preview for modal (sharp), direct serve for small JPEGs

### Security
- Fixed all 20 CodeQL "Uncontrolled data used in path expression" alerts with path sanitization layer (`_sanitize_path`, `_sanitize_file_path`, `_sanitize_dir_path`)
- Fixed "Uncontrolled command line" alert: file paths passed via stdin (`-@ -`) instead of command line arguments
- Flask debug mode disabled on network interfaces (only enabled on localhost)
- Added PR template and Code of Conduct for GitHub Community Standards

### Bug Fixes
- Photo preview modal no longer flashes the previous image while loading — shows a spinner until the new image is ready
- Image cleared from memory when preview modal closes

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
