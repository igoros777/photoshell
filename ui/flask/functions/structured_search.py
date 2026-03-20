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

# Default fields to show (most useful for photographers)
DEFAULT_FIELDS = [
    "FNumber", "FocalLength", "ISO", "DateTimeOriginal", "Model", "LensModel",
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


def _list_all_photo_files(photo_dir, recursive=False):
    """List all photo files in the directory.

    Returns a list of absolute file paths.
    """
    files = []
    if recursive:
        for root, _dirs, filenames in os.walk(photo_dir):
            for fname in filenames:
                ext = os.path.splitext(fname)[1].lower()
                if ext in PHOTO_EXTENSIONS:
                    files.append(os.path.join(root, fname))
    else:
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
        except (OSError, PermissionError):
            pass
    return files


def sample_photo_files(photo_dir, recursive=False, sample_size=10):
    """Sample photo files from a directory for field discovery.

    If total > sample_size, pick first 3, last 3, and random middle ones
    to reach sample_size.

    Returns (sampled_files, total_count).
    """
    all_files = _list_all_photo_files(photo_dir, recursive=recursive)
    total_count = len(all_files)

    if total_count <= sample_size:
        return all_files, total_count

    # Sort for deterministic first/last
    all_files.sort()

    first_n = 3
    last_n = 3
    middle_needed = sample_size - first_n - last_n

    first = all_files[:first_n]
    last = all_files[-last_n:]

    # Middle candidates: everything except first_n and last_n
    middle_candidates = all_files[first_n:-last_n]
    if middle_needed > 0 and middle_candidates:
        middle = random.sample(
            middle_candidates,
            min(middle_needed, len(middle_candidates)),
        )
    else:
        middle = []

    sampled = first + middle + last
    return sampled, total_count


def discover_fields(photo_dir, recursive=False, sample_size=10):
    """Discover available EXIF/IPTC fields by sampling photos.

    Runs exiftool on a sample of files to detect field names, types,
    value ranges, and unique values for text fields.

    Returns a dict with exif_fields, iptc_fields, sampled count,
    total count, and default_fields.
    """
    sampled_files, total_count = sample_photo_files(
        photo_dir, recursive=recursive, sample_size=sample_size,
    )
    if not sampled_files:
        return {
            "exif_fields": [],
            "iptc_fields": [],
            "sampled": 0,
            "total": total_count,
            "default_fields": DEFAULT_FIELDS,
        }

    # Run exiftool with group names (-G1) and numeric output (-n)
    cmd = ["exiftool", "-json", "-n", "-a", "-G1"] + sampled_files
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
            return {
                "exif_fields": [],
                "iptc_fields": [],
                "sampled": len(sampled_files),
                "total": total_count,
                "default_fields": DEFAULT_FIELDS,
            }
        records = json.loads(proc.stdout)
    except (subprocess.TimeoutExpired, json.JSONDecodeError, OSError):
        return {
            "exif_fields": [],
            "iptc_fields": [],
            "sampled": len(sampled_files),
            "total": total_count,
            "default_fields": DEFAULT_FIELDS,
        }

    # Collect field info across all samples
    # field_key -> {group, name, type, values (set), min, max, sample}
    field_info = {}

    for rec in records:
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

        # Mark text fields with <= 20 unique values as "select" type
        if info["type"] == "text" and info["values"] and len(info["values"]) <= 20:
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
        "default_fields": DEFAULT_FIELDS,
    }


def apply_filters(records, filters, logic="AND"):
    """Apply structured filters to exiftool JSON records.

    Each filter dict has:
      - field: str (exiftool field name)
      - op: str ("range", "eq", "contains", "in")
      - For "range": min and/or max (numeric or date string)
      - For "eq": value (case-insensitive exact match)
      - For "contains": value (case-insensitive substring)
      - For "in": values (list, any match)

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
    standard_fields = {"SourceFile", "FileName", "UserComment",
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
