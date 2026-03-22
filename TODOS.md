# TODOs

## Open

(none)

## Completed

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
