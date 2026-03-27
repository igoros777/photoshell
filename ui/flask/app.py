#!/usr/bin/env python3
"""PhotoShell Flask UI - run photo-processing scripts as a workflow."""

import argparse
import glob
import json
import logging
import os
import platform
import re
import shlex
import shutil
import socket
import stat
import string
import subprocess
import threading
import time
import uuid
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlparse

from flask import Flask, jsonify, render_template, request, send_file

from functions.advisory_checks import run_advisory_checks, scan_folder_metadata, extract_gps_data
from functions.constants import (
    DEFAULT_STEP_ORDER,
    PHOTO_EXTENSIONS,
    STEP_PREFLIGHT_LABELS,
    STEP_TOOL_DEPS,
    TOOL_LABELS,
)
from functions.catalog import catalog_exists, catalog_stats, catalog_search, catalog_discover, catalog_remove, get_catalog_path
from functions.structured_search import count_photo_files, discover_fields, structured_search

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("photoshell")

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Rate limiting (in-memory, per IP)
# ---------------------------------------------------------------------------

_request_times = defaultdict(list)
_RATE_LIMIT_PER_MINUTE = 120


@app.before_request
def _rate_limit():
    now = time.time()
    ip = request.remote_addr or "unknown"
    times = _request_times[ip]
    # Remove entries older than 60 seconds; clean up dead IPs
    active = [t for t in times if now - t < 60]
    if not active:
        _request_times.pop(ip, None)
        return
    _request_times[ip] = active
    if len(active) >= _RATE_LIMIT_PER_MINUTE:
        return jsonify({"error": "Rate limit exceeded. Try again in a moment."}), 429
    _request_times[ip].append(now)


# ---------------------------------------------------------------------------
# CSRF protection
# ---------------------------------------------------------------------------


@app.before_request
def _csrf_check():
    """Validate Origin/Referer on state-changing requests."""
    if request.method not in ("POST", "PUT", "DELETE"):
        return
    origin = request.headers.get("Origin", "")
    referer = request.headers.get("Referer", "")
    host = request.host
    if origin:
        if urlparse(origin).netloc != host:
            return jsonify({"error": "CSRF validation failed"}), 403
    elif referer:
        if urlparse(referer).netloc != host:
            return jsonify({"error": "CSRF validation failed"}), 403

@app.after_request
def _no_cache_html(response):
    """Prevent browser caching of HTML pages so UI updates are always fresh."""
    if response.content_type and "text/html" in response.content_type:
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

# Resolve directories relative to this file
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS_DIR = str(REPO_ROOT / "scripts")
DOCS_DIR = str(REPO_ROOT / "docs")
PRESETS_DIR = str(REPO_ROOT / ".photoshell" / "presets")
PHOTOSHELL_DIR = str(REPO_ROOT / ".photoshell")

_PRESET_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]+$")

# In-memory job store: job_id -> {status, log, current_step, steps, pid, created_at}
jobs = {}
jobs_lock = threading.Lock()

STEP_TIMEOUT_SECONDS = 1800  # 30 minutes
_JOB_TTL_SECONDS = 3600  # 1 hour


def _cleanup_stale_jobs():
    now = time.time()
    with jobs_lock:
        stale = [jid for jid, job in jobs.items()
                 if job.get("status") in ("done", "failed")
                 and now - job.get("created_at", now) > _JOB_TTL_SECONDS]
        for jid in stale:
            del jobs[jid]
        if stale:
            logger.info("Cleaned up %d stale jobs", len(stale))


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

    start_time = time.time()
    try:
        # Wrap command with stdbuf for line-buffered output on pipes
        if shutil.which("stdbuf"):
            run_cmd = ["stdbuf", "-oL"] + cmd
        else:
            run_cmd = cmd

        proc = subprocess.Popen(
            run_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=cwd,
            bufsize=1,
            encoding="utf-8",
            errors="replace",
        )
        with jobs_lock:
            jobs[job_id]["pid"] = proc.pid

        kill_timer = threading.Timer(STEP_TIMEOUT_SECONDS, lambda: proc.kill())
        kill_timer.start()
        try:
            # Use readline() for true line-at-a-time streaming
            while True:
                line = proc.stdout.readline()
                if not line and proc.poll() is not None:
                    break
                if line:
                    with jobs_lock:
                        jobs[job_id]["log"] += line
            proc.wait()
            rc = proc.returncode
        finally:
            kill_timer.cancel()

        if rc == -9:  # killed by timer
            with jobs_lock:
                jobs[job_id]["log"] += "\n[TIMEOUT] Step killed after %d seconds\n" % STEP_TIMEOUT_SECONDS
    except Exception as exc:
        rc = -1
        with jobs_lock:
            jobs[job_id]["log"] += "\n[ERROR] %s\n" % str(exc)
        logger.error("Step %d failed: %s", step_index, exc)

    elapsed = time.time() - start_time
    with jobs_lock:
        jobs[job_id]["log"] += "\n[Exit code: %d] (%.1fs)\n" % (rc, elapsed)
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
            logger.info("Job %s failed at step %d", job_id, i)
            return

    with jobs_lock:
        jobs[job_id]["status"] = "done"
        jobs[job_id]["log"] += "\n*** All steps completed successfully ***\n"
    logger.info("Job %s completed successfully", job_id)


def _run_project_pipeline(job_id, data, folders):
    """Run the full pipeline for each folder in sequence.

    Skips failed folders and continues with the next. Updates
    job["folders"] with per-folder status.
    """
    total = len(folders)
    failed_folders = []
    for fi, folder in enumerate(folders):
        folder_name = os.path.basename(folder)
        with jobs_lock:
            job = jobs[job_id]
            job["current_folder"] = fi
            job["log"] += "\n" + "#" * 60 + "\n"
            job["log"] += "# Folder %d/%d: %s\n" % (fi + 1, total, folder_name)
            job["log"] += "#" * 60 + "\n"
            job["folders"][fi]["status"] = "running"

        # Build pipeline for this folder
        folder_data = dict(data)
        folder_data["photo_dir"] = folder
        steps = build_pipeline(folder_data)
        if not steps:
            with jobs_lock:
                jobs[job_id]["log"] += "\n*** No steps to run for %s ***\n" % folder_name
                jobs[job_id]["folders"][fi]["status"] = "skipped"
            continue

        folder_failed = False
        for i, step in enumerate(steps):
            with jobs_lock:
                jobs[job_id]["current_step"] = i
            rc = _run_step(job_id, i, step["cmd"], folder)
            if rc != 0:
                with jobs_lock:
                    jobs[job_id]["log"] += "\n*** Folder %s failed at step %d — skipping ***\n" % (folder_name, i)
                    jobs[job_id]["folders"][fi]["status"] = "failed"
                failed_folders.append(folder_name)
                folder_failed = True
                break

        if not folder_failed:
            with jobs_lock:
                jobs[job_id]["folders"][fi]["status"] = "done"

    with jobs_lock:
        if failed_folders:
            jobs[job_id]["status"] = "done"
            jobs[job_id]["log"] += "\n*** Project completed with %d failed folder(s): %s ***\n" % (
                len(failed_folders), ", ".join(failed_folders))
        else:
            jobs[job_id]["status"] = "done"
            jobs[job_id]["log"] += "\n*** All %d folders completed successfully ***\n" % total
    logger.info("Project job %s completed (%d folders, %d failed)", job_id, total, len(failed_folders))


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

    if key == "enable_gps_set_loc" and data.get(key):
        location = data.get("gps_set_location", "").strip()
        if not location:
            return None
        cmd = ["bash", _script("gps_set_location.sh"), "-l", location]
        spread = data.get("gps_set_spread", "").strip()
        if spread and spread != "0":
            cmd += ["-s", spread]
            unit = data.get("gps_set_unit", "miles").strip()
            if unit:
                cmd += ["-u", unit]
        if data.get("gps_set_recursive"):
            cmd.append("--recursive")
        if data.get("gps_set_types"):
            cmd += ["-t", data["gps_set_types"]]
        if data.get("gps_set_force"):
            cmd.append("--force")
        return {"label": "Set GPS Location", "cmd": cmd}

    if key == "enable_extract_summary" and data.get(key):
        script_path = _script("extract_photo_summary.sh")
        cmd = ["find", ".", "-maxdepth", "1", "-type", "f",
               "(", "-iname", "*.jpg", "-o", "-iname", "*.jpeg", ")",
               "-exec", "bash", script_path]
        if data.get("location_override"):
            cmd += ["--location", data["location_override"]]
        cmd += ["{}", ";"]
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

    if key == "enable_annotate_hl" and data.get(key):
        cmd = ["bash", _script("annotate_photos_with_ollama.sh"), "--headline"]
        if data.get("hl_model"):
            cmd += ["-m", data["hl_model"]]
        if data.get("hl_prompt_id"):
            cmd += ["--prompt-id", data["hl_prompt_id"]]
        if data.get("hl_recursive"):
            cmd.append("--recursive")
        if data.get("hl_file"):
            cmd += ["--file", data["hl_file"]]
        return {"label": "Annotate (Headline)", "cmd": cmd}

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
        if data.get("location_override"):
            cmd += ["--location", data["location_override"]]
        if data.get("geo_dry_run"):
            cmd.append("--dry-run")
        return {"label": "Geo Rename Photos", "cmd": cmd}

    if key == "enable_gopro" and data.get(key):
        cmd = ["bash", _script("gopro_geo_rename.sh")]
        if data.get("location_override"):
            cmd += ["--location", data["location_override"]]
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
        if data.get("cs_max_per_sheet"):
            cmd += ["--max-per-sheet", data["cs_max_per_sheet"]]
        return {"label": "Contact Sheet", "cmd": cmd}

    if key == "enable_metadata_replace" and data.get(key):
        search_text = data.get("mr_search", "").strip()
        replace_text = data.get("mr_replace", "")
        if not search_text:
            return None
        cmd = ["bash", _script("metadata_replace.sh"), "-s", search_text, "-R", replace_text]
        if data.get("mr_fields"):
            cmd += ["-F", data["mr_fields"]]
        if data.get("mr_ignore_case"):
            cmd.append("--ignore-case")
        if data.get("mr_whole_word"):
            cmd.append("--whole-word")
        if data.get("mr_regex"):
            cmd.append("--regex")
        if data.get("mr_recursive"):
            cmd.append("--recursive")
        if data.get("mr_types"):
            cmd += ["-t", data["mr_types"]]
        if data.get("mr_dry_run"):
            cmd.append("--dry-run")
        return {"label": "Metadata Replace", "cmd": cmd}

    if key == "enable_metadata_copyright" and data.get(key):
        cmd = ["bash", _script("metadata_copyright.sh")]
        if data.get("mc_author"):
            cmd += ["-a", data["mc_author"]]
        if data.get("mc_copyright"):
            cmd += ["-c", data["mc_copyright"]]
        if data.get("mc_email"):
            cmd += ["-e", data["mc_email"]]
        if data.get("mc_website"):
            cmd += ["-w", data["mc_website"]]
        if data.get("mc_credit"):
            cmd += ["--credit", data["mc_credit"]]
        if data.get("mc_source"):
            cmd += ["--source", data["mc_source"]]
        if data.get("mc_force"):
            cmd.append("--force")
        if data.get("mc_recursive"):
            cmd.append("--recursive")
        if data.get("mc_types"):
            cmd += ["-t", data["mc_types"]]
        return {"label": "Copyright / Creator", "cmd": cmd}

    if key == "enable_metadata_consistency" and data.get(key):
        cmd = ["bash", _script("metadata_consistency.sh")]
        field = data.get("mcon_field", "Caption-Abstract").strip()
        if field:
            cmd += ["-F", field]
        if data.get("mcon_model"):
            cmd += ["-m", data["mcon_model"]]
        if data.get("mcon_fix"):
            cmd.append("--fix")
        if data.get("mcon_recursive"):
            cmd.append("--recursive")
        if data.get("mcon_types"):
            cmd += ["-t", data["mcon_types"]]
        return {"label": "Consistency Audit", "cmd": cmd}

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

    return None


