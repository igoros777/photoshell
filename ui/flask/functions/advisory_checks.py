"""Advisory pre-flight checks for PhotoShell workflows.

Each check function examines a sample of photos in the target directory and
returns an advisory dict:

    {
        "key":      str,   # unique check identifier
        "level":    str,   # "info" | "warning"
        "icon":     str,   # Bootstrap icon class
        "title":    str,   # short heading
        "detail":   str,   # explanation / numbers
    }

The main entry point is ``run_advisory_checks(photo_dir, enabled_steps)``.
"""

import json
import os
import re
import subprocess
from collections import defaultdict

from functions.constants import PHOTO_EXTENSIONS

# Maximum number of files to sample for metadata checks.
_SAMPLE_LIMIT = 30


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _list_photo_files(photo_dir, limit=_SAMPLE_LIMIT):
    """Return up to *limit* photo file paths in *photo_dir* (non-recursive)."""
    files = []
    try:
        with os.scandir(photo_dir) as it:
            for entry in it:
                try:
                    if not entry.is_file():
                        continue
                except (OSError, PermissionError):
                    continue
                ext = os.path.splitext(entry.name)[1].lower()
                if ext in PHOTO_EXTENSIONS:
                    files.append(entry.path)
                    if len(files) >= limit:
                        break
    except (OSError, PermissionError):
        pass
    return files


def _count_photo_files(photo_dir):
    """Return total photo file count (non-recursive)."""
    count = 0
    try:
        with os.scandir(photo_dir) as it:
            for entry in it:
                try:
                    if not entry.is_file():
                        continue
                except (OSError, PermissionError):
                    continue
                ext = os.path.splitext(entry.name)[1].lower()
                if ext in PHOTO_EXTENSIONS:
                    count += 1
    except (OSError, PermissionError):
        pass
    return count


def _run_exiftool_json(files, tags):
    """Run exiftool -json on *files* extracting only *tags*.

    Returns a list of dicts (one per file) or an empty list on error.
    *tags* should be a list like ["-GPSLatitude", "-UserComment"].
    """
    if not files:
        return []
    cmd = ["exiftool", "-json", "-n"] + tags + files
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
        )
        if proc.returncode not in (0, 1):  # 1 = minor warnings
            return []
        if not proc.stdout:
            return []
        return json.loads(proc.stdout.decode("utf-8", errors="replace"))
    except Exception:
        return []


def _pct(part, total):
    if total == 0:
        return 0
    return round(100 * part / total)


# ---------------------------------------------------------------------------
# Individual advisory checks
# ---------------------------------------------------------------------------

def check_gps_coverage(photo_dir, enabled_steps, cached_data=None):
    """Warn if photos lack GPS and no GPS-providing step is enabled."""
    # If sync-exif or gps-gap-fill is in the workflow, skip this advisory
    if "enable_sync_exif" in enabled_steps or "enable_gps_gap_fill" in enabled_steps:
        return None

    # Only relevant if a GPS-consuming step is enabled
    gps_consumers = {
        "enable_extract_summary", "enable_annotate_desc", "enable_annotate_kw",
        "enable_geo_rename", "enable_gopro",
    }
    if not gps_consumers.intersection(enabled_steps):
        return None

    if cached_data is not None:
        data = cached_data
    else:
        files = _list_photo_files(photo_dir)
        if not files:
            return None
        data = _run_exiftool_json(files, ["-GPSLatitude", "-GPSLongitude"])
    if not data:
        return None

    missing = 0
    for rec in data:
        lat = rec.get("GPSLatitude")
        lon = rec.get("GPSLongitude")
        if not lat or not lon:
            missing += 1

    total = len(data)
    if missing == 0:
        return None

    pct = _pct(missing, total)
    consuming_labels = []
    label_map = {
        "enable_extract_summary": "Extract Photo Summary",
        "enable_annotate_desc": "Annotate - Description",
        "enable_annotate_kw": "Annotate - Keywords",
        "enable_geo_rename": "Geo Rename Photos",
        "enable_gopro": "GoPro Geo Rename",
    }
    for k in gps_consumers.intersection(enabled_steps):
        consuming_labels.append(label_map.get(k, k))

    return {
        "key": "gps_missing",
        "level": "warning",
        "icon": "bi-geo-alt",
        "title": "Photos missing GPS coordinates",
        "detail": (
            "%d of %d sampled photos (%d%%) have no GPS data. "
            "Steps that need GPS (%s) may produce incomplete results. "
            "Consider enabling GPS Gap Fill or Sync EXIF & Rename first."
        ) % (missing, total, pct, ", ".join(sorted(consuming_labels))),
    }


