#!/usr/bin/env python3
"""PhotoShell Flask UI - run photo-processing scripts as a workflow."""

import argparse
import glob
import json
import logging
import os
import platform
import re
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

from flask import Flask, jsonify, render_template, request

from functions.advisory_checks import run_advisory_checks, scan_folder_metadata
from functions.constants import (
    DEFAULT_STEP_ORDER,
    PHOTO_EXTENSIONS,
    STEP_PREFLIGHT_LABELS,
    STEP_TOOL_DEPS,
    TOOL_LABELS,
)

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

# Resolve directories relative to this file
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS_DIR = str(REPO_ROOT / "scripts")
DOCS_DIR = str(REPO_ROOT / "docs")

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
        proc = subprocess.Popen(
            cmd,
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
            for line in proc.stdout:
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
    "extract_photo_summary": "extract_photo_summary.md",
    "annotate_desc": "annotate_photos_with_ollama.md",
    "annotate_kw": "annotate_photos_with_ollama.md",
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

    if warning:
        return jsonify({
            "valid": True,
            "warning": warning,
            "photo_count": photo_count,
            "path": target,
        })

    return jsonify({
        "valid": True,
        "photo_count": photo_count,
        "path": target,
    })


@app.route("/api/folder_meta")
def api_folder_meta():
    """Quick metadata scan: GPS, IPTC caption, UserComment coverage."""
    path = request.args.get("path", "").strip()
    if not path:
        return jsonify({"error": "No path specified"}), 400

    target, error = _resolve_directory(path)
    if error:
        return jsonify({"error": "Directory not accessible: %s" % path}), 400

    try:
        result = scan_folder_metadata(target)
    except Exception as exc:
        logger.error("Metadata scan failed: %s", exc, exc_info=True)
        return jsonify({"error": "An error occurred while processing your request"}), 500

    if result is None:
        return jsonify({"error": "No photos found or exiftool not available"}), 400

    return jsonify(result)


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
    return jsonify({
        "status": job["status"],
        "current_step": job["current_step"],
        "steps": job["steps"],
        "log": job["log"],
    })


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

    source = _normalize_browser_path(source)
    if not os.path.isdir(source):
        return jsonify({"error": "Source directory does not exist: %s" % source}), 400

    if dest:
        dest = _normalize_browser_path(dest)
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

    source = _normalize_browser_path(source)
    if not os.path.isdir(source):
        return jsonify({"error": "Source directory does not exist"}), 400

    if dest:
        dest = _normalize_browser_path(dest)
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

    print("Starting PhotoShell on %s:%d" % (host, port))
    app.run(debug=True, host=host, port=port)
