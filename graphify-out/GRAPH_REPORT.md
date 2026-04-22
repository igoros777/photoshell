# Graph Report - .  (2026-04-07)

## Corpus Check
- Large corpus: 80 files · ~1,039,303 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder, or use --no-semantic to run AST-only.

## Summary
- 820 nodes · 1183 edges · 50 communities detected
- Extraction: 68% EXTRACTED · 32% INFERRED · 0% AMBIGUOUS · INFERRED: 381 edges (avg confidence: 0.54)
- Token cost: 0 input · 0 output

## God Nodes (most connected - your core abstractions)
1. `_sanitize_dir_path()` - 28 edges
2. `_resolve_directory()` - 24 edges
3. `PhotoShell Web UI help` - 16 edges
4. `validateFolder()` - 15 edges
5. `escapeHtml()` - 15 edges
6. `Changelog v1.7.0` - 15 edges
7. `PhotoShell Design System` - 13 edges
8. `metadata_consistency.sh documentation` - 12 edges
9. `_list_photo_files()` - 11 edges
10. `_run_exiftool_json()` - 10 edges

## Surprising Connections (you probably didn't know these)
- `ui/flask/static/favicon.svg` --conceptually_related_to--> `PhotoShell Web UI help`  [INFERRED]
  ui/flask/static/favicon.svg → docs/web_ui_help.md
- `Description workflow (IPTC:Caption-Abstract)` --semantically_similar_to--> `Consistency Audit (Ollama)`  [INFERRED] [semantically similar]
  docs/annotate_photos_with_ollama.md → CHANGELOG.md
- `Contributor Covenant CoC v2.0` --conceptually_related_to--> `Contributing Guide`  [INFERRED]
  CODE_OF_CONDUCT.md → CONTRIBUTING.md
- `metadata_consistency.sh` --references--> `metadata_consistency.sh documentation`  [INFERRED]
  scripts/metadata_consistency.prompts.txt → docs/metadata_consistency.md
- `Metadata consistency audit prompts (4 variants)` --references--> `IPTC Caption-Abstract field`  [INFERRED]
  scripts/metadata_consistency.prompts.txt → docs/metadata_consistency.md

## Hyperedges (group relationships)
- **Back From A Trip Workflow Pipeline** — readme_script_photofolders, doc_gps_gap_fill, doc_detect_blurry, doc_extract_photo_summary, doc_annotate_ollama, doc_contact_sheet, doc_geo_rename, doc_gopro_geo_rename [EXTRACTED 1.00]
- **EXIF/IPTC Field Ownership Separation** — doc_summary_exif_only_rationale, doc_annotate_iptc_only_rationale, changelog_exif_iptc_field_ownership, doc_extract_photo_summary, doc_annotate_ollama [EXTRACTED 1.00]
- **Three-Tier PhotoShell Architecture** — architecture_browser_frontend, architecture_flask_app, architecture_bash_scripts_layer, architecture_cli_tools [EXTRACTED 1.00]
- **Ollama annotation prompt family (description, keywords, headline)** — annotate_description_prompts, annotate_keywords_prompts, annotate_headline_prompts, annotate_photos_with_ollama_sh [INFERRED 0.90]
- **photofolders scaffold system (script + config + doc, Windows + Linux)** — photofolders_bat_script, photofolders_sh_script, photofolders_config_cmd, photofolders_config_sh, photofolders_doc, photofolders_config_doc [EXTRACTED 1.00]
- **Five workflow groups forming the web UI pipeline** — web_ui_pipeline_groups, web_ui_ollama_integration, web_ui_undo, web_ui_presets, web_ui_multi_folder [EXTRACTED 1.00]
- **PhotoShell Quick Start Guide Workflow Sequence** — qsg_01_main_screen, qsg_02_validated_screen, qsg_03_map_screen, qsg_04_preview_screen, qsg_05_exif_screen, qsg_06_catalog_screen [INFERRED 0.85]
- **Sidebar Workflow Control Cluster** — qsg_ui_sidebar, qsg_ui_workflow_steps, qsg_ui_run_pipeline_button, qsg_ui_target_folder_input [EXTRACTED 1.00]
- **Photo Inspection UI (Preview + EXIF)** — qsg_04_preview_screen, qsg_05_exif_screen, qsg_ui_preview_modal, qsg_ui_exif_iptc_toggle [EXTRACTED 1.00]

