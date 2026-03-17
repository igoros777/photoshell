#!/usr/bin/env python3
"""PhotoShell Flask UI - run photo-processing scripts as a workflow."""

import argparse
import glob
import json
import os
import socket
import subprocess
import threading
import time
import uuid
from pathlib import Path

from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

# Resolve the scripts directory relative to this file
SCRIPTS_DIR = str(Path(__file__).resolve().parent.parent.parent / "scripts")

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


def build_pipeline(data):
    """Return a list of {label, cmd} dicts from the submitted form."""
    photo_dir = data["photo_dir"]
    steps = []

    # 1) sync_exif_and_rename
    if data.get("enable_sync_exif"):
        cmd = ["bash", _script("sync_exif_and_rename.sh"), photo_dir]
        if data.get("sync_orig_dir"):
            cmd += ["--orig-dir", data["sync_orig_dir"]]
        if data.get("sync_dry_run"):
            cmd.append("--dry-run")
        steps.append({"label": "Sync EXIF & Rename", "cmd": cmd})

    # 2) gps_gap_fill
    if data.get("enable_gps_gap_fill"):
        cmd = ["bash", _script("gps_gap_fill.sh")]
        if data.get("gps_dry_run"):
            cmd.append("--dry-run")
        steps.append({"label": "GPS Gap Fill", "cmd": cmd})

    # 3) extract_photo_summary (via find + xargs)
    if data.get("enable_extract_summary"):
        script_path = _script("extract_photo_summary.sh")
        cmd = [
            "bash", "-c",
            'find ./ -maxdepth 1 -type f \\( -iname "*.jpg" -o -iname "*.jpeg" \\) '
            '-print0 | xargs -0 -I{} bash "%s" "{}"' % script_path,
        ]
        steps.append({"label": "Extract Photo Summary", "cmd": cmd})

    # 4) annotate - description
    if data.get("enable_annotate_desc"):
        cmd = ["bash", _script("annotate_photos_with_ollama.sh"), "--description"]
        if data.get("desc_model"):
            cmd += ["-m", data["desc_model"]]
        if data.get("desc_prompt_id"):
            cmd += ["--prompt-id", data["desc_prompt_id"]]
        if data.get("desc_recursive"):
            cmd.append("--recursive")
        if data.get("desc_file"):
            cmd += ["--file", data["desc_file"]]
        steps.append({"label": "Annotate (Description)", "cmd": cmd})

    # 5) annotate - keywords
    if data.get("enable_annotate_kw"):
        cmd = ["bash", _script("annotate_photos_with_ollama.sh"), "--keywords"]
        if data.get("kw_model"):
            cmd += ["-m", data["kw_model"]]
        if data.get("kw_prompt_id"):
            cmd += ["--prompt-id", data["kw_prompt_id"]]
        if data.get("kw_recursive"):
            cmd.append("--recursive")
        if data.get("kw_file"):
            cmd += ["--file", data["kw_file"]]
        steps.append({"label": "Annotate (Keywords)", "cmd": cmd})

    # 6) detect_blurry_photos
    if data.get("enable_blur"):
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
        steps.append({"label": "Detect Blurry Photos", "cmd": cmd})

    # 7) geo_rename_photos
    if data.get("enable_geo_rename"):
        cmd = ["bash", _script("geo_rename_photos.sh")]
        if data.get("geo_structure"):
            cmd += ["--structure", data["geo_structure"]]
        if data.get("geo_dry_run"):
            cmd.append("--dry-run")
        steps.append({"label": "Geo Rename Photos", "cmd": cmd})

    # 8) gopro_geo_rename
    if data.get("enable_gopro"):
        cmd = ["bash", _script("gopro_geo_rename.sh")]
        steps.append({"label": "GoPro Geo Rename", "cmd": cmd})

    # 9) contact_sheet
    if data.get("enable_contact_sheet"):
        cmd = ["bash", _script("contact_sheet.sh")]
        if data.get("cs_thumb_size"):
            cmd += ["--thumb-size", data["cs_thumb_size"]]
        if data.get("cs_theme"):
            cmd += ["--theme", data["cs_theme"]]
        if data.get("cs_output"):
            cmd += ["--output", data["cs_output"]]
        if data.get("cs_recursive"):
            cmd.append("--recursive")
        steps.append({"label": "Contact Sheet", "cmd": cmd})

    # 10) scrub_selected_metadata
    if data.get("enable_scrub"):
        cmd = ["bash", _script("scrub_selected_metadata.sh")]
        if data.get("scrub_exif_tags"):
            cmd += ["--exif", data["scrub_exif_tags"]]
        if data.get("scrub_iptc_tags"):
            cmd += ["--iptc", data["scrub_iptc_tags"]]
        if data.get("scrub_recursive"):
            cmd += ["-r", data.get("scrub_recursive_depth", "0")]
        if data.get("scrub_dry_run"):
            cmd.append("--dry-run")
        steps.append({"label": "Scrub Metadata", "cmd": cmd})

    # 11) search_exif_iptc
    if data.get("enable_search"):
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
            steps.append({"label": "Search EXIF/IPTC", "cmd": cmd})

    return steps


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

PHOTO_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".heic", ".heif",
    ".webp", ".bmp", ".gif", ".dng", ".nef", ".cr2", ".cr3",
    ".arw", ".orf", ".rw2", ".srw", ".raf", ".pef", ".x3f",
}


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/browse")
def api_browse():
    """Return subdirectories of a given path for the folder browser."""
    path = request.args.get("path", "/").strip()
    if not path:
        path = "/"

    # Normalize and resolve
    try:
        target = os.path.realpath(os.path.expanduser(path))
    except Exception:
        return jsonify({"error": "Invalid path"}), 400

    if not os.path.isdir(target):
        # Try parent
        target = os.path.dirname(target)
        if not os.path.isdir(target):
            return jsonify({"error": "Directory not found"}), 404

    dirs = []
    try:
        for entry in sorted(os.listdir(target)):
            full = os.path.join(target, entry)
            if os.path.isdir(full) and not entry.startswith("."):
                dirs.append(entry)
    except PermissionError:
        return jsonify({"error": "Permission denied"}), 403

    parent = os.path.dirname(target) if target != "/" else None

    return jsonify({
        "current": target,
        "parent": parent,
        "dirs": dirs,
    })


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
