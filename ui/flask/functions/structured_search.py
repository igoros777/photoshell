"""Structured metadata search for PhotoShell.

Provides field discovery (sampling photos to detect available EXIF/IPTC fields
and their value types) and structured filtering (numeric ranges, date ranges,
exact match, substring match).
"""

import json
import os
import random
import re
import subprocess
from datetime import datetime

from functions.constants import PHOTO_EXTENSIONS

# Fields known to be numeric (exiftool -n returns raw numbers)
NUMERIC_FIELDS = {
    "FNumber", "ExposureTime", "FocalLength", "FocalLengthIn35mmFormat",
    "ISO", "ISOSpeedRatings", "GPSLatitude", "GPSLongitude", "GPSAltitude",
    "ImageWidth", "ImageHeight", "ExposureBiasValue", "ExposureCompensation",
    "ShutterSpeed", "ShutterSpeedValue", "SubjectDistance",
    "XResolution", "YResolution", "RecommendedExposureIndex",
}

# Fields known to be dates
DATE_FIELDS = {
    "DateTimeOriginal", "CreateDate", "ModifyDate",
    "DateCreated", "TimeCreated",
}

# Fields that are always text (file-level metadata, not camera tags)
FILE_FIELDS = {"FileName", "FileType"}

# Fields with special filter modes (overrides the default for their type)
# These are communicated to the frontend via the "filter_mode" property
FIELD_FILTER_MODES = {
    "FileName": "regex",           # free-form PCRE regex
    "Caption-Abstract": "regex",   # free-form PCRE regex
    "Keywords": "keywords_all",    # space-separated, all must match, PCRE each
    "FileType": "select",          # always multi-select (forced regardless of unique count)
}

# Default fields to show (most useful for photographers)
DEFAULT_FIELDS = [
    # EXIF
    "FNumber", "FocalLength", "ISO", "DateTimeOriginal", "Model", "LensModel",
    # IPTC
    "Caption-Abstract", "Keywords",
    # File
    "FileName", "FileType",
]

# Date formats to try when parsing date strings
_DATE_FORMATS = [
    "%Y:%m:%d %H:%M:%S",
    "%Y-%m-%d",
    "%Y-%m-%dT%H:%M:%S",
]


def _parse_date(value):
    """Try to parse a date string using known formats.

    Returns a datetime object or None.
    """
    if not isinstance(value, str):
        return None
    value = value.strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(value, fmt)
        except (ValueError, TypeError):
            continue
    return None


def _classify_field(name):
    """Return the type classification for a field name: 'numeric', 'date', or 'text'."""
    if name in NUMERIC_FIELDS:
        return "numeric"
    if name in DATE_FIELDS:
        return "date"
    return "text"


def _list_dir_photos(dirpath):
    """List photo files in a single directory (non-recursive). Thread-safe."""
    files = []
    try:
        with os.scandir(dirpath) as it:
            for entry in it:
                try:
                    if not entry.is_file():
                        continue
                except (OSError, PermissionError):
                    continue
                ext = os.path.splitext(entry.name)[1].lower()
                if ext in PHOTO_EXTENSIONS:
                    files.append(entry.path)
    except (OSError, PermissionError):
        pass
    return files


def _list_subdirs(dirpath):
    """List immediate subdirectories. Thread-safe."""
    dirs = []
    try:
        with os.scandir(dirpath) as it:
            for entry in it:
                try:
                    if entry.is_dir() and not entry.name.startswith("."):
                        dirs.append(entry.path)
                except (OSError, PermissionError):
                    continue
    except (OSError, PermissionError):
        pass
    return dirs