# DEFAULT_STEP_ORDER is imported from functions.constants


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
# Tool dependency preflight check
# ---------------------------------------------------------------------------

# STEP_TOOL_DEPS, TOOL_LABELS, STEP_PREFLIGHT_LABELS are imported from
# functions.constants


OLLAMA_BASE_URL = os.environ.get("OLLAMA_HOST", "http://localhost:11434")


def _check_tool(name):
    """Check if a tool is available on the system.

    Returns (available: bool, resolved_name: str).
    For 'imagemagick', checks magick first (IM7), then falls back to
    identify+convert (IM6).
    For 'ollama', checks both the binary AND that the server is running.
    """
    if name == "imagemagick":
        if shutil.which("magick"):
            return True, "magick (ImageMagick 7)"
        # IM6 fallback: need at least identify and convert
        im6_tools = ["identify", "convert", "montage"]
        found = [t for t in im6_tools if shutil.which(t)]
        if len(found) == len(im6_tools):
            return True, "identify/convert/montage (ImageMagick 6)"
        missing = [t for t in im6_tools if t not in found]
        return False, "missing: " + ", ".join(missing)
    if name == "ollama":
        if not shutil.which("ollama"):
            return False, "ollama binary not found"
        # Check that ollama serve is actually running
        import urllib.request
        try:
            req = urllib.request.urlopen(OLLAMA_BASE_URL + "/api/version", timeout=3)
            req.read()
            return True, "ollama (server running)"
        except Exception:
            return False, "ollama installed but server not running — run: ollama serve"
    return bool(shutil.which(name)), name


