#!/usr/bin/env python3
"""PhotoShell Flask UI - run photo-processing scripts as a workflow."""

import argparse
import glob
import json
import os
import socket
import stat
import subprocess
import threading
import time
import uuid
from pathlib import Path

from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

# Resolve directories relative to this file
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS_DIR = str(REPO_ROOT / "scripts")
DOCS_DIR = str(REPO_ROOT / "docs")

# In-memory job store: job_id -> {status, log, current_step, steps, pid}
jobs = {}
jobs_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Helper: stream a subprocess and append to the job log
# ---------------------------------------------------------------------------

def _run_step(job_id, step_index, cmd, cwd):
    """Run one pipeline step, streaming output into the job log."""
    with jobs_lock:
        job = jobs[job_id]
        job["current_step"] = step_index
        label = job["steps"][step_index]
        job["log"] += "\n" + "=" * 60 + "\n"
        job["log"] += "[Step %d] %s\n" % (step_index + 1, label)
        job["log"] += "=" * 60 + "\n"
        job["log"] += "$ %s\n\n" % " ".join(cmd)

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            universal_newlines=True,
            cwd=cwd,
            bufsize=1,
        )
        with jobs_lock:
            jobs[job_id]["pid"] = proc.pid

        for line in proc.stdout:
            with jobs_lock:
                jobs[job_id]["log"] += line

        proc.wait()
        rc = proc.returncode
    except Exception as exc:
        rc = -1
        with jobs_lock:
            jobs[job_id]["log"] += "\n[ERROR] %s\n" % str(exc)

    with jobs_lock:
        jobs[job_id]["log"] += "\n[Exit code: %d]\n" % rc
        jobs[job_id]["pid"] = None

    return rc


def _run_pipeline(job_id, steps, cwd):
    """Execute a sequence of steps; stop on first failure."""
    for i, step in enumerate(steps):
        rc = _run_step(job_id, i, step["cmd"], cwd)
        if rc != 0:
            with jobs_lock:
                jobs[job_id]["status"] = "failed"
                jobs[job_id]["log"] += "\n*** Pipeline stopped due to error ***\n"
            return

    with jobs_lock:
        jobs[job_id]["status"] = "done"
        jobs[job_id]["log"] += "\n*** All steps completed successfully ***\n"


# ---------------------------------------------------------------------------
# Build command lists from form data
# ---------------------------------------------------------------------------

def _script(name):
    return os.path.join(SCRIPTS_DIR, name)