def check_summary_already_done(photo_dir, enabled_steps, cached_data=None):
    """Advise if Extract Photo Summary appears to have already run."""
    if "enable_extract_summary" not in enabled_steps:
        return None

    if cached_data is not None:
        data = cached_data
    else:
        files = _list_photo_files(photo_dir)
        if not files:
            return None
        data = _run_exiftool_json(files, ["-UserComment"])
    if not data:
        return None

    # The summary script writes a distinctive pattern:
    #   "<model> | <lens> | ISO: <iso> | ..."
    summary_pattern = re.compile(r"\|\s*ISO:\s*\d+")

    has_summary = 0
    for rec in data:
        comment = rec.get("UserComment") or ""
        if isinstance(comment, str) and summary_pattern.search(comment):
            has_summary += 1

    total = len(data)
    if has_summary == 0:
        return None

    pct = _pct(has_summary, total)
    if pct >= 80:
        return {
            "key": "summary_exists",
            "level": "info",
            "icon": "bi-card-text",
            "title": "Photo summaries already present",
            "detail": (
                "%d of %d sampled photos (%d%%) already have metadata "
                "summaries (UserComment). Running Extract Photo Summary "
                "will overwrite them."
            ) % (has_summary, total, pct),
        }
    else:
        return {
            "key": "summary_partial",
            "level": "info",
            "icon": "bi-card-text",
            "title": "Some photos already have summaries",
            "detail": (
                "%d of %d sampled photos (%d%%) already have metadata "
                "summaries. The rest will be generated."
            ) % (has_summary, total, pct),
        }


def check_description_already_done(photo_dir, enabled_steps, cached_data=None):
    """Advise if Annotate - Description appears to have already run."""
    if "enable_annotate_desc" not in enabled_steps:
        return None

    if cached_data is not None:
        data = cached_data
    else:
        files = _list_photo_files(photo_dir)
        if not files:
            return None
        data = _run_exiftool_json(files, ["-ImageDescription", "-IPTC:Caption-Abstract"])
    if not data:
        return None

    has_desc = 0
    for rec in data:
        desc = rec.get("ImageDescription") or rec.get("Caption-Abstract") or ""
        # Ignore the machine-generated summary pattern; look for actual
        # natural-language descriptions (at least a few words).
        if isinstance(desc, str) and len(desc.split()) >= 5:
            has_desc += 1

    total = len(data)
    if has_desc == 0:
        return None

    pct = _pct(has_desc, total)
    if pct >= 80:
        return {
            "key": "desc_exists",
            "level": "info",
            "icon": "bi-chat-left-text",
            "title": "Photo descriptions already present",
            "detail": (
                "%d of %d sampled photos (%d%%) already have descriptions "
                "(ImageDescription / Caption-Abstract). Running Annotate - "
                "Description will overwrite them."
            ) % (has_desc, total, pct),
        }
    else:
        return {
            "key": "desc_partial",
            "level": "info",
            "icon": "bi-chat-left-text",
            "title": "Some photos already have descriptions",
            "detail": (
                "%d of %d sampled photos (%d%%) already have descriptions. "
                "Running Annotate - Description will overwrite existing ones "
                "and generate new ones for the rest."
            ) % (has_desc, total, pct),
        }