def _list_all_photo_files_parallel(photo_dir, recursive=False):
    """List all photo files, using parallel directory scanning for recursive mode.

    For recursive scans, fans out into subdirectories using a thread pool.
    Returns a list of absolute file paths.
    """
    if not recursive:
        return _list_dir_photos(photo_dir)

    from concurrent.futures import ThreadPoolExecutor, as_completed

    all_files = []
    dirs_to_scan = [photo_dir]
    scanned = set()

    # BFS with parallel scanning — process directories in batches
    with ThreadPoolExecutor(max_workers=8) as pool:
        while dirs_to_scan:
            batch = []
            for d in dirs_to_scan:
                if d not in scanned:
                    scanned.add(d)
                    batch.append(d)
            dirs_to_scan = []

            if not batch:
                break

            # Scan all directories in this batch in parallel
            photo_futures = {pool.submit(_list_dir_photos, d): d for d in batch}
            subdir_futures = {pool.submit(_list_subdirs, d): d for d in batch}

            for f in as_completed(photo_futures):
                result = f.result()
                if result:
                    all_files.extend(result)

            for f in as_completed(subdir_futures):
                result = f.result()
                if result:
                    dirs_to_scan.extend(result)

    return all_files


def count_photo_files(photo_dir, recursive=False):
    """Fast count of photo files using parallel directory scanning.

    Also checks subfolders if top-level has 0 and recursive is False,
    returning (count, actually_recursive) so the caller knows if
    auto-recursion would be needed.
    """
    top_files = _list_dir_photos(photo_dir)
    if not recursive and top_files:
        return len(top_files), False

    if not recursive and not top_files:
        # Auto-recurse
        all_files = _list_all_photo_files_parallel(photo_dir, recursive=True)
        if all_files:
            return len(all_files), True
        return 0, False

    # Explicit recursive
    all_files = _list_all_photo_files_parallel(photo_dir, recursive=True)
    return len(all_files), True


def sample_photo_files(photo_dir, recursive=False, sample_size=30):
    """Sample photo files from a directory for field discovery.

    Uses parallel directory scanning and stratified sampling to capture
    the diversity of a collection quickly:
    1. List files using parallel scanning (8 threads for recursive)
    2. Group by extension (ensures every format is represented)
    3. From each extension group, pick files at evenly spaced positions

    Returns (sampled_files, total_count).
    """
    all_files = _list_all_photo_files_parallel(photo_dir, recursive=recursive)
    total_count = len(all_files)

    if total_count <= sample_size:
        return all_files, total_count

    # Group by extension to ensure every format is represented
    by_ext = {}
    for f in all_files:
        ext = os.path.splitext(f)[1].lower()
        by_ext.setdefault(ext, []).append(f)

    # Sort each group for deterministic spacing
    for ext in by_ext:
        by_ext[ext].sort()

    # Allocate samples per extension proportionally, minimum 1 each
    ext_groups = sorted(by_ext.keys())
    remaining = sample_size
    per_ext = {}
    for ext in ext_groups:
        per_ext[ext] = 1
        remaining -= 1
    if remaining > 0:
        for ext in ext_groups:
            share = int(remaining * len(by_ext[ext]) / total_count)
            per_ext[ext] += share
        allocated = sum(per_ext.values())
        leftover = sample_size - allocated
        sizes = sorted(ext_groups, key=lambda e: len(by_ext[e]), reverse=True)
        for i in range(max(0, leftover)):
            per_ext[sizes[i % len(sizes)]] += 1

    # Pick evenly spaced files from each extension group
    sampled_set = set()
    for ext in ext_groups:
        group = by_ext[ext]
        n = min(per_ext[ext], len(group))
        if n >= len(group):
            for f in group:
                sampled_set.add(f)
        else:
            step = (len(group) - 1) / max(n - 1, 1)
            for i in range(n):
                idx = min(int(i * step), len(group) - 1)
                sampled_set.add(group[idx])

    sampled = sorted(sampled_set)
    return sampled, total_count


def _run_exiftool_batch(files):
    """Run exiftool -json -n -a -G1 on a batch of files.

    Returns a list of record dicts, or None on failure.
    Thread-safe — used for parallel batch processing.
    """
    if not files:
        return None
    cmd = ["exiftool", "-json", "-n", "-a", "-G1"] + files
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
        if proc.returncode not in (0, 1) or not proc.stdout:
            return None
        return json.loads(proc.stdout)
    except (subprocess.TimeoutExpired, json.JSONDecodeError, OSError):
        return None