def _build_step(key, data):
    """Build a single {label, cmd} dict for a given step key, or None."""
    photo_dir = data["photo_dir"]

    if key == "enable_sync_exif" and data.get(key):
        cmd = ["bash", _script("sync_exif_and_rename.sh"), photo_dir]
        if data.get("sync_orig_dir"):
            cmd += ["--orig-dir", data["sync_orig_dir"]]
        if data.get("sync_dry_run"):
            cmd.append("--dry-run")
        return {"label": "Sync EXIF & Rename", "cmd": cmd}

    if key == "enable_gps_gap_fill" and data.get(key):
        cmd = ["bash", _script("gps_gap_fill.sh")]
        if data.get("gps_dry_run"):
            cmd.append("--dry-run")
        return {"label": "GPS Gap Fill", "cmd": cmd}

    if key == "enable_extract_summary" and data.get(key):
        script_path = _script("extract_photo_summary.sh")
        cmd = [
            "bash", "-c",
            'find ./ -maxdepth 1 -type f \\( -iname "*.jpg" -o -iname "*.jpeg" \\) '
            '-print0 | xargs -0 -I{} bash "%s" "{}"' % script_path,
        ]
        return {"label": "Extract Photo Summary", "cmd": cmd}

    if key == "enable_annotate_desc" and data.get(key):
        cmd = ["bash", _script("annotate_photos_with_ollama.sh"), "--description"]
        if data.get("desc_model"):
            cmd += ["-m", data["desc_model"]]
        if data.get("desc_prompt_id"):
            cmd += ["--prompt-id", data["desc_prompt_id"]]
        if data.get("desc_recursive"):
            cmd.append("--recursive")
        if data.get("desc_file"):
            cmd += ["--file", data["desc_file"]]
        return {"label": "Annotate (Description)", "cmd": cmd}

    if key == "enable_annotate_kw" and data.get(key):
        cmd = ["bash", _script("annotate_photos_with_ollama.sh"), "--keywords"]
        if data.get("kw_model"):
            cmd += ["-m", data["kw_model"]]
        if data.get("kw_prompt_id"):
            cmd += ["--prompt-id", data["kw_prompt_id"]]
        if data.get("kw_recursive"):
            cmd.append("--recursive")
        if data.get("kw_file"):
            cmd += ["--file", data["kw_file"]]
        return {"label": "Annotate (Keywords)", "cmd": cmd}

    if key == "enable_blur" and data.get(key):
        cmd = ["bash", _script("detect_blurry_photos.sh")]
        if data.get("blur_mode"):
            cmd += ["--mode", data["blur_mode"]]
        if data.get("blur_time_gap"):
            cmd += ["--time-gap", data["blur_time_gap"]]
        if data.get("blur_no_visual"):
            cmd.append("--no-visual")
        if data.get("blur_visual_threshold"):
            cmd += ["--visual-threshold", data["blur_visual_threshold"]]
        if data.get("blur_thumb_size"):
            cmd += ["--thumb-size", data["blur_thumb_size"]]
        if data.get("blur_window"):
            cmd += ["--window", data["blur_window"]]
        if data.get("blur_clean"):
            cmd.append("--clean")
        if data.get("blur_dry_run"):
            cmd.append("--dry-run")
        return {"label": "Detect Blurry Photos", "cmd": cmd}

    if key == "enable_geo_rename" and data.get(key):
        cmd = ["bash", _script("geo_rename_photos.sh")]
        if data.get("geo_structure"):
            cmd += ["--structure", data["geo_structure"]]
        if data.get("geo_dry_run"):
            cmd.append("--dry-run")
        return {"label": "Geo Rename Photos", "cmd": cmd}

    if key == "enable_gopro" and data.get(key):
        cmd = ["bash", _script("gopro_geo_rename.sh")]
        return {"label": "GoPro Geo Rename", "cmd": cmd}

    if key == "enable_contact_sheet" and data.get(key):
        cmd = ["bash", _script("contact_sheet.sh")]
        if data.get("cs_thumb_size"):
            cmd += ["--thumb-size", data["cs_thumb_size"]]
        if data.get("cs_theme"):
            cmd += ["--theme", data["cs_theme"]]
        if data.get("cs_output"):
            cmd += ["--output", data["cs_output"]]
        if data.get("cs_recursive"):
            cmd.append("--recursive")
        return {"label": "Contact Sheet", "cmd": cmd}

    if key == "enable_scrub" and data.get(key):
        cmd = ["bash", _script("scrub_selected_metadata.sh")]
        if data.get("scrub_exif_tags"):
            cmd += ["--exif", data["scrub_exif_tags"]]
        if data.get("scrub_iptc_tags"):
            cmd += ["--iptc", data["scrub_iptc_tags"]]
        if data.get("scrub_recursive"):
            cmd += ["-r", data.get("scrub_recursive_depth", "0")]
        if data.get("scrub_dry_run"):
            cmd.append("--dry-run")
        return {"label": "Scrub Metadata", "cmd": cmd}

    if key == "enable_search" and data.get(key):
        query = data.get("search_query", "")
        if query:
            cmd = ["bash", _script("search_exif_iptc.sh"), "-q", query]
            if data.get("search_fields"):
                cmd += ["-f", data["search_fields"]]
            if data.get("search_media_types"):
                cmd += ["-m", data["search_media_types"]]
            if data.get("search_no_recursive"):
                cmd.append("--no-recursive")
            if data.get("search_fzf"):
                cmd.append("--fzf")
            if data.get("search_copy_to"):
                cmd += ["--copy-to", data["search_copy_to"]]
            return {"label": "Search EXIF/IPTC", "cmd": cmd}

    return None


# Default step order (used when client doesn't send step_order).
# Mirrors the recommended workflow:
#   sync EXIF -> GPS gap fill -> summary -> descriptions -> keywords
#   -> geo rename -> gopro rename -> blur detect -> contact sheet
#   -> scrub -> search
DEFAULT_STEP_ORDER = [
    "enable_sync_exif", "enable_gps_gap_fill", "enable_extract_summary",
    "enable_annotate_desc", "enable_annotate_kw",
    "enable_geo_rename", "enable_gopro", "enable_blur",
    "enable_contact_sheet", "enable_scrub", "enable_search",
]


