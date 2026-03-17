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


@app.route("/api/browse")
def api_browse():
    """Return subdirectories of a given path for the folder browser."""
    path = request.args.get("path", "/").strip()
    show_hidden = request.args.get("hidden", "").lower() in ("1", "true", "yes")
    if not path:
        path = "/"

    # Expand ~ but do NOT resolve symlinks (realpath can hang on network mounts)
    target = os.path.expanduser(path)

    # Normalize without resolving symlinks: collapse .. and redundant slashes
    target = os.path.normpath(target)

    # Check that the target is a directory (with timeout for network mounts)
    is_dir, err = _fs_op_with_timeout(lambda: os.path.isdir(target))
    if err == "timeout":
        return jsonify({"error": "Timed out accessing path (may be an unresponsive network mount)"}), 504
    if err:
        return jsonify({"error": str(err)}), 500

    if not is_dir:
        # Try parent
        target = os.path.dirname(target)
        is_dir2, err2 = _fs_op_with_timeout(lambda: os.path.isdir(target))
        if err2 or not is_dir2:
            return jsonify({"error": "Directory not found"}), 404

    # List entries (with timeout)
    entries_result, err = _fs_op_with_timeout(lambda: sorted(os.listdir(target)), timeout=5)
    if err == "timeout":
        return jsonify({
            "current": target,
            "parent": os.path.dirname(target) if target != "/" else None,
            "dirs": [],
            "warning": "Timed out listing directory (slow or unresponsive mount)",
        })
    if err:
        exc = err
        if isinstance(exc, PermissionError):
            return jsonify({"error": "Permission denied"}), 403
        return jsonify({"error": str(exc)}), 500

    entries = entries_result

    # Classify entries as directories. Use a short per-entry timeout
    # to avoid hanging on individual stale mount points.
    dirs = []
    stale = []
    for entry in entries:
        if not show_hidden and entry.startswith("."):
            continue
        full = os.path.join(target, entry)

        # Try lstat first (does not follow symlinks, fast, no network roundtrip)
        try:
            lst = os.lstat(full)
        except (OSError, PermissionError):
            continue

        if stat.S_ISDIR(lst.st_mode):
            dirs.append(entry)
        elif stat.S_ISLNK(lst.st_mode):
            # Symlink: try to resolve with a timeout (may point to network mount)
            is_link_dir, lerr = _fs_op_with_timeout(lambda f=full: os.path.isdir(f), timeout=2)
            if lerr == "timeout":
                # Include it but mark as potentially stale
                stale.append(entry)
                dirs.append(entry)
            elif is_link_dir:
                dirs.append(entry)

    parent = os.path.dirname(target) if target != "/" else None

    resp = {
        "current": target,
        "parent": parent,
        "dirs": dirs,
    }
    if stale:
        resp["warning"] = "Some entries may be slow/unresponsive: " + ", ".join(stale)

    return jsonify(resp)


@app.route("/api/validate_folder")
def api_validate_folder():
    """Check if the folder exists and contains photo files."""
    path = request.args.get("path", "").strip()
    if not path:
        return jsonify({"valid": False, "reason": "No path specified"})

    try:
        target = os.path.realpath(os.path.expanduser(path))
    except Exception:
        return jsonify({"valid": False, "reason": "Invalid path"})

    if not os.path.isdir(target):
        return jsonify({"valid": False, "reason": "Directory does not exist"})

    # Count photo files (non-recursive, first level only)
    photo_count = 0
    try:
        for entry in os.listdir(target):
            ext = os.path.splitext(entry)[1].lower()
            if ext in PHOTO_EXTENSIONS:
                photo_count += 1
    except PermissionError:
        return jsonify({"valid": False, "reason": "Permission denied"})

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