def run_preflight(enabled_steps):
    """Check that all required tools for enabled steps are available.

    Returns a dict with:
      ok       - bool, True if all tools are present
      tools    - dict of tool -> {available, resolved, needed_by}
      missing  - list of {tool, label, needed_by} for unavailable tools
    """
    # Collect all unique tools needed and which steps need them
    tool_steps = {}  # tool -> set of step labels
    for key in enabled_steps:
        deps = STEP_TOOL_DEPS.get(key, [])
        for tool in deps:
            if tool not in tool_steps:
                tool_steps[tool] = set()
            tool_steps[tool].add(STEP_PREFLIGHT_LABELS.get(key, key))

    tools_result = {}
    missing = []

    for tool, step_labels in sorted(tool_steps.items()):
        available, resolved = _check_tool(tool)
        tools_result[tool] = {
            "available": available,
            "resolved": resolved,
            "needed_by": sorted(step_labels),
        }
        if not available:
            missing.append({
                "tool": tool,
                "label": TOOL_LABELS.get(tool, tool),
                "needed_by": sorted(step_labels),
            })

    return {
        "ok": len(missing) == 0,
        "tools": tools_result,
        "missing": missing,
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

# PHOTO_EXTENSIONS is imported from functions.constants


DOCS_MAP = {
    "sync_exif_and_rename": "sync_exif_and_rename.md",
    "gps_gap_fill": "gps_gap_fill.md",
    "gps_set_location": "gps_set_location.md",
    "metadata_replace": "metadata_replace.md",
    "metadata_copyright": "metadata_copyright.md",
    "metadata_consistency": "metadata_consistency.md",
    "extract_photo_summary": "extract_photo_summary.md",
    "annotate_desc": "annotate_photos_with_ollama.md",
    "annotate_kw": "annotate_photos_with_ollama.md",
    "annotate_hl": "annotate_photos_with_ollama.md",
    "detect_blurry": "detect_blurry_photos.md",
    "geo_rename": "geo_rename_photos.md",
    "gopro_geo_rename": "gopro_geo_rename.md",
    "contact_sheet": "contact_sheet.md",
    "scrub_metadata": "scrub_selected_metadata.md",
    "search_exif_iptc": "search_exif_iptc.md",
    "web_ui_help": "web_ui_help.md",
    "design_system": "../DESIGN.md",
}


PROMPTS_FILES = {
    "description": os.path.join(SCRIPTS_DIR, "annotate_photos_with_ollama.prompts.txt"),
    "keywords": os.path.join(SCRIPTS_DIR, "annotate_photos_with_ollama.keywords.prompts.txt"),
    "headline": os.path.join(SCRIPTS_DIR, "annotate_photos_with_ollama.headline.prompts.txt"),
}

BUILTIN_PROMPTS = {
    "description": "Provide a concise description about the scene and photographic aspects. "
                   "Include some details about the photo's location: LOCATION. "
                   "Do not include any formatting or commentary.",
    "keywords": "Generate 8 to 15 concise, search-friendly keywords for this photo. "
                "Focus on subject, scene type, location, lighting, weather, mood, "
                "and photographic technique. Incorporate the location naturally: LOCATION. "
                "Return keywords only as a comma-separated list. No numbering, quotes, "
                "or commentary.",
}


def _parse_prompts_file(filepath):
    """Parse a prompts file. Returns list of {id, text}."""
    prompts = []
    if not os.path.isfile(filepath):
        return prompts
    with open(filepath, "r") as f:
        for line in f:
            line = line.strip().rstrip("\r")
            if not line or line.startswith("#"):
                continue
            import re as _re
            m = _re.match(r"^(\d+)\s*\|\s*(.+)$", line)
            if m:
                prompts.append({"id": int(m.group(1)), "text": m.group(2).strip()})
    return prompts


@app.route("/api/prompts/<workflow>")
def api_prompts(workflow):
    """Return all prompts for a workflow (description or keywords).

    Includes the built-in default as ID 0.
    """
    if workflow not in PROMPTS_FILES:
        return jsonify({"error": "Unknown workflow: %s" % workflow}), 404

    builtin = BUILTIN_PROMPTS.get(workflow, "")
    prompts = [{"id": 0, "text": builtin, "source": "built-in"}]

    filepath = PROMPTS_FILES[workflow]
    file_prompts = _parse_prompts_file(filepath)
    for p in file_prompts:
        p["source"] = "file"
        prompts.append(p)

    return jsonify({"workflow": workflow, "prompts": prompts, "file": filepath})


@app.route("/api/prompts/<workflow>/save", methods=["POST"])
def api_prompts_save(workflow):
    """Save a new or updated prompt to the prompts file."""
    if workflow not in PROMPTS_FILES:
        return jsonify({"error": "Unknown workflow: %s" % workflow}), 404

    data = request.get_json(force=True)
    prompt_id = data.get("id")
    prompt_text = (data.get("text") or "").strip()

    if prompt_id is None or not prompt_text:
        return jsonify({"error": "Both 'id' and 'text' are required"}), 400

    try:
        prompt_id = int(prompt_id)
    except (ValueError, TypeError):
        return jsonify({"error": "Prompt ID must be an integer"}), 400

    if prompt_id == 0:
        return jsonify({"error": "Cannot overwrite the built-in prompt (ID 0)"}), 400

    # Clean the text: single line, no pipe chars
    prompt_text = prompt_text.replace("\n", " ").replace("\r", " ").strip()

    filepath = PROMPTS_FILES[workflow]

    # Read existing prompts
    existing = _parse_prompts_file(filepath)
    replaced = False
    for p in existing:
        if p["id"] == prompt_id:
            p["text"] = prompt_text
            replaced = True
            break

    if not replaced:
        existing.append({"id": prompt_id, "text": prompt_text})

    # Write back
    existing.sort(key=lambda p: p["id"])
    with open(filepath, "w") as f:
        f.write("# Format: <integer>|<prompt text>\n")
        for p in existing:
            f.write("%d|%s\n" % (p["id"], p["text"]))

    logger.info("Saved prompt ID %d for %s workflow", prompt_id, workflow)
    return jsonify({"ok": True, "id": prompt_id, "workflow": workflow})


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/ollama_models")
def api_ollama_models():
    """List installed Ollama models, flagging which support vision (images).

    Vision models have 'clip' in their model families (the image encoder).
    Returns: {models: [{name, size, vision, families}, ...], default: str}
    """
    import urllib.request
    try:
        req = urllib.request.urlopen(OLLAMA_BASE_URL + "/api/tags", timeout=5)
        data = json.loads(req.read().decode("utf-8"))
    except Exception as exc:
        logger.warning("Cannot reach Ollama API: %s", exc)
        return jsonify({"error": "Ollama server not reachable", "models": []}), 503

    models = []
    for m in data.get("models", []):
        name = m.get("name", "")
        size_bytes = m.get("size", 0)
        size_gb = round(size_bytes / (1024 ** 3), 1) if size_bytes else 0
        families = []
        details = m.get("details", {})
        if isinstance(details, dict):
            families = details.get("families", []) or []
            if details.get("family"):
                families = families or [details["family"]]
        is_vision = "clip" in families
        models.append({
            "name": name,
            "size_gb": size_gb,
            "vision": is_vision,
            "families": families,
        })

    # Sort: vision models first, then alphabetically
    models.sort(key=lambda x: (not x["vision"], x["name"]))

    # Pick a sensible default: first vision model, or first model overall
    default = ""
    for md in models:
        if md["vision"]:
            default = md["name"]
            break
    if not default and models:
        default = models[0]["name"]

    return jsonify({"models": models, "default": default})


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


IS_WINDOWS = os.name == "nt"

# Detect WSL (Linux running under Windows Subsystem for Linux).
# WSL exposes Windows drives under /mnt/<letter>/.
_IS_WSL = False
if not IS_WINDOWS:
    try:
        _IS_WSL = "microsoft" in platform.uname().release.lower()
    except Exception:
        pass

# Regex for WSL-style paths: /mnt/c/... and Windows-style: C:\...
_WSL_PATH_RE = re.compile(r"^/mnt/([a-zA-Z])(/.*)?$")
_WIN_PATH_RE = re.compile(r"^([a-zA-Z]):[/\\]")


def _normalize_browser_path(path):
    """Normalize user input into an absolute path.

    Handles cross-platform path styles:
    - On native Windows: ``/mnt/c/...`` -> ``C:\\...``, forward slashes OK
    - On WSL (Linux under Windows): ``C:\\Photos`` -> ``/mnt/c/Photos``
    - On plain Linux: just normalize as usual
    """
    raw = (path or "").strip()
    if not raw:
        raw = os.sep

    if IS_WINDOWS:
        # ---- Native Windows ----

        # Translate /mnt/X/... -> X:\...
        m = _WSL_PATH_RE.match(raw)
        if m:
            drive = m.group(1).upper()
            rest = (m.group(2) or "").replace("/", "\\")
            raw = drive + ":" + (rest if rest else "\\")

        # Accept bare "/" on Windows as drive root
        if raw == "/":
            raw = os.environ.get("SystemDrive", "C:") + "\\"

        # Translate forward slashes
        raw = raw.replace("/", "\\")

        # Accept bare drive letter (e.g. "C:" -> "C:\")
        if len(raw) == 2 and raw[1] == ":":
            raw = raw + "\\"

    elif _IS_WSL:
        # ---- WSL (Linux under Windows) ----

        # Translate C:\... or C:/... -> /mnt/c/...
        m = _WIN_PATH_RE.match(raw)
        if m:
            drive = m.group(1).lower()
            # Strip the "C:" or "C:\" prefix, convert backslashes
            rest = raw[2:].replace("\\", "/")
            if rest and not rest.startswith("/"):
                rest = "/" + rest
            raw = "/mnt/" + drive + rest

        # Also translate any remaining backslashes (e.g. mixed paths)
        raw = raw.replace("\\", "/")

    else:
        # ---- Plain Linux / macOS ----
        # Translate backslashes just in case
        if "\\" in raw and not raw.startswith("/"):
            raw = raw.replace("\\", "/")

    normalized = os.path.normpath(os.path.expanduser(raw))
    if not os.path.isabs(normalized):
        normalized = os.path.abspath(normalized)
    return os.path.normpath(normalized)


def _sanitize_path(path):
    """Validate and sanitize a user-supplied path for safe filesystem access.

    - Normalizes via _normalize_browser_path (handles cross-platform styles)
    - Rejects null bytes (path injection vector)
    - Resolves to an absolute, normalized path
    - Returns the sanitized path or raises ValueError if unsafe

    This satisfies CodeQL's "Uncontrolled data used in path expression" rule
    by ensuring user input is validated before any filesystem operation.
    """
    if not path or not path.strip():
        raise ValueError("Empty path")
    if "\x00" in path:
        raise ValueError("Null byte in path")
    sanitized = _normalize_browser_path(path)
    # Ensure the result is absolute
    if not os.path.isabs(sanitized):
        raise ValueError("Path is not absolute: %s" % sanitized)
    return sanitized


def _sanitize_file_path(path):
    """Sanitize a user-supplied file path and verify it has a photo extension.

    Returns the sanitized absolute path.
    Raises ValueError if the path is unsafe or not a recognized photo file.
    """
    sanitized = _sanitize_path(path)
    ext = os.path.splitext(sanitized)[1].lower()
    if ext not in PHOTO_EXTENSIONS:
        raise ValueError("Not a recognized photo file: %s" % ext)
    return sanitized


def _sanitize_dir_path(path):
    """Sanitize a user-supplied directory path.

    Returns the sanitized absolute path.
    Raises ValueError if the path is unsafe.
    """
    return _sanitize_path(path)


def _list_drives():
    """Return available drive letters.

    On native Windows returns e.g. ``['C:', 'D:']``.
    On WSL returns drives found under ``/mnt/`` (e.g. ``['C:', 'D:']``).
    On plain Linux returns an empty list.
    """
    if IS_WINDOWS:
        drives = []
        for letter in string.ascii_uppercase:
            drive = letter + ":" + os.sep
            try:
                if os.path.isdir(drive):
                    drives.append(letter + ":")
            except OSError:
                pass
        return drives

    if _IS_WSL:
        drives = []
        mnt = "/mnt"
        try:
            for entry in os.scandir(mnt):
                if (len(entry.name) == 1
                        and entry.name.isalpha()
                        and entry.is_dir()):
                    drives.append(entry.name.upper() + ":")
        except OSError:
            pass
        drives.sort()
        return drives

    return []


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
    """Normalize a path and confirm it is a directory within a bounded time.

    When the exact path does not exist, the last component is treated as a
    case-insensitive prefix and matched against sibling directories.  For
    example ``/mnt/c/zip/ograph`` will resolve to ``/mnt/c/zip/Photography``
    if that is the only directory whose name starts with ``ograph`` (case-
    insensitive).
    """
    target = _normalize_browser_path(path)
    is_dir, error = _fs_op_with_timeout(lambda: os.path.isdir(target), timeout=timeout)
    if error:
        return None, error
    if is_dir:
        return target, None

    # Exact path not found — try partial/prefix match on the last component
    parent = os.path.dirname(target)
    partial = os.path.basename(target)
    if not partial or not parent:
        return None, FileNotFoundError(target)

    is_parent_dir, error = _fs_op_with_timeout(
        lambda: os.path.isdir(parent), timeout=timeout)
    if error or not is_parent_dir:
        return None, FileNotFoundError(target)

    def _find_prefix_match():
        prefix = partial.casefold()
        matches = []
        with os.scandir(parent) as it:
            for entry in it:
                try:
                    if entry.is_dir() and entry.name.casefold().startswith(prefix):
                        matches.append(entry.name)
                except (OSError, PermissionError):
                    continue
        return matches

    matches, error = _fs_op_with_timeout(_find_prefix_match, timeout=timeout)
    if error or not matches:
        return None, FileNotFoundError(target)

    if len(matches) == 1:
        return os.path.normpath(os.path.join(parent, matches[0])), None

    # Multiple matches — pick exact case-insensitive match first, else first
    # alphabetical match
    for m in sorted(matches, key=str.casefold):
        if m.casefold() == partial.casefold():
            return os.path.normpath(os.path.join(parent, m)), None
    return os.path.normpath(os.path.join(parent, sorted(matches, key=str.casefold)[0])), None


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
                    item = {
                        "name": entry.name,
                        "path": os.path.normpath(os.path.join(target, entry.name)),
                    }
                    if entry.is_symlink():
                        item["symlink"] = True
                    dirs.append(item)
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
        path_info = str(error) if str(error) else ""
        msg = not_found_message
        if path_info:
            msg += ": " + path_info
        return jsonify({"error": msg}), 404
    if isinstance(error, OSError):
        logger.error("Filesystem error: %s", error, exc_info=True)
        return jsonify({"error": "An error occurred while processing your request"}), 500
    logger.error("Unexpected error: %s", error, exc_info=True)
    return jsonify({"error": "An error occurred while processing your request"}), 500


@app.route("/api/browse_debug")
def api_browse_debug():
    """Diagnostic: show raw filesystem info for a path."""
    path = request.args.get("path", "/").strip()
    try:
        target = _sanitize_dir_path(path)
    except ValueError:
        return jsonify({"error": "Invalid path"}), 400
    target_real = None
    try:
        target_real = os.path.realpath(target)
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


def _build_breadcrumb(target):
    """Build a list of path segments for breadcrumb navigation.

    Each entry is {"name": str, "path": str}.  On Windows the first
    entry is the drive (e.g. "C:").
    """
    segments = []
    current = os.path.normpath(target)
    while True:
        parent = os.path.dirname(current)
        name = os.path.basename(current)
        if not name:
            # At root
            if IS_WINDOWS:
                drive, _ = os.path.splitdrive(current)
                name = drive or current
            else:
                name = "/"
            segments.append({"name": name, "path": current})
            break
        segments.append({"name": name, "path": current})
        current = parent
    segments.reverse()
    return segments


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

    # Enrich with platform info
    payload["platform"] = "windows" if IS_WINDOWS else ("wsl" if _IS_WSL else "linux")
    drives = _list_drives()
    if drives:
        payload["drives"] = drives
    payload["breadcrumb"] = _build_breadcrumb(payload["current"])

    return jsonify(payload)


@app.route("/api/photos")
def api_photos():
    """List photo files in a directory with pagination."""
    path = request.args.get("path", "")
    page = max(1, int(request.args.get("page", 1)))
    per_page = min(120, max(1, int(request.args.get("per_page", 60))))

    try:
        path = _sanitize_dir_path(path)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    target, error = _resolve_directory(path)
    if error:
        return _filesystem_error_response(error)

    def _list_photos():
        photos = []
        with os.scandir(target) as it:
            for entry in it:
                try:
                    if not entry.is_file():
                        continue
                except (OSError, PermissionError):
                    continue
                ext = os.path.splitext(entry.name)[1].lower()
                if ext in PHOTO_EXTENSIONS:
                    photos.append({
                        "name": entry.name,
                        "path": os.path.normpath(os.path.join(target, entry.name)),
                        "ext": ext,
                    })
        photos.sort(key=lambda f: f["name"].casefold())
        return photos

    all_photos, error = _fs_op_with_timeout(_list_photos, timeout=FS_TIMEOUT_SECONDS)
    if error:
        return _filesystem_error_response(error)

    total = len(all_photos)
    start = (page - 1) * per_page
    page_files = all_photos[start:start + per_page]

    return jsonify({
        "files": page_files,
        "total": total,
        "page": page,
        "per_page": per_page,
        "has_more": start + per_page < total,
    })


@app.route("/api/validate_folder")
def api_validate_folder():
    """Check if the folder exists and contains photo files."""
    path = request.args.get("path", "").strip()
    if not path:
        return jsonify({"valid": False, "reason": "No path specified"})

    try:
        path = _sanitize_dir_path(path)
    except ValueError as exc:
        return jsonify({"valid": False, "reason": str(exc)})

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
        tried = _normalize_browser_path(path)
        return jsonify({
            "valid": False,
            "reason": "Directory does not exist: %s" % tried,
        })

    # Detect if the path was expanded from a prefix match
    input_normalized = _normalize_browser_path(path)
    was_expanded = (os.path.normpath(target) != os.path.normpath(input_normalized))

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

    warning = None
    if was_expanded:
        warning = "Expanded partial name to: " + os.path.basename(target)
    if photo_count == 0:
        no_photo_msg = "Directory exists but contains no photo files"
        if warning:
            warning = warning + ". " + no_photo_msg
        else:
            warning = no_photo_msg

    # Detect subfolders with photos (for project mode)
    subfolders = []
    try:
        for entry in os.scandir(target):
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            sub_count = _count_photos_in_directory(entry.path)
            if sub_count > 0:
                subfolders.append({"name": entry.name, "path": entry.path, "photo_count": sub_count})
    except (OSError, PermissionError):
        pass
    subfolders.sort(key=lambda s: s["name"].casefold())

    result = {
        "valid": True,
        "photo_count": photo_count,
        "path": target,
    }
    if warning:
        result["warning"] = warning
    if subfolders:
        result["subfolders"] = subfolders

    return jsonify(result)


@app.route("/api/folder_meta")
def api_folder_meta():
    """Metadata scan: GPS, IPTC caption, UserComment, Keywords coverage.

    Query params:
      path  - directory to scan (required)
      limit - max files to sample; 0 = scan all (default: 30)
    """
    path = request.args.get("path", "").strip()
    if not path:
        return jsonify({"error": "No path specified"}), 400

    try:
        limit = int(request.args.get("limit", 30))
    except (ValueError, TypeError):
        limit = 30

    try:
        path = _sanitize_dir_path(path)
    except ValueError:
        return jsonify({"error": "Invalid path"}), 400

    target, error = _resolve_directory(path)
    if error:
        return jsonify({"error": "Directory not accessible: %s" % path}), 400

    try:
        result = scan_folder_metadata(target, limit=limit)
    except Exception as exc:
        logger.error("Metadata scan failed: %s", exc, exc_info=True)
        return jsonify({"error": "An error occurred while processing your request"}), 500

    if result is None:
        return jsonify({"error": "No photos found or exiftool not available"}), 400

    return jsonify(result)


# ---------------------------------------------------------------------------
# Workflow Presets
# ---------------------------------------------------------------------------


@app.route("/api/presets")
def api_presets_list():
    """List saved workflow presets."""
    os.makedirs(PRESETS_DIR, exist_ok=True)
    presets = []
    for entry in os.scandir(PRESETS_DIR):
        if entry.is_file() and entry.name.endswith(".json"):
            presets.append(entry.name[:-5])  # strip .json
    presets.sort(key=str.casefold)
    return jsonify({"presets": presets})


@app.route("/api/presets/<name>")
def api_presets_get(name):
    """Load a saved preset by name."""
    if not _PRESET_NAME_RE.match(name):
        return jsonify({"error": "Invalid preset name"}), 400
    filepath = _sanitize_path(os.path.join(PRESETS_DIR, name + ".json"))
    if not os.path.isfile(filepath):
        return jsonify({"error": "Preset not found"}), 404
    try:
        with open(filepath, "r") as f:
            data = json.load(f)
        return jsonify(data)
    except Exception as exc:
        logger.error("Failed to load preset %s: %s", name, exc)
        return jsonify({"error": "Failed to load preset"}), 500


@app.route("/api/presets", methods=["POST"])
def api_presets_save():
    """Save a workflow preset."""
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Preset name is required"}), 400
    if not _PRESET_NAME_RE.match(name):
        return jsonify({"error": "Preset name must contain only letters, numbers, hyphens, and underscores"}), 400
    config = body.get("config", {})
    os.makedirs(PRESETS_DIR, exist_ok=True)
    filepath = _sanitize_path(os.path.join(PRESETS_DIR, name + ".json"))
    try:
        with open(filepath, "w") as f:
            json.dump({"name": name, "config": config}, f, indent=2)
        logger.info("Saved preset: %s", name)
        return jsonify({"ok": True, "name": name})
    except Exception as exc:
        logger.error("Failed to save preset %s: %s", name, exc)
        return jsonify({"error": "Failed to save preset"}), 500


@app.route("/api/presets/<name>", methods=["DELETE"])
def api_presets_delete(name):
    """Delete a saved preset."""
    if not _PRESET_NAME_RE.match(name):
        return jsonify({"error": "Invalid preset name"}), 400
    filepath = _sanitize_path(os.path.join(PRESETS_DIR, name + ".json"))
    if not os.path.isfile(filepath):
        return jsonify({"error": "Preset not found"}), 404
    try:
        os.remove(filepath)
        logger.info("Deleted preset: %s", name)
        return jsonify({"ok": True})
    except Exception as exc:
        logger.error("Failed to delete preset %s: %s", name, exc)
        return jsonify({"error": "Failed to delete preset"}), 500


# ---------------------------------------------------------------------------
# Undo / Revert
# ---------------------------------------------------------------------------


@app.route("/api/undo/check")
def api_undo_check():
    """Check if _original backup files exist for a directory."""
    path = request.args.get("path", "").strip()
    if not path:
        return jsonify({"available": False})
    try:
        path = _sanitize_dir_path(path)
    except ValueError:
        return jsonify({"available": False})
    target, error = _resolve_directory(path)
    if error:
        return jsonify({"available": False})

    count = 0
    try:
        with os.scandir(target) as it:
            for entry in it:
                if entry.name.endswith("_original") and entry.is_file():
                    count += 1
                    if count >= 1:
                        break
    except (OSError, PermissionError):
        pass

    return jsonify({"available": count > 0, "count": count})


@app.route("/api/undo", methods=["POST"])
def api_undo():
    """Restore _original backup files in a directory using exiftool."""
    body = request.get_json(silent=True) or {}
    path = (body.get("path") or "").strip()
    if not path:
        return jsonify({"error": "No path specified"}), 400

    try:
        path = _sanitize_dir_path(path)
    except ValueError:
        return jsonify({"error": "Invalid path"}), 400

    target, error = _resolve_directory(path)
    if error:
        return jsonify({"error": "Directory not accessible"}), 400

    # Validate target is a real directory (defense-in-depth for command injection)
    sanitized_target = _sanitize_dir_path(target)

    # Count _original files first
    originals = []
    try:
        with os.scandir(sanitized_target) as it:
            for entry in it:
                if entry.name.endswith("_original") and entry.is_file():
                    originals.append(entry.name)
    except (OSError, PermissionError):
        return jsonify({"error": "Cannot read directory"}), 500

    if not originals:
        return jsonify({"error": "No backup files found to restore"}), 400

    # Run exiftool -restore_original (list args, no shell interpolation)
    cmd = ["exiftool", "-restore_original", sanitized_target]
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=120,
            encoding="utf-8",
            errors="replace",
        )
        output = proc.stdout or ""
        logger.info("Undo in %s: exiftool exit %d, %d originals", target, proc.returncode, len(originals))

        # Log the undo operation
        ops_file = os.path.join(PHOTOSHELL_DIR, "operations.jsonl")
        os.makedirs(PHOTOSHELL_DIR, exist_ok=True)
        entry = json.dumps({
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "action": "undo",
            "photo_dir": target,
            "files_restored": len(originals),
        })
        with open(ops_file, "a") as f:
            f.write(entry + "\n")

        return jsonify({
            "ok": proc.returncode == 0,
            "files_restored": len(originals),
            "output": output,
        })
    except subprocess.TimeoutExpired:
        return jsonify({"error": "Undo timed out"}), 504
    except Exception as exc:
        logger.error("Undo failed: %s", exc)
        return jsonify({"error": "Undo failed"}), 500