def build_pipeline(data):
    """Return a list of {label, cmd} dicts in the user's selection order."""
    step_order = data.get("step_order", DEFAULT_STEP_ORDER)
    steps = []
    seen = set()
    for key in step_order:
        if key in seen:
            continue
        seen.add(key)
        step = _build_step(key, data)
        if step:
            steps.append(step)
    # Catch any enabled steps not in step_order (safety fallback)
    for key in DEFAULT_STEP_ORDER:
        if key not in seen:
            step = _build_step(key, data)
            if step:
                steps.append(step)
    return steps


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

PHOTO_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".heic", ".heif",
    ".webp", ".bmp", ".gif", ".dng", ".nef", ".cr2", ".cr3",
    ".arw", ".orf", ".rw2", ".srw", ".raf", ".pef", ".x3f",
}


DOCS_MAP = {
    "sync_exif_and_rename": "sync_exif_and_rename.md",
    "gps_gap_fill": "gps_gap_fill.md",
    "extract_photo_summary": "extract_photo_summary.md",
    "annotate_desc": "annotate_photos_with_ollama.md",
    "annotate_kw": "annotate_photos_with_ollama.md",
    "detect_blurry": "detect_blurry_photos.md",
    "geo_rename": "geo_rename_photos.md",
    "gopro_geo_rename": "gopro_geo_rename.md",
    "contact_sheet": "contact_sheet.md",
    "scrub_metadata": "scrub_selected_metadata.md",
    "search_exif_iptc": "search_exif_iptc.md",
}


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/docs/<doc_key>")
def api_docs(doc_key):
    """Return raw markdown content for a documentation file."""
    filename = DOCS_MAP.get(doc_key)
    if not filename:
        return jsonify({"error": "Unknown doc key"}), 404
    filepath = os.path.join(DOCS_DIR, filename)
    if not os.path.isfile(filepath):
        return jsonify({"error": "Doc file not found"}), 404
    with open(filepath, "r") as f:
        content = f.read()
    return jsonify({"key": doc_key, "filename": filename, "content": content})


@app.route("/api/mermaid_test/<doc_key>")
def api_mermaid_test(doc_key):
    """Debug page: render just the mermaid diagrams from a doc file."""
    import re
    filename = DOCS_MAP.get(doc_key)
    if not filename:
        return "Unknown doc key", 404
    filepath = os.path.join(DOCS_DIR, filename)
    if not os.path.isfile(filepath):
        return "File not found", 404
    with open(filepath, "r") as f:
        content = f.read()
    blocks = re.findall(r'```mermaid\s*\n([\s\S]*?)```', content)
    html = """<!DOCTYPE html>
<html><head>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>mermaid.initialize({startOnLoad:true, theme:'dark'});</script>
</head><body style="background:#1a1a2e;color:#eee;font-family:monospace">
<h2>Mermaid debug: %s</h2>
""" % filename
    for i, block in enumerate(blocks):
        raw = block.strip().replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        html += '<h3>Block %d - raw source:</h3><pre style="background:#0d0d1a;padding:1em;border:1px solid #333">%s</pre>' % (i, raw)
        html += '<h3>Block %d - rendered:</h3><div class="mermaid">\n%s\n</div><hr>' % (i, block.strip())
    html += "</body></html>"
    return html


def _fs_op_with_timeout(fn, timeout=3):
    """Run a filesystem operation in a thread with a timeout.

    Returns (result, error).  On timeout returns (None, 'timeout').
    """
    result = [None]
    error = [None]

    def worker():
        try:
            result[0] = fn()
        except Exception as exc:
            error[0] = exc

    t = threading.Thread(target=worker)
    t.daemon = True
    t.start()
    t.join(timeout)
    if t.is_alive():
        return None, "timeout"
    if error[0]:
        return None, error[0]
    return result[0], None


FS_TIMEOUT_SECONDS = 5


def _normalize_browser_path(path):
    """Normalize user input into an absolute path without resolving mounts."""
    raw = (path or "").strip()
    if not raw:
        raw = os.sep

    normalized = os.path.normpath(os.path.expanduser(raw))
    if not os.path.isabs(normalized):
        normalized = os.path.abspath(normalized)
    return os.path.normpath(normalized)


def _is_filesystem_root(path):
    """Return True when the path is a filesystem root on the current platform."""
    normalized = os.path.normpath(path)
    drive, tail = os.path.splitdrive(normalized)
    if drive:
        return tail in ("", os.sep)
    return normalized == os.sep