def check_keywords_already_done(photo_dir, enabled_steps, cached_data=None):
    """Advise if Annotate - Keywords appears to have already run."""
    if "enable_annotate_kw" not in enabled_steps:
        return None

    if cached_data is not None:
        data = cached_data
    else:
        files = _list_photo_files(photo_dir)
        if not files:
            return None
        data = _run_exiftool_json(files, ["-IPTC:Keywords"])
    if not data:
        return None

    has_kw = 0
    for rec in data:
        kw = rec.get("Keywords")
        if kw:
            # exiftool returns a string or list depending on count
            if isinstance(kw, list) and len(kw) > 0:
                has_kw += 1
            elif isinstance(kw, str) and kw.strip():
                has_kw += 1

    total = len(data)
    if has_kw == 0:
        return None

    pct = _pct(has_kw, total)
    detail_note = (
        "The keywords step skips files that already have keywords, "
        "so only photos without keywords will be processed."
    )
    if pct >= 80:
        return {
            "key": "kw_exists",
            "level": "info",
            "icon": "bi-tags",
            "title": "Most photos already have keywords",
            "detail": (
                "%d of %d sampled photos (%d%%) already have IPTC keywords. %s"
            ) % (has_kw, total, pct, detail_note),
        }
    else:
        return {
            "key": "kw_partial",
            "level": "info",
            "icon": "bi-tags",
            "title": "Some photos already have keywords",
            "detail": (
                "%d of %d sampled photos (%d%%) already have IPTC keywords. %s"
            ) % (has_kw, total, pct, detail_note),
        }


def check_geo_rename_done(photo_dir, enabled_steps, cached_data=None):
    """Advise if files already follow the geo-rename pattern."""
    if "enable_geo_rename" not in enabled_steps:
        return None

    # Geo-renamed files match: YYYYMMDD-HHMMSS-<model>-<location>.<ext>
    geo_pattern = re.compile(
        r"^\d{8}-\d{6}-.+-.+\.[a-zA-Z0-9]+$"
    )

    files = _list_photo_files(photo_dir)
    if not files:
        return None

    matched = 0
    for f in files:
        name = os.path.basename(f)
        if geo_pattern.match(name):
            matched += 1

    total = len(files)
    if matched == 0:
        return None

    pct = _pct(matched, total)
    if pct >= 80:
        return {
            "key": "geo_rename_done",
            "level": "info",
            "icon": "bi-signpost-2",
            "title": "Photos appear already geo-renamed",
            "detail": (
                "%d of %d sampled photos (%d%%) already follow the "
                "YYYYMMDD-HHMMSS-model-location naming pattern. "
                "Geo Rename will skip files that already match."
            ) % (matched, total, pct),
        }

    return None


def check_contact_sheet_exists(photo_dir, enabled_steps, cached_data=None):
    """Advise if a contact sheet already exists in the directory."""
    if "enable_contact_sheet" not in enabled_steps:
        return None

    cs_path = os.path.join(photo_dir, "contact_sheet.jpg")
    if os.path.isfile(cs_path):
        return {
            "key": "contact_sheet_exists",
            "level": "info",
            "icon": "bi-grid-3x3",
            "title": "Contact sheet already exists",
            "detail": (
                "contact_sheet.jpg already exists in the target folder. "
                "Running Contact Sheet will overwrite it."
            ),
        }

    return None


def check_blurry_output_exists(photo_dir, enabled_steps, cached_data=None):
    """Advise if blur detection output directories already exist."""
    if "enable_blur" not in enabled_steps:
        return None

    existing = []
    for dirname in ("analyzed", "selected", "scenes"):
        d = os.path.join(photo_dir, dirname)
        try:
            if os.path.isdir(d) and os.listdir(d):
                existing.append(dirname)
        except (OSError, PermissionError):
            pass

    if not existing:
        return None

    return {
        "key": "blur_output_exists",
        "level": "warning",
        "icon": "bi-eye",
        "title": "Blur detection output already exists",
        "detail": (
            "Directories from a previous blur detection run exist: %s. "
            "Enable the --clean option to clear them first, or the step "
            "may fail."
        ) % ", ".join(existing),
    }