@app.route("/api/gps_data")
def api_gps_data():
    """Return per-file GPS coordinates and metadata for map display."""
    path = request.args.get("path", "").strip()
    if not path:
        return jsonify({"error": "No path specified"}), 400

    try:
        path = _sanitize_dir_path(path)
    except ValueError:
        return jsonify({"error": "Invalid path"}), 400

    try:
        limit = int(request.args.get("limit", 500))
    except (ValueError, TypeError):
        limit = 500

    target, error = _resolve_directory(path)
    if error:
        return jsonify({"error": "Directory not accessible: %s" % path}), 400

    try:
        result = extract_gps_data(target, limit=limit)
    except Exception as exc:
        logger.error("GPS data extraction failed: %s", exc, exc_info=True)
        return jsonify({"error": "An error occurred while processing your request"}), 500

    return jsonify(result)


@app.route("/api/blur_results")
def api_blur_results():
    """Return structured blur detection results from the analyzed/scenes/selected dirs."""
    path = request.args.get("path", "").strip()
    if not path:
        return jsonify({"error": "No path specified"}), 400

    try:
        path = _sanitize_dir_path(path)
    except ValueError:
        return jsonify({"error": "Invalid path"}), 400

    target, error = _resolve_directory(path)
    if error:
        return jsonify({"error": "Directory not accessible"}), 400

    analyzed_dir = _sanitize_dir_path(os.path.join(target, "analyzed"))
    scenes_dir = _sanitize_dir_path(os.path.join(target, "scenes"))
    selected_dir = _sanitize_dir_path(os.path.join(target, "selected"))

    if not os.path.isdir(analyzed_dir):
        return jsonify({"has_results": False})

    # Parse analyzed/ directory: files named NNNN_<original>
    analyzed = []
    try:
        for entry in os.scandir(analyzed_dir):
            if not entry.is_file():
                continue
            name = entry.name
            # Pattern: 4-digit score prefix + underscore + original filename
            if len(name) > 5 and name[4] == "_" and name[:4].isdigit():
                score = int(name[:4])
                orig = name[5:]
                ext = os.path.splitext(orig)[1].lower()
                if ext in PHOTO_EXTENSIONS:
                    analyzed.append({
                        "score": score,
                        "filename": orig,
                        "path": os.path.normpath(entry.path),
                    })
    except (OSError, PermissionError):
        pass

    analyzed.sort(key=lambda x: x["score"])

    # Parse scenes/ directory
    scenes = []
    if os.path.isdir(scenes_dir):
        try:
            scene_dirs = sorted(
                [e.name for e in os.scandir(scenes_dir)
                 if e.is_dir() and e.name.startswith("scene_")]
            )
        except (OSError, PermissionError):
            scene_dirs = []

        # Build set of selected filenames
        selected_names = set()
        if os.path.isdir(selected_dir):
            try:
                selected_names = {
                    e.name for e in os.scandir(selected_dir) if e.is_file()
                }
            except (OSError, PermissionError):
                pass

        for scene_name in scene_dirs:
            scene_path = _sanitize_dir_path(os.path.join(scenes_dir, scene_name))
            scene_analyzed_dir = _sanitize_dir_path(os.path.join(scene_path, "analyzed"))

            # Photos in the scene
            scene_photos = []
            try:
                for entry in os.scandir(scene_path):
                    if not entry.is_file():
                        continue
                    ext = os.path.splitext(entry.name)[1].lower()
                    if ext in PHOTO_EXTENSIONS:
                        scene_photos.append({
                            "filename": entry.name,
                            "path": os.path.normpath(entry.path),
                        })
            except (OSError, PermissionError):
                pass
            scene_photos.sort(key=lambda x: x["filename"].casefold())

            # Analyzed photos within the scene
            scene_analyzed = []
            if os.path.isdir(scene_analyzed_dir):
                try:
                    for entry in os.scandir(scene_analyzed_dir):
                        if not entry.is_file():
                            continue
                        name = entry.name
                        if len(name) > 5 and name[4] == "_" and name[:4].isdigit():
                            score = int(name[:4])
                            orig = name[5:]
                            ext = os.path.splitext(orig)[1].lower()
                            if ext in PHOTO_EXTENSIONS:
                                scene_analyzed.append({
                                    "score": score,
                                    "filename": orig,
                                    "path": os.path.normpath(entry.path),
                                })
                except (OSError, PermissionError):
                    pass
                scene_analyzed.sort(key=lambda x: x["score"])

            # Identify selected photo for this scene
            scene_selected = None
            for p in scene_photos:
                if p["filename"] in selected_names:
                    scene_selected = p["filename"]
                    break

            scenes.append({
                "scene_id": scene_name,
                "photos": scene_photos,
                "analyzed": scene_analyzed,
                "selected": scene_selected,
            })

    # Selected photos
    selected = []
    if os.path.isdir(selected_dir):
        try:
            for entry in os.scandir(selected_dir):
                if not entry.is_file():
                    continue
                ext = os.path.splitext(entry.name)[1].lower()
                if ext in PHOTO_EXTENSIONS:
                    selected.append({
                        "filename": entry.name,
                        "path": os.path.normpath(entry.path),
                    })
        except (OSError, PermissionError):
            pass

    return jsonify({
        "has_results": True,
        "analyzed": analyzed,
        "scenes": scenes,
        "selected": selected,
    })


