# TODOs

## Open

### Phase 3: Thumbnails, Streaming Logs, Metadata Panel
Photo thumbnail previews in the folder browser, append-only streaming log output, and a metadata summary panel showing GPS coverage, camera breakdown, and date range. See `docs/designs/full-vision-transformation.md` for the full spec.
- **Priority:** P1
- **Effort:** L (human: ~3 weeks / CC: ~2 hours)
- **Depends on:** Phase 2 (completed)

### Phase 4: Map View, Pipeline Flowchart, Blur Before/After
Leaflet.js GPS map with clustered markers, visual pipeline flowchart with real-time status, and before/after blur comparison slider. See `docs/designs/full-vision-transformation.md` for the full spec.
- **Priority:** P2
- **Effort:** XL (human: ~2 months / CC: ~4 hours)
- **Depends on:** Phase 3

### Workflow Presets
Save and load workflow configurations as named presets (stored as JSON in `.photoshell/presets/`). Dropdown in the sidebar to select a preset and auto-fill all step settings.
- **Priority:** P2
- **Effort:** M (human: ~1 week / CC: ~30 min)

### Undo/Revert for Destructive Operations
Lightweight undo system using exiftool backup files. UI revert button that restores metadata from `_original` files. Operation log in `.photoshell/operations.jsonl`.
- **Priority:** P2
- **Effort:** M (human: ~1 week / CC: ~30 min)

### Multi-Folder Project Mode
Process multiple subfolders (phones, cameras, drones) through the pipeline in sequence. Per-folder progress tracking in the pipeline view. Skip failed folders and continue with others.
- **Priority:** P2
- **Effort:** L (human: ~2 weeks / CC: ~1 hour)
- **Depends on:** Phase 3 pipeline view

### Drag-and-Drop Folder Selection
Drop a folder from the file manager onto the UI to set the photo directory. Browser drag-and-drop API for folder path detection.
- **Priority:** P3
- **Effort:** S (human: ~3 hours / CC: ~15 min)

### Integration Tests for Flask Endpoints
pytest test suite covering all API endpoints — happy path + one error case each. Security tests for path traversal, CSRF, and XSS. Undo system tests.
- **Priority:** P2
- **Effort:** S (human: ~1 day / CC: ~15 min)

## Completed

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
