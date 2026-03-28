# TODOs

## Open

(none)

## Completed

### AI Search
**Completed:** v1.7.0 (2026-03-27)
New AI Search tab in the Search panel. Ollama converts free-form queries into search keywords + synonyms, then SQL matches them against catalog text fields (ImageDescription, UserComment, Caption, Headline, Keywords, location). Four search modes with prompt templates. Two-phase architecture: one LLM call + instant SQL scoring.

### Sidebar Step Groups
**Completed:** v1.7.0 (2026-03-27)
16 workflow steps organized into 5 logical groups (Ingest & Prepare, AI Annotate & Audit, Organize & Cull, Edit Metadata, Finalize) with thin rounded outlines and section labels. Consistency Audit moved into the AI group. Step order updated in backend and frontend.

### Catalog Schema Expansion
**Completed:** v1.7.0 (2026-03-27)
`catalog_build.sh` now indexes `ImageDescription` and `UserComment` EXIF fields. All catalog queries use `PRAGMA table_info` to detect available columns dynamically — older catalogs work without rebuilding.

### Photo Catalog (SQLite)
**Completed:** v1.5.0 (2026-03-23)
`catalog_build.sh` indexes EXIF/IPTC into SQLite with parallel exiftool workers. Catalog tab in UI with build/update/prune/remove, structured filters (Discover Fields), free-text search, progress bar, subcatalog detection.

### EXIF/IPTC Metadata Viewer
**Completed:** v1.5.0 (2026-03-23)
EXIF and IPTC buttons in photo preview modal display full metadata in a scrollable table. Full file path in modal title.

### Annotate Headline Workflow
**Completed:** v1.4.0 (2026-03-22)
New `--headline` workflow in `annotate_photos_with_ollama.sh` generates IPTC Headline via Ollama. Three prompts: newspaper caption, two Adobe Stock title variants.

### Blur Detection Performance
**Completed:** v1.4.0 (2026-03-22)
Parallel blur scoring (4-8x speedup), batch exiftool for dates (~50x), pre-generated thumbnail cache in `/dev/shm`, 18 image formats including RAW.

### CodeQL Security Fixes (v1.4.0)
**Completed:** v1.4.0 (2026-03-22)
Fixed all 29 path injection and command line injection alerts with `_sanitize_dir_path()` and `_sanitize_path()` on all new endpoints.

### UI Improvements (v1.4.0)
**Completed:** v1.4.0 (2026-03-22)
Inspector panel toggle on re-click and outside click, Reset button, high-res blur comparison (2400px), scene navigation dropdown.

### Phase 3: Thumbnails, Streaming Logs, Metadata Panel
**Completed:** v1.3.0 (2026-03-22)
Photo thumbnail grid with lazy loading and pagination, offset-based streaming log with line numbers and scroll lock, metadata panel with camera breakdown and date range.

### Phase 4: Map View, Pipeline Flowchart, Blur Before/After
**Completed:** v1.3.0 (2026-03-22)
Leaflet.js GPS map with clustered markers colored by camera model (CartoDB dark tiles), CSS clip-path blur before/after slider with scene filmstrip, content view tabs, pipeline strip pending icons.

### Workflow Presets
**Completed:** v1.3.0 (2026-03-22)
Save/load/delete workflow presets as JSON in `.photoshell/presets/`. Sidebar dropdown with save and delete buttons. Names sanitized to `[a-zA-Z0-9_-]`.

### Undo/Revert for Destructive Operations
**Completed:** v1.3.0 (2026-03-22)
Restore metadata from exiftool `_original` backup files via `/api/undo`. Undo button in sidebar, enabled when backups exist. Operations logged to `.photoshell/operations.jsonl`.

### Multi-Folder Project Mode
**Completed:** v1.3.0 (2026-03-22)
Auto-detect subfolders with photos during validation. Per-folder sequential pipeline execution, skip failed folders and continue. Per-folder status in job data.

### Drag-and-Drop Folder Selection
**Completed:** v1.3.0 (2026-03-22)
Full-page overlay on folder drag with dashed accent border. Extracts path from dropped items, populates folder input, triggers validation.

### Integration Tests for Flask Endpoints
**Completed:** v1.3.0 (2026-03-22)
24 pytest tests covering all API endpoints (index, browse, validate_folder, photos, presets CRUD, undo check, blur_results, gps_data, run, status, log). Total: 81 tests passing.

### Advanced Structured Search
**Completed:** v1.2.0 (2026-03-20)
Field discovery, numeric/date range filters, PCRE regex, parallel exiftool, paginated results with thumbnail prefetching.

### CodeQL Security Fixes
**Completed:** v1.2.0 (2026-03-20)
Fixed 20 path expression alerts, 1 command line alert, disabled debug mode on network interfaces.

### Phase 1: Stability, Security, and Performance Hardening
**Completed:** v1.0.0 (2026-03-19)
Batched exiftool calls, fixed command injection, XSS, CSRF protection, rate limiting, structured logging, script execution timeout, job TTL cleanup, bash script hardening.

### Phase 2: Visual Polish — DaVinci Resolve Aesthetic
**Completed:** v1.0.0 (2026-03-19)
Sidebar + inspector layout, new color palette (warm amber accent), Inter + JetBrains Mono typography, pipeline visualization, keyboard shortcuts, mobile responsive layout.

### Ollama Server Health Check and Vision Model Discovery
**Completed:** v1.0.0 (2026-03-19)
Preflight validates ollama serve is running. Model dropdown auto-discovers installed models and flags vision-capable ones.

### Prompt Selector with Preview, Editing, and Save-to-File
**Completed:** v1.0.0 (2026-03-19)
Dropdown showing all prompts with preview text. Textarea for full prompt display. Edit + save-to-file for persistent changes.

### DRY: Shared Constants
**Completed:** v1.0.0 (2026-03-19)
Extracted PHOTO_EXTENSIONS, STEP_LABELS, STEP_TOOL_DEPS to constants.py.