@app.route("/api/thumbnail")
def api_thumbnail():
    """Serve a photo image at the requested size, generated in-memory.

    Uses a tiered strategy based on requested size:
    - Small (≤400px): exiftool -b -ThumbnailImage (tiny embedded JPEG, ~50ms)
    - Medium (≤1600px): exiftool -b -PreviewImage (camera's larger preview,
      typically 1200-1600px, ~100ms) or Pillow resize
    - Large (>1600px): Pillow reads the full file and resizes

    No temp files are written to disk.

    Query params:
      path - absolute path to the photo file (required)
      size - max dimension in pixels (default: 200, max: 2400)
    """
    import io
    filepath = request.args.get("path", "").strip()
    if not filepath:
        return jsonify({"error": "path is required"}), 400

    try:
        filepath = _sanitize_file_path(filepath)
    except ValueError:
        return jsonify({"error": "Invalid file path"}), 400
    if not os.path.isfile(filepath):
        return jsonify({"error": "File not found"}), 404

    try:
        size = int(request.args.get("size", 200))
    except (ValueError, TypeError):
        size = 200
    size = max(32, min(size, 2400))

    # For small sizes (grid thumbnails), use the tiny embedded thumbnail
    if size <= 400:
        try:
            proc = subprocess.run(
                ["exiftool", "-b", "-ThumbnailImage", filepath],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10,
            )
            if proc.returncode == 0 and proc.stdout and len(proc.stdout) > 100:
                return send_file(
                    io.BytesIO(proc.stdout),
                    mimetype="image/jpeg",
                    max_age=3600,
                )
        except Exception:
            pass

    # For medium sizes (preview modal), try the camera's larger preview image
    # Most cameras embed a 1200-1600px JPEG preview alongside the full RAW
    if size <= 1600:
        try:
            proc = subprocess.run(
                ["exiftool", "-b", "-PreviewImage", filepath],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15,
            )
            if proc.returncode == 0 and proc.stdout and len(proc.stdout) > 1000:
                return send_file(
                    io.BytesIO(proc.stdout),
                    mimetype="image/jpeg",
                    max_age=3600,
                )
        except Exception:
            pass

    # For JPEGs, serve the file directly if it's not too large, or resize
    ext = os.path.splitext(filepath)[1].lower()
    if ext in (".jpg", ".jpeg"):
        try:
            file_size = os.path.getsize(filepath)
            # If under 5MB, serve directly (it's already a JPEG)
            if file_size < 5 * 1024 * 1024:
                return send_file(filepath, mimetype="image/jpeg", max_age=3600)
        except OSError:
            pass

    # Pillow resize — works for all formats including RAW (if Pillow supports it)
    try:
        from PIL import Image
        img = Image.open(filepath)
        img.thumbnail((size, size))
        quality = 85 if size > 400 else 75
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality)
        buf.seek(0)
        return send_file(buf, mimetype="image/jpeg", max_age=3600)
    except Exception:
        pass

    # Last resort: return a 1x1 transparent pixel
    return send_file(
        io.BytesIO(b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01'
                    b'\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89'
                    b'\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01'
                    b'\r\n\xb4\x00\x00\x00\x00IEND\xaeB`\x82'),
        mimetype="image/png",
    )


# ---------------------------------------------------------------------------
# Photo Catalog (SQLite)
# ---------------------------------------------------------------------------


@app.route("/api/catalog/status")
def api_catalog_status():
    """Check if a catalog exists and return stats."""
    path = request.args.get("path", "").strip()
    if not path:
        return jsonify({"exists": False})
    try:
        path = _sanitize_dir_path(path)
    except ValueError:
        return jsonify({"exists": False})
    target, error = _resolve_directory(path)
    if error:
        return jsonify({"exists": False})

    db_path = get_catalog_path(target)
    if not catalog_exists(target):
        return jsonify({"exists": False, "path": target})

    stats = catalog_stats(db_path)
    return jsonify({"exists": True, "path": target, "stats": stats})


@app.route("/api/catalog/subcatalogs")
def api_catalog_subcatalogs():
    """Scan for existing catalog.db files in subdirectories."""
    path = request.args.get("path", "").strip()
    if not path:
        return jsonify({"subcatalogs": []})
    try:
        path = _sanitize_dir_path(path)
    except ValueError:
        return jsonify({"subcatalogs": []})
    target, error = _resolve_directory(path)
    if error:
        return jsonify({"subcatalogs": []})

    found = []
    for root, dirs, files in os.walk(target):
        # Skip the top-level .photoshell dir
        dirs[:] = [d for d in dirs if d != ".photoshell"]
        catalog_path = os.path.join(root, ".photoshell", "catalog.db")
        if os.path.isfile(catalog_path):
            rel = os.path.relpath(root, target)
            stats = catalog_stats(catalog_path)
            found.append({
                "path": root,
                "relative": rel,
                "total_files": stats["total_files"] if stats else 0,
            })
    return jsonify({"subcatalogs": found})


@app.route("/api/catalog/build", methods=["POST"])
def api_catalog_build():
    """Start a catalog build/update job."""
    body = request.get_json(silent=True) or {}
    path = (body.get("path") or "").strip()
    mode = body.get("mode", "build")  # build | update | prune
    if not path:
        return jsonify({"error": "No path specified"}), 400
    if mode not in ("build", "update", "prune"):
        return jsonify({"error": "Invalid mode"}), 400

    try:
        path = _sanitize_dir_path(path)
    except ValueError:
        return jsonify({"error": "Invalid path"}), 400
    target, error = _resolve_directory(path)
    if error:
        return jsonify({"error": "Directory not accessible"}), 400

    # Build options from request
    file_types = body.get("file_types", "")
    depth = body.get("depth", 0)
    file_pattern = body.get("file_pattern", "")
    folder_pattern = body.get("folder_pattern", "")

    # Build command
    cmd = ["bash", _script("catalog_build.sh"), "-m", mode, "-v"]
    if file_types:
        cmd += ["-t", file_types]
    if depth and int(depth) > 0:
        cmd += ["-D", str(depth)]
    if file_pattern:
        cmd += ["-f", file_pattern]
    if folder_pattern:
        cmd += ["-F", folder_pattern]
    exclude_dirs = body.get("exclude_dirs", [])
    if isinstance(exclude_dirs, list):
        for excl in exclude_dirs:
            if excl and isinstance(excl, str):
                cmd += ["--exclude-dir", excl]
    cmd.append(target)

    job_id = str(uuid.uuid4())[:8]
    with jobs_lock:
        jobs[job_id] = {
            "status": "running",
            "log": "Catalog %s: %s\n" % (mode, target),
            "current_step": 0,
            "steps": ["Catalog " + mode],
            "pid": None,
            "created_at": time.time(),
        }

    def _run_catalog():
        _run_step(job_id, 0, cmd, target)
        with jobs_lock:
            job = jobs.get(job_id)
            if job and job["status"] == "running":
                job["status"] = "done"
                job["log"] += "\n*** Catalog %s completed ***\n" % mode

    t = threading.Thread(target=_run_catalog)
    t.daemon = True
    t.start()

    return jsonify({"job_id": job_id, "mode": mode})