def check_scrub_after_writes(photo_dir, enabled_steps, cached_data=None):
    """Warn if scrub is enabled but metadata-writing steps are not,
    meaning the user may be about to erase valuable metadata."""
    if "enable_scrub" not in enabled_steps:
        return None

    write_steps = {
        "enable_extract_summary", "enable_annotate_desc", "enable_annotate_kw",
    }
    if write_steps.intersection(enabled_steps):
        # Metadata is being regenerated in this run, scrub order is
        # handled by the ordering system.
        return None

    # Scrub enabled alone -- check if there is metadata to scrub
    if cached_data is not None:
        data = cached_data
    else:
        files = _list_photo_files(photo_dir)
        if not files:
            return None
        data = _run_exiftool_json(
            files, ["-UserComment", "-ImageDescription", "-IPTC:Keywords"]
        )
    if not data:
        return None

    has_data = 0
    for rec in data:
        if (rec.get("UserComment") or rec.get("ImageDescription")
                or rec.get("Keywords")):
            has_data += 1

    if has_data == 0:
        return None

    total = len(data)
    pct = _pct(has_data, total)
    return {
        "key": "scrub_will_erase",
        "level": "warning",
        "icon": "bi-eraser",
        "title": "Scrub will erase existing metadata",
        "detail": (
            "%d of %d sampled photos (%d%%) have metadata in fields that "
            "Scrub will clear (UserComment, ImageDescription, Keywords). "
            "This cannot be undone."
        ) % (has_data, total, pct),
    }


def check_no_photos(photo_dir):
    """Warn if the directory contains no photo files."""
    count = _count_photo_files(photo_dir)
    if count == 0:
        return {
            "key": "no_photos",
            "level": "warning",
            "icon": "bi-image",
            "title": "No photo files found",
            "detail": (
                "The target directory contains no recognized photo files. "
                "The workflow will have nothing to process."
            ),
        }
    return None


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def scan_folder_metadata(photo_dir, limit=_SAMPLE_LIMIT):
    """Metadata scan of photos in *photo_dir*.

    *limit* controls sampling: the default samples up to ``_SAMPLE_LIMIT``
    files.  Pass ``limit=0`` to scan ALL files (slower but exact).

    Returns a dict with counts/percentages for GPS, IPTC caption,
    EXIF UserComment, and IPTC Keywords coverage.

    Returns ``None`` if the directory has no photos or exiftool fails.
    """
    total = _count_photo_files(photo_dir)
    if total == 0:
        return None

    files = _list_photo_files(photo_dir, limit=limit if limit > 0 else total)
    if not files:
        return None

    data = _run_exiftool_json(
        files,
        ["-GPSLatitude", "-GPSLongitude",
         "-IPTC:Caption-Abstract", "-UserComment", "-IPTC:Keywords",
         "-Model", "-DateTimeOriginal"],
    )
    if not data:
        return None

    has_gps = 0
    has_caption = 0
    has_comment = 0
    has_keywords = 0
    cameras = defaultdict(int)
    date_min = None
    date_max = None

    for rec in data:
        lat = rec.get("GPSLatitude")
        lon = rec.get("GPSLongitude")
        if lat and lon:
            has_gps += 1

        caption = rec.get("Caption-Abstract") or ""
        if isinstance(caption, str) and caption.strip():
            has_caption += 1

        comment = rec.get("UserComment") or ""
        if isinstance(comment, str) and comment.strip():
            has_comment += 1

        kw = rec.get("Keywords")
        if kw:
            if isinstance(kw, list) and len(kw) > 0:
                has_keywords += 1
            elif isinstance(kw, str) and kw.strip():
                has_keywords += 1

        model = rec.get("Model") or ""
        if isinstance(model, str) and model.strip():
            cameras[model.strip()] += 1

        dto = rec.get("DateTimeOriginal") or ""
        if isinstance(dto, str) and dto.strip() and not dto.startswith("0000"):
            if date_min is None or dto < date_min:
                date_min = dto
            if date_max is None or dto > date_max:
                date_max = dto

    sampled = len(data)
    return {
        "sampled": sampled,
        "total": total,
        "has_gps": has_gps,
        "has_caption": has_caption,
        "has_comment": has_comment,
        "has_keywords": has_keywords,
        "pct_gps": _pct(has_gps, sampled),
        "pct_caption": _pct(has_caption, sampled),
        "pct_comment": _pct(has_comment, sampled),
        "pct_keywords": _pct(has_keywords, sampled),
        "cameras": dict(cameras),
        "date_min": date_min,
        "date_max": date_max,
    }