def _parent_directory(path):
    """Return the parent directory, or None when already at a root."""
    normalized = os.path.normpath(path)
    if _is_filesystem_root(normalized):
        return None

    parent = os.path.normpath(os.path.dirname(normalized))
    if not parent or parent == normalized:
        return None
    return parent


def _resolve_directory(path, timeout=FS_TIMEOUT_SECONDS):
    """Normalize a path and confirm it is a directory within a bounded time."""
    target = _normalize_browser_path(path)
    is_dir, error = _fs_op_with_timeout(lambda: os.path.isdir(target), timeout=timeout)
    if error:
        return None, error
    if not is_dir:
        return None, FileNotFoundError(target)
    return target, None


def _browse_directory(target, show_hidden):
    """Return the directory payload expected by the folder browser."""
    dirs = []
    skipped_entries = 0

    with os.scandir(target) as it:
        for entry in it:
            if not show_hidden and entry.name.startswith("."):
                continue
            try:
                if entry.is_dir():
                    dirs.append({
                        "name": entry.name,
                        "path": os.path.normpath(os.path.join(target, entry.name)),
                    })
            except (OSError, PermissionError):
                skipped_entries += 1

    dirs.sort(key=lambda item: item["name"].casefold())

    payload = {
        "current": target,
        "parent": _parent_directory(target),
        "dirs": dirs,
    }
    if skipped_entries:
        payload["warning"] = "Some entries could not be inspected."
    return payload


def _count_photos_in_directory(target):
    """Count photo files in the top level of a directory."""
    photo_count = 0
    with os.scandir(target) as it:
        for entry in it:
            try:
                if not entry.is_file():
                    continue
            except (OSError, PermissionError):
                continue
            ext = os.path.splitext(entry.name)[1].lower()
            if ext in PHOTO_EXTENSIONS:
                photo_count += 1
    return photo_count


def _filesystem_error_response(error, *, not_found_message="Directory not found"):
    """Translate filesystem exceptions and timeouts into JSON responses."""
    if error == "timeout":
        return jsonify({
            "error": "Timed out while accessing the directory. "
                     "The mount may be slow, stale, or unavailable."
        }), 504
    if isinstance(error, PermissionError):
        return jsonify({"error": "Permission denied"}), 403
    if isinstance(error, FileNotFoundError):
        return jsonify({"error": not_found_message}), 404
    if isinstance(error, OSError):
        return jsonify({"error": str(error)}), 500
    return jsonify({"error": str(error)}), 500


@app.route("/api/browse_debug")
def api_browse_debug():
    """Diagnostic: show raw filesystem info for a path."""
    path = request.args.get("path", "/").strip()
    target = os.path.normpath(os.path.expanduser(path))
    target_real = None
    try:
        target_real = os.path.realpath(path)
    except Exception as exc:
        target_real = "realpath error: %s" % exc

    info = {
        "input": path,
        "normpath": target,
        "realpath": target_real,
        "isdir_normpath": None,
        "isdir_realpath": None,
        "listdir": None,
        "entries": [],
    }

    try:
        info["isdir_normpath"] = os.path.isdir(target)
    except Exception as exc:
        info["isdir_normpath"] = "error: %s" % exc

    if target_real and not str(target_real).startswith("realpath error"):
        try:
            info["isdir_realpath"] = os.path.isdir(target_real)
        except Exception as exc:
            info["isdir_realpath"] = "error: %s" % exc

    # Try listdir on both paths
    listdir_target = target_real if (
        target_real and not str(target_real).startswith("realpath error")
        and info.get("isdir_realpath")
    ) else target

    try:
        raw_entries = sorted(os.listdir(listdir_target))
        info["listdir"] = {"path_used": listdir_target, "count": len(raw_entries)}
        for entry in raw_entries[:50]:  # cap at 50
            full = os.path.join(listdir_target, entry)
            entry_info = {"name": entry}
            try:
                lst = os.lstat(full)
                entry_info["lstat_mode"] = oct(lst.st_mode)
                entry_info["lstat_isdir"] = stat.S_ISDIR(lst.st_mode)
                entry_info["lstat_islink"] = stat.S_ISLNK(lst.st_mode)
                entry_info["lstat_isreg"] = stat.S_ISREG(lst.st_mode)
            except Exception as exc:
                entry_info["lstat_error"] = str(exc)
            try:
                entry_info["isdir"] = os.path.isdir(full)
            except Exception as exc:
                entry_info["isdir_error"] = str(exc)
            info["entries"].append(entry_info)
    except Exception as exc:
        info["listdir"] = {"error": str(exc)}

    return jsonify(info)