@app.route("/api/catalog/discover")
def api_catalog_discover():
    """Return field metadata for structured filter UI."""
    path = request.args.get("path", "").strip()
    if not path:
        return jsonify({"error": "No path specified"}), 400
    try:
        path = _sanitize_dir_path(path)
    except ValueError:
        return jsonify({"error": "Invalid path"}), 400
    target, error = _resolve_directory(path)
    if error:
        return jsonify({"error": "Directory not accessible"}), 400

    db_path = get_catalog_path(target)
    if not os.path.isfile(db_path):
        return jsonify({"error": "No catalog found"}), 404

    result = catalog_discover(db_path)
    if result is None:
        return jsonify({"error": "Failed to read catalog"}), 500
    return jsonify(result)


@app.route("/api/catalog/search")
def api_catalog_search():
    """Search the catalog with text query and/or structured filters."""
    path = request.args.get("path", "").strip()
    query = request.args.get("q", "").strip()
    page = max(1, int(request.args.get("page", 1)))
    per_page = min(100, max(1, int(request.args.get("per_page", 50))))

    if not path:
        return jsonify({"error": "No path specified"}), 400

    try:
        path = _sanitize_dir_path(path)
    except ValueError:
        return jsonify({"error": "Invalid path"}), 400
    target, error = _resolve_directory(path)
    if error:
        return jsonify({"error": "Directory not accessible"}), 400

    db_path = get_catalog_path(target)
    if not os.path.isfile(db_path):
        return jsonify({"error": "No catalog found. Build one first."}), 404

    # Parse filters from query string
    filters_json = request.args.get("filters", "")
    filters = None
    if filters_json:
        try:
            filters = json.loads(filters_json)
        except (json.JSONDecodeError, TypeError):
            pass

    result = catalog_search(db_path, query=query, filters=filters,
                            page=page, per_page=per_page)
    return jsonify(result)


@app.route("/api/catalog/remove", methods=["POST"])
def api_catalog_remove():
    """Delete the catalog database."""
    body = request.get_json(silent=True) or {}
    path = (body.get("path") or "").strip()
    if not path:
        return jsonify({"error": "No path specified"}), 400

    try:
        path = _sanitize_dir_path(path)
    except ValueError:
        return jsonify({"error": "Invalid path"}), 400
    target, error = _resolve_directory(path)
    if error:
        return jsonify({"error": "Directory not accessible"}), 400

    db_path = get_catalog_path(target)
    removed = catalog_remove(db_path)
    return jsonify({"ok": removed})


@app.route("/api/download")
def api_download():
    """Serve the original photo file for download."""
    path = request.args.get("path", "").strip()
    if not path:
        return jsonify({"error": "No path specified"}), 400
    try:
        filepath = _sanitize_file_path(path)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if not os.path.isfile(filepath):
        return jsonify({"error": "File not found"}), 404
    return send_file(filepath, as_attachment=True)


@app.route("/api/discover_text_fields")
def api_discover_text_fields():
    """Sample photos and report which text metadata fields have data."""
    path = request.args.get("path", "").strip()
    if not path:
        return jsonify({"error": "No path specified"}), 400
    try:
        path = _sanitize_dir_path(path)
    except ValueError:
        return jsonify({"error": "Invalid path"}), 400
    target, error = _resolve_directory(path)
    if error:
        return jsonify({"error": "Directory not accessible"}), 400

    # Sample up to 30 files
    from functions.advisory_checks import _list_photo_files, _run_exiftool_json
    files = _list_photo_files(target, limit=30)
    if not files:
        return jsonify({"error": "No photo files found"}), 400

    text_tags = [
        "-IPTC:Keywords", "-IPTC:Caption-Abstract", "-IPTC:Headline",
        "-EXIF:ImageDescription", "-EXIF:UserComment",
        "-IPTC:CopyrightNotice", "-IPTC:Credit", "-IPTC:Source",
        "-IPTC:City", "-IPTC:Province-State", "-IPTC:Country-PrimaryLocationName",
        "-XMP-dc:Description", "-XMP-dc:Title", "-XMP-dc:Subject",
        "-XMP-dc:Rights", "-XMP-dc:Creator",
        "-XMP-iptcCore:AltTextAccessibility", "-XMP-iptcCore:Location",
        "-XMP-iptcCore:CreatorWorkEmail", "-XMP-iptcCore:CreatorWorkURL",
    ]
    data = _run_exiftool_json(files, text_tags)
    if not data:
        return jsonify({"fields": [], "sampled": 0})

    # Map: (exiftool JSON key, script field name, display label)
    field_map = [
        ("Keywords", "Keywords", "Keywords"),
        ("Caption-Abstract", "Caption-Abstract", "Caption-Abstract"),
        ("Headline", "Headline", "Headline"),
        ("ImageDescription", "ImageDescription", "ImageDescription"),
        ("UserComment", "UserComment", "UserComment"),
        ("CopyrightNotice", "Copyright", "Copyright"),
        ("Credit", "Credit", "Credit"),
        ("Source", "Source", "Source"),
        ("City", "City", "City"),
        ("Province-State", "Province-State", "Province-State"),
        ("Country-PrimaryLocationName", "Country-PrimaryLocationName", "Country"),
        ("Description", "XMP-dc:Description", "XMP Description"),
        ("Title", "XMP-dc:Title", "XMP Title"),
        ("Subject", "XMP-dc:Subject", "XMP Subject/Keywords"),
        ("Rights", "XMP-dc:Rights", "XMP Rights"),
        ("Creator", "XMP-dc:Creator", "XMP Creator"),
        ("AltTextAccessibility", "XMP-iptcCore:AltTextAccessibility", "Alt Text"),
        ("Location", "XMP-iptcCore:Location", "XMP Location"),
        ("CreatorWorkEmail", "XMP-iptcCore:CreatorWorkEmail", "Creator Email"),
        ("CreatorWorkURL", "XMP-iptcCore:CreatorWorkURL", "Creator URL"),
    ]

    counts = {}
    for json_key, _, _ in field_map:
        counts[json_key] = 0

    for rec in data:
        for json_key, _, _ in field_map:
            val = rec.get(json_key)
            if val:
                if isinstance(val, list) and len(val) > 0:
                    counts[json_key] += 1
                elif isinstance(val, str) and val.strip():
                    counts[json_key] += 1

    sampled = len(data)
    fields = []
    for json_key, tag_name, label in field_map:
        fields.append({
            "name": tag_name,
            "label": label,
            "count": counts[json_key],
            "pct": round(counts[json_key] * 100 / sampled) if sampled > 0 else 0,
        })

    return jsonify({"fields": fields, "sampled": sampled})


@app.route("/api/quick_backup", methods=["POST"])
def api_quick_backup():
    """Create a non-compressed .tar archive of the photo directory."""
    body = request.get_json(silent=True) or {}
    path = (body.get("path") or "").strip()
    recursive = bool(body.get("recursive", False))
    if not path:
        return jsonify({"error": "No path specified"}), 400

    try:
        path = _sanitize_dir_path(path)
    except ValueError:
        return jsonify({"error": "Invalid path"}), 400
    target, error = _resolve_directory(path)
    if error:
        return jsonify({"error": "Directory not accessible"}), 400

    # Build tar command — non-compressed archive in the working directory
    folder_name = os.path.basename(target)
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    archive_name = "%s_backup_%s.tar" % (folder_name, timestamp)
    archive_path = os.path.join(target, archive_name)

    if recursive:
        cmd = ["tar", "cf", archive_path, "-C", os.path.dirname(target), folder_name,
               "--exclude", archive_name]
    else:
        # Non-recursive: only top-level files
        cmd = ["bash", "-c",
               "cd %s && find . -maxdepth 1 -type f -print0 | tar cf %s --null -T -"
               % (shlex.quote(target), shlex.quote(archive_path))]

    job_id = str(uuid.uuid4())[:8]
    with jobs_lock:
        jobs[job_id] = {
            "status": "running",
            "log": "Creating backup: %s\n" % archive_name,
            "current_step": 0,
            "steps": ["Backup"],
            "pid": None,
            "created_at": time.time(),
        }

    def _run_backup():
        _run_step(job_id, 0, cmd, target)
        with jobs_lock:
            job = jobs.get(job_id)
            if job and job["status"] == "running":
                # Check if archive was created
                if os.path.isfile(archive_path):
                    size_mb = os.path.getsize(archive_path) / (1024 * 1024)
                    job["log"] += "\nBackup created: %s (%.1f MB)\n" % (archive_name, size_mb)
                    job["status"] = "done"
                else:
                    job["log"] += "\nBackup may have failed — archive not found\n"
                    job["status"] = "failed"

    t = threading.Thread(target=_run_backup)
    t.daemon = True
    t.start()

    return jsonify({"job_id": job_id, "archive": archive_name})


@app.route("/api/file_metadata")
def api_file_metadata():
    """Return full EXIF and/or IPTC metadata for a single file."""
    path = request.args.get("path", "").strip()
    group = request.args.get("group", "exif").lower()  # "exif" or "iptc"
    if not path:
        return jsonify({"error": "No path specified"}), 400

    try:
        filepath = _sanitize_file_path(path)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    if not os.path.isfile(filepath):
        return jsonify({"error": "File not found"}), 404

    if group == "iptc":
        tags = ["-IPTC:all"]
    else:
        tags = ["-EXIF:all"]

    cmd = ["exiftool", "-json", "-G"] + tags + [filepath]
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
            encoding="utf-8",
            errors="replace",
        )
        if proc.returncode != 0:
            return jsonify({"error": "exiftool failed"}), 500
        data = json.loads(proc.stdout)
        if data and isinstance(data, list):
            # Remove SourceFile from output
            record = data[0]
            record.pop("SourceFile", None)
            return jsonify({"group": group, "metadata": record})
        return jsonify({"group": group, "metadata": {}})
    except subprocess.TimeoutExpired:
        return jsonify({"error": "Metadata extraction timed out"}), 504
    except Exception as exc:
        logger.error("File metadata failed: %s", exc)
        return jsonify({"error": "An error occurred"}), 500


