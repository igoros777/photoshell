"""Shared constants for the PhotoShell Flask UI."""

# Photo file extensions recognized by the application.
PHOTO_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".heic", ".heif",
    ".webp", ".bmp", ".gif", ".dng", ".nef", ".cr2", ".cr3",
    ".arw", ".orf", ".rw2", ".srw", ".raf", ".pef", ".x3f",
}

# Human-readable labels used in preflight messages.
STEP_PREFLIGHT_LABELS = {
    "enable_sync_exif":       "Sync EXIF & Rename",
    "enable_gps_gap_fill":    "GPS Gap Fill",
    "enable_gps_set_loc":     "Set GPS Location",
    "enable_extract_summary": "Extract Photo Summary",
    "enable_annotate_desc":   "Annotate (Description)",
    "enable_annotate_kw":     "Annotate (Keywords)",
    "enable_annotate_hl":     "Annotate (Headline)",
    "enable_blur":            "Detect Blurry Photos",
    "enable_geo_rename":      "Geo Rename Photos",
    "enable_gopro":           "GoPro Geo Rename",
    "enable_metadata_replace":   "Metadata Replace",
    "enable_metadata_copyright": "Copyright / Creator",
    "enable_metadata_consistency": "Consistency Audit",
    "enable_catalog_update":  "Update Catalog",
    "enable_contact_sheet":   "Contact Sheet",
    "enable_scrub":           "Scrub Metadata",
}

# Maps each step key to the external tools it requires.
STEP_TOOL_DEPS = {
    "enable_sync_exif":       ["exiftool"],
    "enable_gps_gap_fill":    ["exiftool"],
    "enable_gps_set_loc":     ["exiftool", "curl"],
    "enable_extract_summary": ["exiftool", "curl", "jq"],
    "enable_annotate_desc":   ["exiftool", "ollama"],
    "enable_annotate_kw":     ["exiftool", "ollama"],
    "enable_annotate_hl":     ["exiftool", "ollama"],
    "enable_blur":            ["exiftool", "imagemagick"],
    "enable_geo_rename":      ["exiftool", "curl", "jq"],
    "enable_gopro":           ["exiftool", "curl", "jq"],
    "enable_metadata_replace":   ["exiftool"],
    "enable_metadata_copyright": ["exiftool"],
    "enable_metadata_consistency": ["exiftool", "ollama"],
    "enable_catalog_update":  ["exiftool"],
    "enable_contact_sheet":   ["exiftool", "imagemagick"],
    "enable_scrub":           ["exiftool"],
}

# Human-readable labels for tools (used in preflight messages).
TOOL_LABELS = {
    "exiftool":    "ExifTool",
    "curl":        "curl",
    "jq":          "jq",
    "ollama":      "Ollama",
    "imagemagick": "ImageMagick (magick or convert/identify/montage)",
}

# Default step order (used when client doesn't send step_order).
DEFAULT_STEP_ORDER = [
    "enable_sync_exif", "enable_gps_gap_fill", "enable_gps_set_loc", "enable_extract_summary",
    "enable_annotate_desc", "enable_annotate_kw", "enable_annotate_hl",
    "enable_geo_rename", "enable_gopro", "enable_blur",
    "enable_metadata_replace", "enable_metadata_copyright",
    "enable_metadata_consistency",
    "enable_catalog_update",
    "enable_contact_sheet", "enable_scrub",
]