## Communities

### Community 0 - "Flask App Endpoints"
Cohesion: 0.02
Nodes (144): addCatalogFilterField(), _aiSearchCheckCatalog(), api_author_profiles(), api_author_profiles_delete(), api_author_profiles_save(), api_docs(), api_env_check(), api_log() (+136 more)

### Community 1 - "Structured Search Tests"
Cohesion: 0.02
Nodes (32): Tests for the structured metadata search module., Test apply_filters with range operator on date fields., Filters can use different date format than the record values., Test apply_filters with eq (exact match) operator., Test apply_filters with contains (substring) operator., Test apply_filters with in operator., Test field type classification., Test that records with missing fields are excluded. (+24 more)

### Community 2 - "Leaflet Vendor Bundle"
Cohesion: 0.05
Nodes (56): a(), Ae(), ai(), at(), be(), bi(), c(), Ci() (+48 more)

### Community 3 - "Flask API Routes"
Cohesion: 0.04
Nodes (71): api_advisory(), api_ai_search(), api_backup_run(), api_blur_results(), api_browse(), api_browse_debug(), api_catalog_build(), api_catalog_discover() (+63 more)

### Community 4 - "AI Prompts and CEO Vision"
Cohesion: 0.04
Nodes (69): AI search prompt set (general/mood/subject/location), ai_search.sh, Description annotation prompt (concise scene description), Headline annotation prompts (newspaper + Adobe Stock), Keywords annotation prompt (8-15 search keywords), annotate_photos_with_ollama.sh, 10x local-first photo platform vision, Phased Monolith architecture decision (+61 more)

### Community 5 - "System Architecture"
Cohesion: 0.05
Nodes (47): advisory_checks.py, Bash scripts as processing engine (CLI/UI parity), Bash Scripts Processing Layer, Browser Frontend (vanilla JS), catalog.py (SQLite catalog), constants.py (shared constants), Flask App (app.py), In-memory job store with TTL (+39 more)

### Community 6 - "Structured Search Engine"
Cohesion: 0.07
Nodes (39): apply_filters(), _check_contains(), _check_eq(), _check_filter(), _check_in(), _check_keywords_all(), _check_range(), _check_regex() (+31 more)

### Community 7 - "Flask Endpoint Tests"
Cohesion: 0.06
Nodes (11): Integration tests for PhotoShell Flask API endpoints., TestBlurResults, TestBrowse, TestGpsData, TestIndex, TestLog, TestPhotos, TestPresets (+3 more)

### Community 8 - "Advisory Checks"
Cohesion: 0.11
Nodes (34): check_blurry_output_exists(), check_contact_sheet_exists(), check_description_already_done(), check_geo_rename_done(), check_gps_coverage(), check_keywords_already_done(), check_no_photos(), check_raw_files_for_ai() (+26 more)

### Community 9 - "Photo Workflow Docs"
Cohesion: 0.09
Nodes (35): External CLI Tools (exiftool, ImageMagick, Ollama, curl/jq, tar), EXIF/IPTC Field Ownership separation, Headline workflow (IPTC:Headline), AI metadata stays in IPTC only, Keywords workflow (IPTC:Keywords), annotate_photos_with_ollama.sh doc, Scene split by time gap + visual similarity, contact_sheet.sh doc (+27 more)

### Community 10 - "Flask File and Preset APIs"
Cohesion: 0.11
Nodes (18): api_download(), api_file_metadata(), api_presets_delete(), api_presets_get(), api_presets_save(), api_search_meta(), api_thumbnail(), Validate and sanitize a user-supplied path for safe filesystem access.      - No (+10 more)

### Community 11 - "SQLite Photo Catalog"
Cohesion: 0.12
Nodes (17): catalog_discover(), catalog_exists(), catalog_lookup_files(), catalog_remove(), catalog_search(), catalog_stats(), catalog_text_metadata(), get_catalog_path() (+9 more)