@app.route("/api/search_meta", methods=["POST"])
def api_search_meta():
    """Return metadata (UserComment, Caption, Keywords) for a list of files.

    Expects JSON: {"files": ["/path/to/file1.jpg", ...]}
    Returns: {"results": [{"file": ..., "comment": ..., "caption": ..., "keywords": ...}, ...]}
    """
    data = request.get_json(force=True)
    raw_files = data.get("files", [])
    if not raw_files:
        return jsonify({"results": []})

    # Sanitize and normalize paths; skip any that fail validation
    files = []
    for f in raw_files[:200]:
        try:
            files.append(_sanitize_path(f))
        except ValueError:
            continue

    try:
        # Use -@ - to read file paths from stdin instead of command line
        # to prevent user-supplied paths from being interpreted as arguments
        cmd = ["exiftool", "-json", "-charset", "exif=UTF8", "-charset", "iptc=UTF8",
               "-UserComment", "-IPTC:Caption-Abstract", "-IPTC:Keywords",
               "-FileName", "-@", "-"]
        file_list_input = "\n".join(files) + "\n"
        proc = subprocess.run(
            cmd, input=file_list_input,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=60, encoding="utf-8", errors="replace",
        )
        if proc.returncode not in (0, 1) or not proc.stdout:
            return jsonify({"results": []})

        exif_data = json.loads(proc.stdout)
    except Exception as exc:
        logger.error("search_meta exiftool failed: %s", exc)
        return jsonify({"results": []})

    results = []
    for rec in exif_data:
        src = rec.get("SourceFile", "")
        comment = rec.get("UserComment") or ""
        caption = rec.get("Caption-Abstract") or ""
        keywords = rec.get("Keywords") or ""
        if isinstance(keywords, list):
            keywords = ", ".join(keywords)
        # Clean binary markers
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

    return jsonify({"results": results})


@app.route("/api/preflight", methods=["POST"])
def api_preflight():
    """Check that all required external tools are available for enabled steps."""
    logger.info("POST /api/preflight")
    data = request.get_json(force=True)
    enabled = [k for k in DEFAULT_STEP_ORDER if data.get(k)]
    if not enabled:
        return jsonify({"ok": True, "tools": {}, "missing": []})
    return jsonify(run_preflight(enabled))


@app.route("/api/advisory", methods=["POST"])
def api_advisory():
    """Run advisory checks on the photo directory for the enabled steps.

    Returns a list of advisory objects with keys: key, level, icon, title,
    detail.  These are informational -- they do not block execution.
    """
    logger.info("POST /api/advisory")
    data = request.get_json(force=True)
    photo_dir = data.get("photo_dir", "").strip()
    if not photo_dir:
        return jsonify([])

    # Resolve partial paths the same way the browser does
    target, error = _resolve_directory(photo_dir)
    if error:
        return jsonify([])

    enabled = [k for k in DEFAULT_STEP_ORDER if data.get(k)]
    advisories = run_advisory_checks(target, enabled)
    return jsonify(advisories)


@app.route("/api/run", methods=["POST"])
def api_run():
    logger.info("POST /api/run")
    _cleanup_stale_jobs()

    data = request.get_json(force=True)
    photo_dir = data.get("photo_dir", "").strip()
    if not photo_dir:
        return jsonify({"error": "photo_dir is required"}), 400

    # Normalize the path for the current platform (e.g. C:\... -> /mnt/c/... on WSL)
    photo_dir = _normalize_browser_path(photo_dir)
    data["photo_dir"] = photo_dir

    steps = build_pipeline(data)
    if not steps:
        return jsonify({"error": "No steps selected"}), 400

    # Preflight: abort early if required tools are missing
    enabled = [k for k in DEFAULT_STEP_ORDER if data.get(k)]
    preflight = run_preflight(enabled)
    if not preflight["ok"]:
        lines = ["Missing required tools:"]
        for m in preflight["missing"]:
            lines.append("  - %s (needed by: %s)" % (
                m["label"], ", ".join(m["needed_by"])))
        return jsonify({"error": "\n".join(lines)}), 400

    # Project mode: run pipeline across multiple subfolders
    project_folders = data.get("project_folders")
    if project_folders and isinstance(project_folders, list) and len(project_folders) > 0:
        # Validate all folder paths
        valid_folders = []
        for fp in project_folders:
            try:
                fp = _sanitize_dir_path(fp)
            except ValueError:
                continue
            if os.path.isdir(fp):
                valid_folders.append(fp)
        if not valid_folders:
            return jsonify({"error": "No valid subfolders found"}), 400

        job_id = str(uuid.uuid4())[:8]
        folder_info = [{"path": fp, "name": os.path.basename(fp), "status": "pending"}
                       for fp in valid_folders]
        with jobs_lock:
            jobs[job_id] = {
                "status": "running",
                "log": "Project mode: %d folders, %d steps each\n" % (len(valid_folders), len(steps)),
                "current_step": 0,
                "current_folder": 0,
                "steps": [s["label"] for s in steps],
                "folders": folder_info,
                "pid": None,
                "created_at": time.time(),
            }
        logger.info("Project job %s: %d folders, %d steps", job_id, len(valid_folders), len(steps))

        t = threading.Thread(target=_run_project_pipeline, args=(job_id, data, valid_folders))
        t.daemon = True
        t.start()

        return jsonify({
            "job_id": job_id,
            "steps": [s["label"] for s in steps],
            "folders": folder_info,
            "project": True,
        })

    # Single-folder mode
    job_id = str(uuid.uuid4())[:8]
    with jobs_lock:
        jobs[job_id] = {
            "status": "running",
            "log": "Photo directory: %s\nSteps: %d\n" % (photo_dir, len(steps)),
            "current_step": 0,
            "steps": [s["label"] for s in steps],
            "pid": None,
            "created_at": time.time(),
        }
    logger.info("Job %s created with %d steps for %s", job_id, len(steps), photo_dir)

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
    result = {
        "status": job["status"],
        "current_step": job["current_step"],
        "steps": job["steps"],
        "log": job["log"],
    }
    if "folders" in job:
        result["folders"] = job["folders"]
        result["current_folder"] = job.get("current_folder", 0)
    return jsonify(result)


@app.route("/api/log/<job_id>")
def api_log(job_id):
    """Return new log content since a given byte offset."""
    offset = max(0, int(request.args.get("offset", 0)))
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "not found"}), 404
    log_text = job["log"]
    new_content = log_text[offset:] if offset < len(log_text) else ""
    result = {
        "log": new_content,
        "offset": len(log_text),
        "status": job["status"],
        "current_step": job["current_step"],
        "total_steps": len(job["steps"]),
    }
    if "folders" in job:
        result["folders"] = job["folders"]
        result["current_folder"] = job.get("current_folder", 0)
    return jsonify(result)


@app.route("/api/cancel/<job_id>", methods=["POST"])
def api_cancel(job_id):
    logger.info("POST /api/cancel/%s", job_id)
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


@app.route("/api/search", methods=["POST"])
def api_search():
    """Run a standalone EXIF/IPTC metadata search."""
    logger.info("POST /api/search")
    data = request.get_json(force=True)
    photo_dir = data.get("photo_dir", "").strip()
    query = data.get("search_query", "").strip()
    if not photo_dir:
        return jsonify({"error": "photo_dir is required"}), 400
    if not query:
        return jsonify({"error": "search_query is required"}), 400

    # Normalize the path for the current platform
    photo_dir = _normalize_browser_path(photo_dir)

    cmd = ["bash", _script("search_exif_iptc.sh"), "-q", query]
    if data.get("search_fields"):
        cmd += ["-f", data["search_fields"]]
    if data.get("search_media_types"):
        cmd += ["-m", data["search_media_types"]]
    if not data.get("search_recursive", True):
        cmd.append("--no-recursive")
    if data.get("search_fzf"):
        cmd.append("--fzf")
    if data.get("search_copy_to"):
        cmd += ["--copy-to", data["search_copy_to"]]

    job_id = str(uuid.uuid4())[:8]
    with jobs_lock:
        jobs[job_id] = {
            "status": "running",
            "log": "Search directory: %s\nQuery: %s\n" % (photo_dir, query),
            "current_step": 0,
            "steps": ["Search EXIF/IPTC"],
            "pid": None,
            "created_at": time.time(),
        }

    step = {"label": "Search EXIF/IPTC", "cmd": cmd}
    t = threading.Thread(target=_run_search, args=(job_id, step, photo_dir))
    t.daemon = True
    t.start()

    return jsonify({"job_id": job_id})


def _run_search(job_id, step, cwd):
    """Execute a single search step."""
    rc = _run_step(job_id, 0, step["cmd"], cwd)
    with jobs_lock:
        if rc == 0:
            jobs[job_id]["status"] = "done"
            jobs[job_id]["log"] += "\n*** Search completed ***\n"
        else:
            jobs[job_id]["status"] = "failed"
            jobs[job_id]["log"] += "\n*** Search failed ***\n"


@app.route("/api/search/count")
def api_search_count():
    """Fast photo file count, with auto-recursion detection.

    Query params:
      path      - directory to count (required)
      recursive - 0 or 1 (default 0)
    """
    path = request.args.get("path", "").strip()
    if not path:
        return jsonify({"error": "path is required"}), 400
    try:
        target = _sanitize_dir_path(path)
    except ValueError:
        return jsonify({"error": "Invalid path"}), 400
    if not os.path.isdir(target):
        return jsonify({"error": "Directory not found"}), 404
    recursive = request.args.get("recursive", "0") in ("1", "true", "yes")
    try:
        count, actually_recursive = count_photo_files(target, recursive=recursive)
        return jsonify({
            "count": count,
            "recursive": actually_recursive,
            "auto_recursive": actually_recursive and not recursive,
        })
    except Exception as exc:
        logger.error("Count failed: %s", exc)
        return jsonify({"count": 0, "recursive": recursive, "auto_recursive": False})