def extract_gps_data(photo_dir, limit=500):
    """Extract per-file GPS coordinates and metadata for map display.

    Returns a dict with total_photos, gps_photos, and a markers list.
    Each marker has lat, lng, filename, path, camera, and date.
    """
    total = _count_photo_files(photo_dir)
    if total == 0:
        return {"total_photos": 0, "gps_photos": 0, "markers": []}

    cap = total if limit <= 0 else min(limit, total)
    files = _list_photo_files(photo_dir, limit=cap)
    if not files:
        return {"total_photos": total, "gps_photos": 0, "markers": []}

    data = _run_exiftool_json(
        files,
        ["-GPSLatitude", "-GPSLongitude", "-Model", "-DateTimeOriginal",
         "-FileName"],
    )
    if not data:
        return {"total_photos": total, "gps_photos": 0, "markers": []}

    markers = []
    for rec in data:
        lat = rec.get("GPSLatitude")
        lng = rec.get("GPSLongitude")
        if lat is None or lng is None:
            continue
        # Skip zero/zero coordinates (often invalid)
        if lat == 0 and lng == 0:
            continue
        fname = rec.get("FileName", "")
        markers.append({
            "lat": lat,
            "lng": lng,
            "filename": fname,
            "path": os.path.join(photo_dir, fname),
            "camera": (rec.get("Model") or "").strip() or None,
            "date": (rec.get("DateTimeOriginal") or "").strip() or None,
        })

    return {
        "total_photos": total,
        "gps_photos": len(markers),
        "markers": markers,
    }


ALL_CHECKS = [
    check_gps_coverage,
    check_summary_already_done,
    check_description_already_done,
    check_keywords_already_done,
    check_geo_rename_done,
    check_contact_sheet_exists,
    check_blurry_output_exists,
    check_scrub_after_writes,
]


def run_advisory_checks(photo_dir, enabled_steps):
    """Run all applicable advisory checks and return a list of advisories.

    *enabled_steps* is a set/list of step keys that the user has enabled
    (e.g. ``{"enable_extract_summary", "enable_geo_rename"}``).
    """
    if not os.path.isdir(photo_dir):
        return []

    enabled = set(enabled_steps)
    advisories = []

    # Always run the no-photos check
    adv = check_no_photos(photo_dir)
    if adv:
        advisories.append(adv)
        return advisories  # no point checking metadata if no files

    # Pre-fetch all metadata tags needed by checks in a single exiftool call
    files = _list_photo_files(photo_dir)
    cached_data = None
    if files:
        cached_data = _run_exiftool_json(files, [
            "-GPSLatitude", "-GPSLongitude",
            "-UserComment", "-ImageDescription",
            "-IPTC:Caption-Abstract", "-IPTC:Keywords",
        ])
        if not cached_data:
            cached_data = None

    for check_fn in ALL_CHECKS:
        try:
            adv = check_fn(photo_dir, enabled, cached_data=cached_data)
        except Exception:
            continue
        if adv:
            advisories.append(adv)

    return advisories
