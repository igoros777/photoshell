"""SQLite photo catalog for fast metadata searching across large collections."""

import os
import re
import sqlite3


def get_catalog_path(photo_dir):
    """Return the default catalog DB path for a photo directory."""
    return os.path.join(photo_dir, ".photoshell", "catalog.db")


def catalog_exists(photo_dir):
    """Check if a catalog database exists for the given directory."""
    return os.path.isfile(get_catalog_path(photo_dir))


def catalog_stats(db_path):
    """Return summary statistics for a catalog database."""
    if not os.path.isfile(db_path):
        return None

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        c = conn.cursor()
        row = c.execute("""
            SELECT
                COUNT(*) AS total_files,
                COUNT(DISTINCT model) AS camera_models,
                COUNT(CASE WHEN gps_latitude IS NOT NULL AND gps_latitude != 0 THEN 1 END) AS with_gps,
                COUNT(CASE WHEN keywords != '' AND keywords IS NOT NULL THEN 1 END) AS with_keywords,
                COUNT(CASE WHEN headline != '' AND headline IS NOT NULL THEN 1 END) AS with_headline,
                COUNT(CASE WHEN caption != '' AND caption IS NOT NULL THEN 1 END) AS with_caption,
                MIN(date_time_original) AS earliest_date,
                MAX(date_time_original) AS latest_date
            FROM photos
        """).fetchone()

        cameras = c.execute("""
            SELECT model, COUNT(*) AS count
            FROM photos WHERE model != '' AND model IS NOT NULL
            GROUP BY model ORDER BY count DESC LIMIT 20
        """).fetchall()

        file_types = c.execute("""
            SELECT file_type, COUNT(*) AS count
            FROM photos GROUP BY file_type ORDER BY count DESC
        """).fetchall()

        return {
            "total_files": row["total_files"],
            "camera_models": row["camera_models"],
            "with_gps": row["with_gps"],
            "with_keywords": row["with_keywords"],
            "with_headline": row["with_headline"],
            "with_caption": row["with_caption"],
            "earliest_date": row["earliest_date"],
            "latest_date": row["latest_date"],
            "cameras": [{"model": r["model"], "count": r["count"]} for r in cameras],
            "file_types": [{"type": r["file_type"], "count": r["count"]} for r in file_types],
            "db_path": db_path,
            "db_size": os.path.getsize(db_path),
        }
    finally:
        conn.close()


# Columns that are searchable and their types
SEARCHABLE_COLUMNS = {
    "file_name": "text",
    "file_type": "text",
    "make": "text",
    "model": "text",
    "lens_model": "text",
    "date_time_original": "date",
    "f_number": "numeric",
    "exposure_time": "text",
    "focal_length": "numeric",
    "focal_length_35": "numeric",
    "iso": "numeric",
    "image_width": "numeric",
    "image_height": "numeric",
    "gps_latitude": "numeric",
    "gps_longitude": "numeric",
    "headline": "text",
    "caption": "text",
    "keywords": "text",
    "copyright": "text",
    "city": "text",
    "state": "text",
    "country": "text",
}


def catalog_search(db_path, query="", filters=None, page=1, per_page=50):
    """Search the catalog with optional text query and structured filters.

    Args:
        db_path: Path to the SQLite database.
        query: Free-text search string (searched across multiple fields).
        filters: List of filter dicts: [{field, op, value/min/max}]
        page: Page number (1-based).
        per_page: Results per page.

    Returns:
        Dict with results, total count, and pagination info.
    """
    if not os.path.isfile(db_path):
        return {"error": "Catalog not found", "results": [], "total": 0}

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        conditions = []
        params = []

        # Free-text search across multiple fields
        if query and query.strip():
            q = query.strip()
            text_fields = [
                "file_name", "file_path", "make", "model", "lens_model",
                "headline", "caption", "keywords", "city", "state", "country",
            ]
            text_conds = []
            for field in text_fields:
                text_conds.append("{} LIKE ?".format(field))
                params.append("%{}%".format(q))
            conditions.append("(" + " OR ".join(text_conds) + ")")

        # Structured filters
        if filters:
            for f in filters:
                field = f.get("field", "")
                op = f.get("op", "")
                # Validate field name against whitelist
                if field not in SEARCHABLE_COLUMNS:
                    continue

                if op == "contains":
                    conditions.append("{} LIKE ?".format(field))
                    params.append("%{}%".format(f.get("value", "")))
                elif op == "eq":
                    conditions.append("{} = ?".format(field))
                    params.append(f.get("value", ""))
                elif op == "range":
                    if f.get("min") is not None and f["min"] != "":
                        conditions.append("{} >= ?".format(field))
                        params.append(f["min"])
                    if f.get("max") is not None and f["max"] != "":
                        conditions.append("{} <= ?".format(field))
                        params.append(f["max"])
                elif op == "in":
                    values = f.get("values", [])
                    if values:
                        placeholders = ",".join("?" for _ in values)
                        conditions.append("{} IN ({})".format(field, placeholders))
                        params.extend(values)
                elif op == "regex":
                    # SQLite REGEXP requires a function — use LIKE as fallback
                    val = f.get("value", "")
                    conditions.append("{} LIKE ?".format(field))
                    params.append("%{}%".format(val))
                elif op == "not_empty":
                    conditions.append("{} IS NOT NULL AND {} != ''".format(field, field))

        where = " AND ".join(conditions) if conditions else "1=1"

        # Count total
        count_sql = "SELECT COUNT(*) FROM photos WHERE {}".format(where)
        total = conn.execute(count_sql, params).fetchone()[0]

        # Fetch page
        offset = (page - 1) * per_page
        select_sql = """
            SELECT file_path, file_name, file_type, make, model, lens_model,
                   date_time_original, f_number, focal_length, iso,
                   image_width, image_height,
                   gps_latitude, gps_longitude,
                   headline, caption, keywords, city, state, country
            FROM photos
            WHERE {}
            ORDER BY date_time_original DESC, file_name ASC
            LIMIT ? OFFSET ?
        """.format(where)
        rows = conn.execute(select_sql, params + [per_page, offset]).fetchall()

        results = []
        for row in rows:
            results.append({k: row[k] for k in row.keys()})

        return {
            "results": results,
            "total": total,
            "page": page,
            "per_page": per_page,
            "total_pages": max(1, (total + per_page - 1) // per_page),
        }
    finally:
        conn.close()


def catalog_remove(db_path):
    """Delete the catalog database file."""
    if os.path.isfile(db_path):
        os.remove(db_path)
        return True
    return False
