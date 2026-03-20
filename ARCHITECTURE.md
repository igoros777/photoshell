# Architecture

PhotoShell is a local-first photo workflow toolkit. It has two layers: a set of standalone Bash scripts for metadata processing, and an optional Flask web UI that orchestrates those scripts.

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                       Browser                                │
│  index.html + app.js + map.js + pipeline.js + ...            │
│  (vanilla JS, no framework, Bootstrap 5.3 dark theme)        │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP (JSON)
┌──────────────────────────▼──────────────────────────────────┐
│                    Flask (app.py)                             │
│                                                              │
│  /api/run         → builds pipeline, spawns bash scripts     │
│  /api/status      → streams job log via polling              │
│  /api/browse      → filesystem navigation for folder picker  │
│  /api/validate    → checks directory exists + photo count    │
│  /api/folder_meta → exiftool metadata scan (GPS, captions)   │
│  /api/advisory    → pre-flight checks (GPS coverage, etc.)   │
│  /api/preflight   → tool dependency check (exiftool, etc.)   │
│  /api/ollama_models → lists installed models + vision flag   │
│  /api/prompts     → CRUD for annotation prompt templates     │
│  /api/search      → standalone EXIF/IPTC metadata search     │
│  /api/search_meta → batch metadata for search result files   │
│  /api/thumbnail   → in-memory thumbnail generation           │
│  /api/backup      → estimate + run .tar.gz archive           │
│  /api/docs        → serves markdown docs for in-app reading  │
│                                                              │
│  constants.py         → shared PHOTO_EXTENSIONS, labels      │
│  advisory_checks.py   → metadata pre-flight logic            │
│                                                              │
│  In-memory: jobs{} (with TTL cleanup)                        │
│  On-disk:   .photoshell/ (future: presets, undo log, cache)  │
└──────────────────────────┬──────────────────────────────────┘
                           │ subprocess.Popen (list args, no shell)
┌──────────────────────────▼──────────────────────────────────┐
│                   Bash Scripts (13)                           │
│                                                              │
│  gps_gap_fill.sh          extract_photo_summary.sh           │
│  detect_blurry_photos.sh  annotate_photos_with_ollama.sh     │
│  geo_rename_photos.sh     gopro_geo_rename.sh                │
│  contact_sheet.sh         sync_exif_and_rename.sh            │
│  search_exif_iptc.sh      scrub_selected_metadata.sh         │
│  photofolders.sh          backup_folder.sh                   │
│  photofolders.config.sh                                      │
└──────────────────────────┬──────────────────────────────────┘
                           │ CLI tools
┌──────────────────────────▼──────────────────────────────────┐
│  exiftool  │  ImageMagick  │  Ollama  │  curl/jq  │  tar    │
└─────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

**Local-first, no cloud.** Everything runs on the user's machine. The only external service is the optional Geocod.io API for reverse geocoding. Ollama runs locally.

**Bash scripts as the processing engine.** Each script is standalone — it works from the command line without the web UI. The UI orchestrates scripts but never replaces them. This means the CLI and UI always have feature parity.

**No shell interpolation in subprocess calls.** The Flask app passes user input as list arguments to `subprocess.Popen`, never through `bash -c` with string interpolation. This eliminates command injection.

**Single-threaded job execution.** One pipeline runs at a time per job. Steps execute sequentially within a pipeline. This avoids race conditions on photo files.

**In-memory job store with TTL.** Jobs are stored in a Python dict with a threading lock. Completed jobs are cleaned up after 1 hour. No database needed for a local tool.

## Directory Structure

```
photoshell/
├── scripts/                    # Standalone bash processing scripts
│   ├── *.sh                    # One script per workflow step
│   ├── *.config.sh             # Folder scaffold configuration
│   └── *.prompts.txt           # Ollama prompt templates
├── ui/flask/                   # Web UI (optional)
│   ├── app.py                  # Flask application + API routes
│   ├── requirements.txt        # Python dependencies (flask>=3.0)
│   ├── functions/
│   │   ├── constants.py        # Shared constants (extensions, labels)
│   │   └── advisory_checks.py  # Pre-flight metadata validation
│   ├── templates/
│   │   └── index.html          # Single-page application
│   └── static/
│       ├── css/style.css       # DaVinci Resolve-inspired theme
│       └── js/app.js           # Frontend logic (vanilla JS)
├── docs/                       # Per-script documentation (markdown)
├── images/                     # README screenshots
├── DESIGN.md                   # Design system specification
├── README.md                   # User-facing documentation
└── CHANGELOG.md                # Release history
```

## Security Model

- **CSRF:** Origin/Referer header validation on all POST/PUT/DELETE requests
- **Rate limiting:** 120 requests/minute per IP (in-memory, cleaned on idle)
- **Path traversal:** All file-serving endpoints validate paths stay within the project directory
- **XSS:** User-derived content inserted via `textContent`/`createElement`, never `innerHTML`
- **Error sanitization:** Full errors logged server-side, generic messages returned to clients
- **Subprocess safety:** All commands use list args (`["bash", script, arg]`), never shell strings