@app.route("/api/browse")
def api_browse():
    """Return subdirectories of a given path for the folder browser."""
    path = request.args.get("path", "")
    show_hidden = request.args.get("hidden", "").lower() in ("1", "true", "yes")
    target, error = _resolve_directory(path)
    if error:
        return _filesystem_error_response(error)

    payload, error = _fs_op_with_timeout(
        lambda: _browse_directory(target, show_hidden),
        timeout=FS_TIMEOUT_SECONDS,
    )
    if error:
        return _filesystem_error_response(error)
    return jsonify(payload)


@app.route("/api/validate_folder")
def api_validate_folder():
    """Check if the folder exists and contains photo files."""
    path = request.args.get("path", "").strip()
    if not path:
        return jsonify({"valid": False, "reason": "No path specified"})

    target, error = _resolve_directory(path)
    if error == "timeout":
        return jsonify({
            "valid": False,
            "reason": "Timed out while accessing the directory. "
                      "The mount may be slow, stale, or unavailable.",
        })
    if isinstance(error, PermissionError):
        return jsonify({"valid": False, "reason": "Permission denied"})
    if error:
        return jsonify({"valid": False, "reason": "Directory does not exist"})

    photo_count, error = _fs_op_with_timeout(
        lambda: _count_photos_in_directory(target),
        timeout=FS_TIMEOUT_SECONDS,
    )
    if error == "timeout":
        return jsonify({
            "valid": False,
            "reason": "Timed out while reading the directory. "
                      "The mount may be slow, stale, or unavailable.",
        })
    if isinstance(error, PermissionError):
        return jsonify({"valid": False, "reason": "Permission denied"})
    if error:
        return jsonify({"valid": False, "reason": str(error)})

    if photo_count == 0:
        return jsonify({
            "valid": True,
            "warning": "Directory exists but contains no photo files",
            "photo_count": 0,
            "path": target,
        })

    return jsonify({
        "valid": True,
        "photo_count": photo_count,
        "path": target,
    })


@app.route("/api/run", methods=["POST"])
def api_run():
    data = request.get_json(force=True)
    photo_dir = data.get("photo_dir", "").strip()
    if not photo_dir:
        return jsonify({"error": "photo_dir is required"}), 400

    steps = build_pipeline(data)
    if not steps:
        return jsonify({"error": "No steps selected"}), 400

    job_id = str(uuid.uuid4())[:8]
    with jobs_lock:
        jobs[job_id] = {
            "status": "running",
            "log": "Photo directory: %s\nSteps: %d\n" % (photo_dir, len(steps)),
            "current_step": 0,
            "steps": [s["label"] for s in steps],
            "pid": None,
        }

    t = threading.Thread(target=_run_pipeline, args=(job_id, steps, photo_dir))
    t.daemon = True
    t.start()

    return jsonify({"job_id": job_id, "steps": [s["label"] for s in steps]})


@app.route("/api/status/<job_id>")
def api_status(job_id):
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "not found"}), 404
    return jsonify({
        "status": job["status"],
        "current_step": job["current_step"],
        "steps": job["steps"],
        "log": job["log"],
    })


@app.route("/api/cancel/<job_id>", methods=["POST"])
def api_cancel(job_id):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            return jsonify({"error": "not found"}), 404
        pid = job.get("pid")
        job["status"] = "cancelled"
        job["log"] += "\n*** Cancelled by user ***\n"

    if pid:
        try:
            os.kill(pid, 9)
        except OSError:
            pass

    return jsonify({"ok": True})


def get_primary_ip():
    """Return the server's primary (non-loopback) IP address."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Doesn't actually send anything; just resolves the route
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="PhotoShell Flask UI")
    parser.add_argument(
        "--primary-ip", action="store_true",
        help="Bind to the server's primary IP (default port becomes 443)")
    parser.add_argument(
        "--host",
        help="Bind address (default: 0.0.0.0, or primary IP with --primary-ip)")
    parser.add_argument(
        "--port", type=int,
        help="Port number (default: 5050, or 443 with --primary-ip)")
    args = parser.parse_args()

    if args.primary_ip:
        host = args.host or get_primary_ip()
        port = args.port or 443
    else:
        host = args.host or "0.0.0.0"
        port = args.port or 5050

    print("Starting PhotoShell on %s:%d" % (host, port))
    app.run(debug=True, host=host, port=port)