### Community 12 - "QSG UI Screenshots"
Cohesion: 0.14
Nodes (18): PhotoShell Main View (Empty State), PhotoShell Validated Folder with Thumbnails, PhotoShell Map View (Geolocation), PhotoShell Full-Size Photo Preview, PhotoShell EXIF/IPTC Viewer Modal, PhotoShell Catalog Panel, Catalog Build/Update/Prune/Remove Actions, EXIF / IPTC Toggle Buttons (+10 more)

### Community 13 - "Keywords Filter Tests"
Cohesion: 0.22
Nodes (2): Test the 'keywords_all' filter (space-separated, all must match, regex)., TestApplyFiltersKeywordsAll

### Community 14 - "Pipeline Runner"
Cohesion: 0.25
Nodes (8): Run one pipeline step, streaming output into the job log., Execute a sequence of steps; stop on first failure., Execute a single search step., Execute the backup step., _run_backup(), _run_pipeline(), _run_search(), _run_step()

### Community 15 - "Contact and Proof Sheets"
Cohesion: 0.32
Nodes (8): Per-Thumbnail Caption Metadata Block, Landscape Photo Thumbnail Grid, PhotoShell Contact Sheet Output, AI-Generated Scene Descriptions, Blue Ridge Parkway / Appalachian Scenes, EXIF Caption Strip (Camera, Lens, ISO, Shutter, Aperture), Nikon Z9 + Tamron 18-300mm Sample Frames, PhotoShell Dark Proof Sheet Output

### Community 16 - "Pytest Fixtures"
Cohesion: 0.29
Nodes (5): empty_dir(), photo_dir(), Shared pytest fixtures for PhotoShell tests., Temporary directory with a few fake photo files., Temporary empty directory.

### Community 17 - "Directory Browser"
Cohesion: 0.33
Nodes (6): _browse_directory(), _is_filesystem_root(), _parent_directory(), Return True when the path is a filesystem root on the current platform., Return the parent directory, or None when already at a root., Return the directory payload expected by the folder browser.

### Community 18 - "Backup Sizing"
Cohesion: 0.33
Nodes (6): api_backup_estimate(), _dir_size(), _human_size(), Calculate total size in bytes and file/dir counts., Format bytes into a human-readable string., Estimate backup size and available space at the destination.

### Community 19 - "Prompt File Parser"
Cohesion: 0.33
Nodes (6): api_prompts(), api_prompts_save(), _parse_prompts_file(), Parse a prompts file. Returns list of {id, text}., Return all prompts for a workflow (description or keywords).      Includes the b, Save a new or updated prompt to the prompts file.

### Community 20 - "Photofolders Config Reader"
Cohesion: 0.5
Nodes (4): api_photofolders_config(), _parse_photofolders_config(), Parse a photofolders.config.sh file into structured JSON., Read the photofolders config file and return structured JSON.

### Community 21 - "Photofolders Config Writer"
Cohesion: 0.5
Nodes (4): api_photofolders_config_save(), Write structured JSON back to a photofolders.config.sh file., Save equipment customization to a config file., _write_photofolders_config()

### Community 22 - "Leaflet Marker Icons"
Cohesion: 0.67
Nodes (3): Leaflet Marker Icon, Leaflet Marker Icon (2x), Leaflet Marker Shadow

### Community 23 - "Shared Constants"
Cohesion: 1.0
Nodes (1): Shared constants for the PhotoShell Flask UI.

### Community 24 - "Subprocess Security"
Cohesion: 1.0
Nodes (2): No shell interpolation in subprocess calls, Security Model (CSRF, rate limit, path traversal, XSS, error sanitization, subprocess safety)

### Community 25 - "Misc Helpers 25"
Cohesion: 1.0
Nodes (2): Leaflet Layers Toggle Icon, Leaflet Layers Toggle Icon (2x)

### Community 26 - "Misc Helpers 26"
Cohesion: 1.0
Nodes (2): Photographer Desk Collage with Camera and Laptop, Laptop and SLR Camera on Cluttered Desk