def discover_fields(photo_dir, recursive=False, sample_size=30):
    """Discover available EXIF/IPTC fields by sampling photos.

    Runs exiftool on a sample of files to detect field names, types,
    value ranges, and unique values for text fields.

    If no photos are found at the top level and recursive is False,
    automatically retries with recursive=True and sets auto_recursive
    in the response so the UI can inform the user.

    Returns a dict with exif_fields, iptc_fields, sampled count,
    total count, and default_fields.
    """
    auto_recursive = False
    sampled_files, total_count = sample_photo_files(
        photo_dir, recursive=recursive, sample_size=sample_size,
    )

    # If no photos at top level and not already recursive, fan out into subfolders
    if not sampled_files and not recursive:
        sampled_files, total_count = sample_photo_files(
            photo_dir, recursive=True, sample_size=sample_size,
        )
        if sampled_files:
            auto_recursive = True

    if not sampled_files:
        return {
            "exif_fields": [],
            "iptc_fields": [],
            "sampled": 0,
            "total": total_count,
            "auto_recursive": auto_recursive,
            "default_fields": DEFAULT_FIELDS,
        }

    # Run exiftool with group names (-G1) and numeric output (-n)
    # Split into parallel batches for faster processing on large samples
    batch_size = 10
    batches = [sampled_files[i:i + batch_size]
               for i in range(0, len(sampled_files), batch_size)]

    all_records = []
    if len(batches) == 1:
        # Single batch — no threading overhead
        records = _run_exiftool_batch(batches[0])
        if records is not None:
            all_records = records
    else:
        # Multiple batches — run in parallel threads
        from concurrent.futures import ThreadPoolExecutor, as_completed
        with ThreadPoolExecutor(max_workers=min(len(batches), 4)) as pool:
            futures = {pool.submit(_run_exiftool_batch, batch): batch
                       for batch in batches}
            for future in as_completed(futures):
                result = future.result()
                if result:
                    all_records.extend(result)

    if not all_records:
        return {
            "exif_fields": [],
            "iptc_fields": [],
            "sampled": len(sampled_files),
            "total": total_count,
            "auto_recursive": auto_recursive,
            "default_fields": DEFAULT_FIELDS,
        }

    # Collect field info across all samples
    # field_key -> {group, name, type, values (set), min, max, sample}
    field_info = {}

    for rec in all_records:
        for raw_key, value in rec.items():
            if raw_key == "SourceFile":
                continue

            # Parse group prefix from -G1 output (e.g., "EXIF:FNumber")
            if ":" in raw_key:
                group_raw, field_name = raw_key.split(":", 1)
            else:
                group_raw = ""
                field_name = raw_key

            # Determine group category
            group_upper = group_raw.upper()
            if "IPTC" in group_upper:
                group = "IPTC"
            elif group_upper in ("EXIF", "IFD0", "IFD1", "EXIFIFD",
                                 "GPS", "GPSIFD", "MAKERNOTES",
                                 "INTEROP", "INTEROPIFD"):
                group = "EXIF"
            elif group_upper in ("FILE", "COMPOSITE", "SYSTEM"):
                group = "EXIF"  # treat these as EXIF-like
            else:
                group = "EXIF"  # default to EXIF

            field_type = _classify_field(field_name)

            if field_name not in field_info:
                field_info[field_name] = {
                    "group": group,
                    "name": field_name,
                    "type": field_type,
                    "values": set(),
                    "min": None,
                    "max": None,
                    "sample": None,
                }

            info = field_info[field_name]

            # Skip empty / dash values
            if value is None or value == "-" or value == "":
                continue

            # Store a sample value
            if info["sample"] is None:
                info["sample"] = value

            if field_type == "numeric":
                try:
                    num_val = float(value)
                    if info["min"] is None or num_val < info["min"]:
                        info["min"] = num_val
                    if info["max"] is None or num_val > info["max"]:
                        info["max"] = num_val
                except (ValueError, TypeError):
                    pass

            elif field_type == "date":
                dt = _parse_date(str(value))
                if dt:
                    dt_str = dt.isoformat()
                    if info["min"] is None or dt_str < info["min"]:
                        info["min"] = dt_str
                    if info["max"] is None or dt_str > info["max"]:
                        info["max"] = dt_str

            else:  # text
                str_val = str(value).strip()
                if str_val and len(info["values"]) < 20:
                    info["values"].add(str_val)

    # Build output lists
    exif_fields = []
    iptc_fields = []

    for fname, info in sorted(field_info.items()):
        entry = {
            "name": info["name"],
            "type": info["type"],
            "min": info["min"],
            "max": info["max"],
            "values": sorted(info["values"]) if info["values"] else None,
            "sample": info["sample"],
        }

        # Apply special filter modes for specific fields
        if info["name"] in FIELD_FILTER_MODES:
            entry["filter_mode"] = FIELD_FILTER_MODES[info["name"]]
            # Force select type for fields that should always be multi-select
            if FIELD_FILTER_MODES[info["name"]] == "select":
                entry["type"] = "select"
        elif info["type"] == "text" and info["values"] and len(info["values"]) <= 20:
            # Mark text fields with <= 20 unique values as "select" type
            entry["type"] = "select"

        if info["group"] == "IPTC":
            iptc_fields.append(entry)
        else:
            exif_fields.append(entry)

    return {
        "exif_fields": exif_fields,
        "iptc_fields": iptc_fields,
        "sampled": len(sampled_files),
        "total": total_count,
        "auto_recursive": auto_recursive,
        "default_fields": DEFAULT_FIELDS,
    }