@app.route("/api/search/discover")
def api_search_discover():
    """Discover available EXIF/IPTC fields by sampling photos in a directory.

    Query params:
      path        - directory to scan (required)
      recursive   - 0 or 1 (default 0)
      sample_size - number of files to sample (default 30)
    """
    logger.info("GET /api/search/discover")
    path = request.args.get("path", "").strip()
    if not path:
        return jsonify({"error": "path is required"}), 400

    recursive = request.args.get("recursive", "0") in ("1", "true", "yes")

    try:
        sample_size = int(request.args.get("sample_size", 30))
    except (ValueError, TypeError):
        sample_size = 30

    try:
        target = _sanitize_dir_path(path)
    except ValueError:
        return jsonify({"error": "Invalid path"}), 400
    if not os.path.isdir(target):
        return jsonify({"error": "Directory not found: %s" % target}), 404

    try:
        result = discover_fields(target, recursive=recursive, sample_size=sample_size)
    except FileNotFoundError:
        return jsonify({"error": "Directory not found: %s" % target}), 404
    except subprocess.TimeoutExpired:
        return jsonify({"error": "exiftool timed out while scanning"}), 504
    except Exception as exc:
        logger.error("discover_fields failed: %s", exc, exc_info=True)
        return jsonify({"error": "An error occurred while processing your request"}), 500

    return jsonify(result)


@app.route("/api/search/structured", methods=["POST"])
def api_search_structured():
    """Run a structured metadata search as a background job.

    JSON body: {path, recursive, filters, logic}
    Returns: {job_id} — poll /api/search/structured/status/<job_id> for results.
    """
    logger.info("POST /api/search/structured")
    data = request.get_json(force=True)
    path = data.get("path", "").strip()
    if not path:
        return jsonify({"error": "path is required"}), 400

    recursive = bool(data.get("recursive", False))
    filters = data.get("filters", [])
    logic = data.get("logic", "AND")

    if not filters:
        return jsonify({"error": "At least one filter is required"}), 400

    try:
        target = _sanitize_dir_path(path)
    except ValueError:
        return jsonify({"error": "Invalid path"}), 400
    if not os.path.isdir(target):
        return jsonify({"error": "Directory not found: %s" % target}), 404

    job_id = str(uuid.uuid4())[:8]
    with jobs_lock:
        jobs[job_id] = {
            "status": "running",
            "log": "",
            "current_step": 0,
            "steps": ["Structured Search"],
            "pid": None,
            "created_at": time.time(),
            "search_result": None,
        }
    logger.info("Structured search job %s started for %s", job_id, target)

    def _run():
        try:
            result = structured_search(
                target, filters, recursive=recursive, logic=logic,
            )
            with jobs_lock:
                jobs[job_id]["search_result"] = result
                jobs[job_id]["status"] = "done"
                jobs[job_id]["log"] = "Search complete: %d matches of %d scanned" % (
                    result.get("matches", 0), result.get("total_scanned", 0))
        except Exception as exc:
            logger.error("structured_search job %s failed: %s", job_id, exc, exc_info=True)
            with jobs_lock:
                jobs[job_id]["status"] = "failed"
                jobs[job_id]["log"] = "Error: %s" % str(exc)
                jobs[job_id]["search_result"] = {
                    "matches": 0, "total_scanned": 0, "results": [],
                    "error": str(exc)}

    t = threading.Thread(target=_run)
    t.daemon = True
    t.start()

    return jsonify({"job_id": job_id})


@app.route("/api/search/structured/status/<job_id>")
def api_search_structured_status(job_id):
    """Poll structured search job status. Returns results when done.

    Query params:
      page     - result page (1-based, default 1)
      per_page - results per page (default 50, max 200)
    """
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    status = job["status"]
    response = {"status": status, "log": job.get("log", "")}

    if status == "done" and job.get("search_result"):
        result = job["search_result"]
        all_results = result.get("results", [])
        total_matches = len(all_results)

        # Pagination
        try:
            page = max(1, int(request.args.get("page", 1)))
        except (ValueError, TypeError):
            page = 1
        try:
            per_page = min(200, max(1, int(request.args.get("per_page", 50))))
        except (ValueError, TypeError):
            per_page = 50

        start = (page - 1) * per_page
        end = start + per_page
        page_results = all_results[start:end]
        total_pages = (total_matches + per_page - 1) // per_page if total_matches > 0 else 0

        response["matches"] = total_matches
        response["total_scanned"] = result.get("total_scanned", 0)
        response["results"] = page_results
        response["page"] = page
        response["per_page"] = per_page
        response["total_pages"] = total_pages
        if result.get("error"):
            response["error"] = result["error"]

    elif status == "failed":
        result = job.get("search_result") or {}
        response["error"] = result.get("error", "Search failed")

    return jsonify(response)


# ---------------------------------------------------------------------------
# Backup folder
# ---------------------------------------------------------------------------

def _dir_size(path, recursive):
    """Calculate total size in bytes and file/dir counts."""
    total = 0
    file_count = 0
    dir_count = 0
    try:
        if recursive:
            for root, dirs, files in os.walk(path):
                dir_count += len(dirs)
                for f in files:
                    fp = os.path.join(root, f)
                    try:
                        total += os.path.getsize(fp)
                        file_count += 1
                    except OSError:
                        pass
        else:
            with os.scandir(path) as it:
                for entry in it:
                    try:
                        if entry.is_file():
                            total += entry.stat().st_size
                            file_count += 1
                    except OSError:
                        pass
    except OSError:
        pass
    return total, file_count, dir_count


def _human_size(nbytes):
    """Format bytes into a human-readable string."""
    for unit in ("bytes", "KB", "MB", "GB", "TB"):
        if abs(nbytes) < 1024:
            if unit == "bytes":
                return "%d %s" % (nbytes, unit)
            return "%.2f %s" % (nbytes, unit)
        nbytes /= 1024.0
    return "%.2f PB" % nbytes


@app.route("/api/backup/estimate", methods=["POST"])
def api_backup_estimate():
    """Estimate backup size and available space at the destination."""
    logger.info("POST /api/backup/estimate")
    data = request.get_json(force=True)
    source = data.get("source", "").strip()
    dest = data.get("dest", "").strip()
    recursive = data.get("recursive", False)

    if not source:
        return jsonify({"error": "source is required"}), 400

    try:
        source = _sanitize_dir_path(source)
    except ValueError:
        return jsonify({"error": "Invalid source path"}), 400
    if not os.path.isdir(source):
        return jsonify({"error": "Source directory does not exist: %s" % source}), 400

    if dest:
        try:
            dest = _sanitize_dir_path(dest)
        except ValueError:
            return jsonify({"error": "Invalid destination path"}), 400
    else:
        dest = source

    if not os.path.isdir(dest):
        return jsonify({"error": "Destination directory does not exist: %s" % dest}), 400

    size_bytes, file_count, dir_count = _dir_size(source, recursive)

    # Photos/media don't compress well; estimate ~85% of original
    estimated_archive = int(size_bytes * 0.85) if size_bytes > 1024 else size_bytes

    # Available space at destination
    try:
        usage = shutil.disk_usage(dest)
        avail_bytes = usage.free
    except OSError:
        avail_bytes = 0

    return jsonify({
        "source": source,
        "dest": dest,
        "recursive": recursive,
        "size_bytes": size_bytes,
        "size_human": _human_size(size_bytes),
        "file_count": file_count,
        "dir_count": dir_count,
        "estimated_archive_bytes": estimated_archive,
        "estimated_archive_human": _human_size(estimated_archive),
        "avail_bytes": avail_bytes,
        "avail_human": _human_size(avail_bytes),
        "space_ok": estimated_archive < avail_bytes,
    })


@app.route("/api/backup/run", methods=["POST"])
def api_backup_run():
    """Create a backup archive of the source folder."""
    logger.info("POST /api/backup/run")
    data = request.get_json(force=True)
    source = data.get("source", "").strip()
    dest = data.get("dest", "").strip()
    recursive = data.get("recursive", False)

    if not source:
        return jsonify({"error": "source is required"}), 400

    try:
        source = _sanitize_dir_path(source)
    except ValueError:
        return jsonify({"error": "Invalid source path"}), 400
    if not os.path.isdir(source):
        return jsonify({"error": "Source directory does not exist"}), 400

    if dest:
        try:
            dest = _sanitize_dir_path(dest)
        except ValueError:
            return jsonify({"error": "Invalid destination path"}), 400
    else:
        dest = source

    if not os.path.isdir(dest):
        return jsonify({"error": "Destination directory does not exist"}), 400

    cmd = ["bash", _script("backup_folder.sh"), "--source", source, "--dest", dest]
    if recursive:
        cmd.append("--recursive")

    job_id = str(uuid.uuid4())[:8]
    with jobs_lock:
        jobs[job_id] = {
            "status": "running",
            "log": "Backup source: %s\nDestination: %s\nRecursive: %s\n"
                   % (source, dest, recursive),
            "current_step": 0,
            "steps": ["Backup Folder"],
            "pid": None,
            "created_at": time.time(),
        }

    step = {"label": "Backup Folder", "cmd": cmd}
    t = threading.Thread(target=_run_backup, args=(job_id, step, source))
    t.daemon = True
    t.start()

    return jsonify({"job_id": job_id})


def _run_backup(job_id, step, cwd):
    """Execute the backup step."""
    rc = _run_step(job_id, 0, step["cmd"], cwd)
    with jobs_lock:
        if rc == 0:
            jobs[job_id]["status"] = "done"
            jobs[job_id]["log"] += "\n*** Backup completed ***\n"
        else:
            jobs[job_id]["status"] = "failed"
            jobs[job_id]["log"] += "\n*** Backup failed ***\n"


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

    # Debug mode only on localhost — exposes Werkzeug interactive debugger
    # which allows arbitrary code execution from the browser.
    # On network interfaces: debug off, but auto-reload stays on for dev convenience.
    is_localhost = host in ("127.0.0.1", "localhost", "::1")
    use_debug = is_localhost
    use_reload = True  # auto-restart on file changes (safe on any interface)

    if use_debug:
        print("Starting PhotoShell on %s:%d (debug mode)" % (host, port))
    else:
        print("Starting PhotoShell on %s:%d (debug off — network interface)" % (host, port))

    app.run(debug=use_debug, use_reloader=use_reload, host=host, port=port)