### Community 27 - "Misc Helpers 27"
Cohesion: 1.0
Nodes (2): Travel Photographer Workstation with Postcards, Travel Photo Editing Scene with Laptop and Prints

### Community 28 - "Misc Helpers 28"
Cohesion: 1.0
Nodes (2): Canon Camera and Laptop Desk Collage, Warm Light Desk with Camera and Photos

### Community 29 - "Misc Helpers 29"
Cohesion: 1.0
Nodes (2): PhotoShell Turtle Mascot Logo, PhotoShell Turtle Mascot Logo Variant

### Community 30 - "Misc Helpers 30"
Cohesion: 1.0
Nodes (2): Whiskey Glass and Camera on Desk Collage, Desk with Tea Laptop and Camera Collage

### Community 31 - "Misc Helpers 31"
Cohesion: 1.0
Nodes (2): Morning Workstation with Prints and Camera, Laptop Camera and Glasses on Desk

### Community 32 - "Misc Helpers 32"
Cohesion: 1.0
Nodes (2): Pentax Camera on Desk with Laptop, Sunlit Desk with Camera and Laptop

### Community 33 - "Misc Helpers 33"
Cohesion: 1.0
Nodes (2): Window Desk with Photo Prints and Laptop, Cubist Desk Scene with Laptop and Camera

### Community 34 - "Misc Helpers 34"
Cohesion: 1.0
Nodes (2): Camera Laptop and Print Photos Workspace, DSLR with Laptop Reviewing Travel Prints

### Community 35 - "Misc Helpers 35"
Cohesion: 1.0
Nodes (2): PhotoShell UI Screenshot Thumbnails View, PhotoShell UI Screenshot Map View

### Community 36 - "Misc Helpers 36"
Cohesion: 1.0
Nodes (1): Every file extension type should be represented in the sample.

### Community 37 - "Misc Helpers 37"
Cohesion: 1.0
Nodes (1): Even a single file with a unique extension should be sampled.

### Community 38 - "Misc Helpers 38"
Cohesion: 1.0
Nodes (1): When total < sample_size, return all without sampling.

### Community 39 - "Misc Helpers 39"
Cohesion: 1.0
Nodes (1): Samples should be evenly spaced, not clustered at start/end.

### Community 40 - "Misc Helpers 40"
Cohesion: 1.0
Nodes (0): 

### Community 41 - "Misc Helpers 41"
Cohesion: 1.0
Nodes (0): 

### Community 42 - "Misc Helpers 42"
Cohesion: 1.0
Nodes (1): scripts/scrub_selected_metadata.sh

### Community 43 - "Misc Helpers 43"
Cohesion: 1.0
Nodes (1): scripts/backup_folder.sh

### Community 44 - "Misc Helpers 44"
Cohesion: 1.0
Nodes (1): scripts/catalog_build.sh

### Community 45 - "Misc Helpers 45"
Cohesion: 1.0
Nodes (1): scripts/metadata_replace.sh

### Community 46 - "Misc Helpers 46"
Cohesion: 1.0
Nodes (1): scripts/metadata_copyright.sh

### Community 47 - "Misc Helpers 47"
Cohesion: 1.0
Nodes (1): scripts/metadata_consistency.sh

### Community 48 - "Misc Helpers 48"
Cohesion: 1.0
Nodes (1): scripts/stock_compliance.sh

### Community 49 - "Misc Helpers 49"
Cohesion: 1.0
Nodes (1): Autumn Bridge Over River Landscape