def apply_filters(records, filters, logic="AND"):
    """Apply structured filters to exiftool JSON records.

    Each filter dict has:
      - field: str (exiftool field name)
      - op: str ("range", "eq", "contains", "in", "regex", "keywords_all")
      - For "range": min and/or max (numeric or date string)
      - For "eq": value (case-insensitive exact match)
      - For "contains": value (case-insensitive substring)
      - For "in": values (list, any match)
      - For "regex": value (PCRE regex pattern, case-insensitive)
      - For "keywords_all": value (space-separated terms, ALL must match,
        each term is a regex pattern matched against the full field value)

    With AND logic all filters must pass; with OR any filter must pass.

    Returns list of records that pass the filters.
    """
    if not filters:
        return list(records)

    results = []
    for rec in records:
        passes = []
        for filt in filters:
            field = filt.get("field", "")
            op = filt.get("op", "")
            passed = _check_filter(rec, field, op, filt)
            passes.append(passed)

        if logic.upper() == "OR":
            if any(passes):
                results.append(rec)
        else:  # AND
            if all(passes):
                results.append(rec)

    return results


def _check_filter(rec, field, op, filt):
    """Check whether a single record passes a single filter.

    Returns True if the record passes, False otherwise.
    """
    # Field missing from record -> filter fails
    if field not in rec:
        return False

    value = rec[field]

    # None or dash -> filter fails
    if value is None or value == "-":
        return False

    if op == "range":
        return _check_range(value, field, filt)
    elif op == "eq":
        return _check_eq(value, filt)
    elif op == "contains":
        return _check_contains(value, filt)
    elif op == "in":
        return _check_in(value, filt)
    elif op == "regex":
        return _check_regex(value, filt)
    elif op == "keywords_all":
        return _check_keywords_all(value, filt)

    return False


def _check_range(value, field, filt):
    """Check a range filter (numeric or date)."""
    filt_min = filt.get("min")
    filt_max = filt.get("max")

    # Try date comparison first if the field is a known date field
    if field in DATE_FIELDS or _parse_date(str(value)) is not None:
        dt_val = _parse_date(str(value))
        if dt_val is None:
            return False

        if filt_min is not None:
            dt_min = _parse_date(str(filt_min))
            if dt_min and dt_val < dt_min:
                return False

        if filt_max is not None:
            dt_max = _parse_date(str(filt_max))
            if dt_max and dt_val > dt_max:
                return False

        return True

    # Numeric comparison
    try:
        num_val = float(value)
    except (ValueError, TypeError):
        return False

    if filt_min is not None:
        try:
            if num_val < float(filt_min):
                return False
        except (ValueError, TypeError):
            return False

    if filt_max is not None:
        try:
            if num_val > float(filt_max):
                return False
        except (ValueError, TypeError):
            return False

    return True


def _check_eq(value, filt):
    """Check an exact-match filter (case-insensitive)."""
    target = filt.get("value", "")
    return str(value).strip().lower() == str(target).strip().lower()