## Knowledge Gaps
- **274 isolated node(s):** `Shared pytest fixtures for PhotoShell tests.`, `Temporary directory with a few fake photo files.`, `Temporary empty directory.`, `Integration tests for PhotoShell Flask API endpoints.`, `Tests for the structured metadata search module.` (+269 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Shared Constants`** (2 nodes): `constants.py`, `Shared constants for the PhotoShell Flask UI.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Subprocess Security`** (2 nodes): `No shell interpolation in subprocess calls`, `Security Model (CSRF, rate limit, path traversal, XSS, error sanitization, subprocess safety)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 25`** (2 nodes): `Leaflet Layers Toggle Icon`, `Leaflet Layers Toggle Icon (2x)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 26`** (2 nodes): `Photographer Desk Collage with Camera and Laptop`, `Laptop and SLR Camera on Cluttered Desk`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 27`** (2 nodes): `Travel Photographer Workstation with Postcards`, `Travel Photo Editing Scene with Laptop and Prints`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 28`** (2 nodes): `Canon Camera and Laptop Desk Collage`, `Warm Light Desk with Camera and Photos`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 29`** (2 nodes): `PhotoShell Turtle Mascot Logo`, `PhotoShell Turtle Mascot Logo Variant`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 30`** (2 nodes): `Whiskey Glass and Camera on Desk Collage`, `Desk with Tea Laptop and Camera Collage`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 31`** (2 nodes): `Morning Workstation with Prints and Camera`, `Laptop Camera and Glasses on Desk`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 32`** (2 nodes): `Pentax Camera on Desk with Laptop`, `Sunlit Desk with Camera and Laptop`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 33`** (2 nodes): `Window Desk with Photo Prints and Laptop`, `Cubist Desk Scene with Laptop and Camera`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 34`** (2 nodes): `Camera Laptop and Print Photos Workspace`, `DSLR with Laptop Reviewing Travel Prints`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 35`** (2 nodes): `PhotoShell UI Screenshot Thumbnails View`, `PhotoShell UI Screenshot Map View`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 36`** (1 nodes): `Every file extension type should be represented in the sample.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 37`** (1 nodes): `Even a single file with a unique extension should be sampled.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 38`** (1 nodes): `When total < sample_size, return all without sampling.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 39`** (1 nodes): `Samples should be evenly spaced, not clustered at start/end.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 40`** (1 nodes): `__init__.py`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 41`** (1 nodes): `leaflet.markercluster.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 42`** (1 nodes): `scripts/scrub_selected_metadata.sh`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 43`** (1 nodes): `scripts/backup_folder.sh`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 44`** (1 nodes): `scripts/catalog_build.sh`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 45`** (1 nodes): `scripts/metadata_replace.sh`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 46`** (1 nodes): `scripts/metadata_copyright.sh`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 47`** (1 nodes): `scripts/metadata_consistency.sh`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 48`** (1 nodes): `scripts/stock_compliance.sh`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Misc Helpers 49`** (1 nodes): `Autumn Bridge Over River Landscape`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `PhotoShell README` connect `System Architecture` to `Photo Workflow Docs`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._
- **Why does `Changelog v1.7.0` connect `System Architecture` to `Photo Workflow Docs`?**
  _High betweenness centrality (0.003) - this node is a cross-community bridge._
- **Are the 26 inferred relationships involving `_sanitize_dir_path()` (e.g. with `_sanitize_path()` and `api_browse_debug()`) actually correct?**
  _`_sanitize_dir_path()` has 26 INFERRED edges - model-reasoned connections that need verification._
- **Are the 22 inferred relationships involving `_resolve_directory()` (e.g. with `_normalize_browser_path()` and `_fs_op_with_timeout()`) actually correct?**
  _`_resolve_directory()` has 22 INFERRED edges - model-reasoned connections that need verification._
- **Are the 8 inferred relationships involving `PhotoShell Web UI help` (e.g. with `metadata_consistency.sh documentation` and `metadata_copyright.sh documentation`) actually correct?**
  _`PhotoShell Web UI help` has 8 INFERRED edges - model-reasoned connections that need verification._
- **Are the 14 inferred relationships involving `validateFolder()` (e.g. with `setFolderStatus()` and `hideFolderMetaStats()`) actually correct?**
  _`validateFolder()` has 14 INFERRED edges - model-reasoned connections that need verification._
- **Are the 14 inferred relationships involving `escapeHtml()` (e.g. with `updatePipelineStrip()` and `loadFileMetadata()`) actually correct?**
  _`escapeHtml()` has 14 INFERRED edges - model-reasoned connections that need verification._