def _check_contains(value, filt):
    """Check a substring filter (case-insensitive)."""
    target = filt.get("value", "")
    return str(target).lower() in str(value).lower()


def _check_in(value, filt):
    """Check an 'in' filter (any value in list matches, case-insensitive)."""
    target_values = filt.get("values", [])
    str_val = str(value).strip().lower()
    return any(str_val == str(v).strip().lower() for v in target_values)


def _check_regex(value, filt):
    """Check a regex filter (PCRE pattern, case-insensitive).

    Returns True if the pattern matches anywhere in the value string.
    Invalid regex patterns return False (no match) rather than crashing.
    """
    pattern = filt.get("value", "")
    if not pattern:
        return True
    try:
        return bool(re.search(pattern, str(value), re.IGNORECASE))
    except re.error:
        return False


def _check_keywords_all(value, filt):
    """Check a keywords filter: space-separated terms, ALL must match.

    Each term is treated as a PCRE regex pattern (case-insensitive).
    The value is the full field content (e.g., a keyword list or caption).
    For list-type values (exiftool returns Keywords as a list), the terms
    are matched against the joined string.

    Example: value="mountain, sunset, landscape"
             filter="mount sun" → True (both match)
             filter="mount ocean" → False (ocean doesn't match)
    """
    raw_terms = filt.get("value", "")
    if not raw_terms or not raw_terms.strip():
        return True

    terms = raw_terms.strip().split()

    # If the value is a list (exiftool returns Keywords as list), join it
    if isinstance(value, list):
        str_val = ", ".join(str(v) for v in value)
    else:
        str_val = str(value)

    for term in terms:
        try:
            if not re.search(term, str_val, re.IGNORECASE):
                return False
        except re.error:
            return False

    return True


def structured_search(photo_dir, filters, recursive=False, logic="AND"):
    """Run a structured metadata search across all photos in a directory.

    Lists all photo files, runs exiftool to extract fields referenced in
    the filters (plus standard metadata fields), applies filters, and
    returns matching results.

    Returns dict with matches count, total_scanned count, and results list.
    """
    all_files = _list_all_photo_files(photo_dir, recursive=recursive)
    if not all_files:
        return {"matches": 0, "total_scanned": 0, "results": []}

    # Collect unique fields from filters
    filter_fields = set()
    for filt in filters:
        field = filt.get("field", "")
        if field:
            filter_fields.add(field)

    # Always include standard metadata fields
    standard_fields = {"SourceFile", "FileName", "FileType", "UserComment",
                       "Caption-Abstract", "Keywords"}
    all_fields = filter_fields | standard_fields

    # Build exiftool tag arguments
    tag_args = []
    for field in sorted(all_fields):
        tag_args.append("-" + field)

    cmd = ["exiftool", "-json", "-n"] + tag_args + all_files
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            encoding="utf-8",
            errors="replace",
            timeout=120,
        )
        if proc.returncode not in (0, 1) or not proc.stdout:
            return {"matches": 0, "total_scanned": len(all_files), "results": []}
        records = json.loads(proc.stdout)
    except subprocess.TimeoutExpired:
        return {"matches": 0, "total_scanned": len(all_files), "results": [],
                "error": "exiftool timed out"}
    except (json.JSONDecodeError, OSError) as exc:
        return {"matches": 0, "total_scanned": len(all_files), "results": [],
                "error": str(exc)}

    # Apply filters
    matched = apply_filters(records, filters, logic=logic)

    # Build results
    results = []
    for rec in matched:
        src = rec.get("SourceFile", "")
        comment = rec.get("UserComment") or ""
        caption = rec.get("Caption-Abstract") or ""
        keywords = rec.get("Keywords") or ""
        if isinstance(keywords, list):
            keywords = ", ".join(str(k) for k in keywords)
        if isinstance(comment, str):
            comment = comment.strip()
        if isinstance(caption, str):
            caption = caption.strip()

        results.append({
            "file": src,
            "filename": rec.get("FileName", os.path.basename(src)),
            "comment": comment,
            "caption": caption,
            "keywords": keywords,
        })

    return {
        "matches": len(results),
        "total_scanned": len(records),
        "results": results,
    }
