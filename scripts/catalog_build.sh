#!/usr/bin/env bash
#
#                                      |
#                                  ___/"\___
#                          __________/ o \__________
#                            (I) (G) \___/ (O) (R)
#                                   Igor Os
#                              igor@igoros.com
#                                 2026-03-23
# ----------------------------------------------------------------------------
# Scan photo collections and index EXIF/IPTC metadata into SQLite.
# Uses parallel exiftool workers for high throughput on large collections.
# ----------------------------------------------------------------------------
# Change Log:
# ****************************************************************************
# 2026-03-23	igor@igoros.com	Wrote this script
# ****************************************************************************

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

INPUT_DIR="."
DB_FILE=""
MAX_DEPTH=0        # 0 = unlimited
JOBS=0             # 0 = auto (nproc)
BATCH_SIZE=50
FILE_PATTERN=""    # glob pattern for filenames (e.g. "DSC*.jpg")
FOLDER_PATTERN=""  # glob pattern for folder names (e.g. "2025-*")
MODE="build"       # build | update | prune | stats
VERBOSE=0

# Default: all common image/RAW extensions
FILE_TYPES="jpg,jpeg,png,tif,tiff,heic,heif,webp,bmp,gif,dng,nef,cr2,cr3,arw,orf,rw2,srw,raf,pef,x3f"

usage() {
  cat <<EOF
Usage:
  ${SCRIPT_NAME} [options] [DIRECTORY]

Purpose:
  Scan photo files and index their EXIF/IPTC metadata into a SQLite database
  for fast searching across large collections. Uses parallel exiftool workers
  for high throughput.

Modes:
  build     Full scan — drop and rebuild the catalog (default)
  update    Incremental — only scan files not yet in the catalog or modified since
  prune     Remove catalog entries for files that no longer exist on disk
  stats     Show catalog statistics and exit

Options:
  -d, --db FILE              SQLite database file (default: <dir>/.photoshell/catalog.db)
  -t, --types EXT,EXT,...    File extensions to scan (default: all image types)
  -D, --depth N              Max directory depth (default: unlimited, 1 = top-level only)
  -j, --jobs N               Parallel exiftool workers (default: nproc)
  -b, --batch-size N         Files per exiftool batch (default: 50)
  -f, --file-pattern GLOB    Only scan files matching this glob (e.g. "DSC*.jpg")
  -F, --folder-pattern GLOB  Only scan inside folders matching this glob (e.g. "2025-*")
  -m, --mode MODE            build | update | prune | stats (default: build)
  -v, --verbose              Show progress per batch
  -h, --help                 Show this help

Examples:
  ${SCRIPT_NAME} /photos
  ${SCRIPT_NAME} -m update /photos
  ${SCRIPT_NAME} -t jpg,cr3 -D 2 -j 8 /photos
  ${SCRIPT_NAME} -f "DSC*.jpg" -F "2025-*" /photos
  ${SCRIPT_NAME} -m prune /photos
  ${SCRIPT_NAME} -m stats /photos
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

log() {
  echo "$*"
}

vlog() {
  [[ "${VERBOSE}" -eq 1 ]] && echo "$*" || true
}

get_jobs() {
  if [[ "${JOBS}" -gt 0 ]]; then
    echo "${JOBS}"
  else
    nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4
  fi
}

# ---------------------------------------------------------------------------
# SQLite schema
# ---------------------------------------------------------------------------

init_db() {
  local db="$1"
  sqlite3 "${db}" <<'SQL'
CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT UNIQUE NOT NULL,
    file_name TEXT NOT NULL,
    file_size INTEGER,
    file_type TEXT,
    file_mtime REAL,
    -- EXIF
    make TEXT,
    model TEXT,
    lens_model TEXT,
    date_time_original TEXT,
    create_date TEXT,
    f_number REAL,
    exposure_time TEXT,
    focal_length REAL,
    focal_length_35 REAL,
    iso INTEGER,
    image_width INTEGER,
    image_height INTEGER,
    orientation TEXT,
    gps_latitude REAL,
    gps_longitude REAL,
    gps_altitude REAL,
    exposure_program TEXT,
    metering_mode TEXT,
    flash TEXT,
    white_balance TEXT,
    color_space TEXT,
    -- IPTC
    headline TEXT,
    caption TEXT,
    keywords TEXT,
    copyright TEXT,
    credit TEXT,
    source TEXT,
    city TEXT,
    state TEXT,
    country TEXT,
    -- Catalog
    indexed_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_photos_file_path ON photos(file_path);
CREATE INDEX IF NOT EXISTS idx_photos_file_name ON photos(file_name);
CREATE INDEX IF NOT EXISTS idx_photos_date ON photos(date_time_original);
CREATE INDEX IF NOT EXISTS idx_photos_make_model ON photos(make, model);
CREATE INDEX IF NOT EXISTS idx_photos_gps ON photos(gps_latitude, gps_longitude);
CREATE INDEX IF NOT EXISTS idx_photos_keywords ON photos(keywords);
CREATE INDEX IF NOT EXISTS idx_photos_headline ON photos(headline);
CREATE INDEX IF NOT EXISTS idx_photos_caption ON photos(caption);
SQL
}

# ---------------------------------------------------------------------------
# File discovery
# ---------------------------------------------------------------------------

discover_files_to_list() {
  # Write matching file paths (one per line) to the given output file
  local outfile="$1"

  # Build the find command dynamically
  local -a find_cmd=(find "${INPUT_DIR}")

  # Depth limit
  if [[ "${MAX_DEPTH}" -gt 0 ]]; then
    find_cmd+=(-maxdepth "${MAX_DEPTH}")
  fi

  find_cmd+=(-type f)

  # File type extensions — build -iname clauses
  local -a ext_args=()
  local first=1
  local ext
  IFS=',' read -ra EXTS <<< "${FILE_TYPES}"
  for ext in "${EXTS[@]}"; do
    ext="$(echo "${ext}" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -z "${ext}" ]] && continue
    if [[ "${first}" -eq 1 ]]; then
      first=0
      ext_args+=( \( -iname "*.${ext}" )
    else
      ext_args+=( -o -iname "*.${ext}" )
    fi
  done
  if [[ "${#ext_args[@]}" -gt 0 ]]; then
    ext_args+=( \) )
    find_cmd+=("${ext_args[@]}")
  fi

  # File name pattern
  if [[ -n "${FILE_PATTERN}" ]]; then
    find_cmd+=(-name "${FILE_PATTERN}")
  fi

  # Run find, output one file per line
  "${find_cmd[@]}" 2>/dev/null > "${outfile}" || true

  # Folder pattern filter (post-filter — only keep paths where a dir component matches)
  if [[ -n "${FOLDER_PATTERN}" ]]; then
    local filtered
    filtered="$(mktemp)"
    grep -E "/${FOLDER_PATTERN}/" "${outfile}" > "${filtered}" 2>/dev/null || true
    # Also keep files directly in INPUT_DIR (no subfolder)
    grep -v "/" "${outfile}" >> "${filtered}" 2>/dev/null || true
    mv "${filtered}" "${outfile}"
  fi

  wc -l < "${outfile}" | tr -d ' '
}

# ---------------------------------------------------------------------------
# Exiftool extraction + SQLite insertion
# ---------------------------------------------------------------------------

EXIFTOOL_TAGS=(
  -FileName -FileSize -FileType -FileModifyDate
  -Make -Model -LensModel
  -DateTimeOriginal -CreateDate
  -FNumber -ExposureTime -FocalLength -FocalLengthIn35mmFormat
  -ISO
  -ImageWidth -ImageHeight -Orientation
  -GPSLatitude -GPSLongitude -GPSAltitude
  -ExposureProgram -MeteringMode -Flash -WhiteBalance -ColorSpace
  "-IPTC:Headline" "-IPTC:Caption-Abstract" "-IPTC:Keywords"
  "-IPTC:CopyrightNotice" "-IPTC:Credit" "-IPTC:Source"
  "-IPTC:City" "-IPTC:Province-State" "-IPTC:Country-PrimaryLocationName"
)

process_batch() {
  local db="$1"
  shift
  local -a files=("$@")

  [[ "${#files[@]}" -eq 0 ]] && return 0

  # Run exiftool with numeric GPS, JSON output
  local json_output
  json_output="$(exiftool -json -n "${EXIFTOOL_TAGS[@]}" "${files[@]}" 2>/dev/null)" || return 0

  [[ -z "${json_output}" ]] && return 0

  # Parse JSON and insert into SQLite using Python (reliable JSON+SQL handling)
  python3 -c "
import json, sqlite3, sys, os

data = json.loads(sys.stdin.read())
db = sys.argv[1]
conn = sqlite3.connect(db)
c = conn.cursor()

for rec in data:
    src = rec.get('SourceFile', '')
    if not src:
        continue
    fp = os.path.abspath(src)
    kw = rec.get('Keywords', '')
    if isinstance(kw, list):
        kw = ', '.join(str(k) for k in kw)
    elif kw is None:
        kw = ''

    c.execute('''INSERT OR REPLACE INTO photos (
        file_path, file_name, file_size, file_type, file_mtime,
        make, model, lens_model, date_time_original, create_date,
        f_number, exposure_time, focal_length, focal_length_35, iso,
        image_width, image_height, orientation,
        gps_latitude, gps_longitude, gps_altitude,
        exposure_program, metering_mode, flash, white_balance, color_space,
        headline, caption, keywords, copyright, credit, source,
        city, state, country, updated_at
    ) VALUES (
        ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now')
    )''', (
        fp,
        rec.get('FileName', ''),
        rec.get('FileSize'),
        rec.get('FileType', ''),
        None,  # mtime filled separately if needed
        rec.get('Make', ''),
        rec.get('Model', ''),
        rec.get('LensModel', ''),
        rec.get('DateTimeOriginal', ''),
        rec.get('CreateDate', ''),
        rec.get('FNumber'),
        str(rec.get('ExposureTime', '')) if rec.get('ExposureTime') is not None else '',
        rec.get('FocalLength'),
        rec.get('FocalLengthIn35mmFormat'),
        rec.get('ISO'),
        rec.get('ImageWidth'),
        rec.get('ImageHeight'),
        str(rec.get('Orientation', '')),
        rec.get('GPSLatitude'),
        rec.get('GPSLongitude'),
        rec.get('GPSAltitude'),
        str(rec.get('ExposureProgram', '')),
        str(rec.get('MeteringMode', '')),
        str(rec.get('Flash', '')),
        str(rec.get('WhiteBalance', '')),
        str(rec.get('ColorSpace', '')),
        rec.get('Headline', ''),
        rec.get('Caption-Abstract', ''),
        kw,
        rec.get('CopyrightNotice', ''),
        rec.get('Credit', ''),
        rec.get('Source', ''),
        rec.get('City', ''),
        rec.get('Province-State', ''),
        rec.get('Country-PrimaryLocationName', ''),
    ))

conn.commit()
conn.close()
print(len(data))
" "${db}" <<< "${json_output}"
}

# ---------------------------------------------------------------------------
# Main workflows
# ---------------------------------------------------------------------------

process_file_list() {
  # Process a file containing one path per line, in batches
  local db="$1"
  local file_list="$2"
  local total="$3"

  local tmpdir
  tmpdir="$(mktemp -d)"

  # Split into batch files
  split -l "${BATCH_SIZE}" -d "${file_list}" "${tmpdir}/batch_"

  local batch_files=("${tmpdir}"/batch_*)
  local total_batches="${#batch_files[@]}"
  local processed=0
  local completed=0

  log "Processing ${total_batches} batches (${total} files)..."

  for bf in "${batch_files[@]}"; do
    local -a files_in_batch=()
    while IFS= read -r line; do
      [[ -n "${line}" ]] && files_in_batch+=("${line}")
    done < "${bf}"

    if [[ "${#files_in_batch[@]}" -gt 0 ]]; then
      local count
      count="$(process_batch "${db}" "${files_in_batch[@]}" 2>/dev/null)" || count=0
      processed=$((processed + count))
    fi
    completed=$((completed + 1))
    vlog "  Batch ${completed}/${total_batches}: ${processed} files indexed"
  done

  rm -rf "${tmpdir}"
  echo "${processed}"
}

run_build() {
  local db="$1"

  log "Building catalog: ${INPUT_DIR}"
  log "Database: ${db}"
  log "Batch size: ${BATCH_SIZE}"

  # Drop and recreate
  rm -f "${db}"
  init_db "${db}"

  local tmpdir
  tmpdir="$(mktemp -d)"
  trap "rm -rf '${tmpdir}'" EXIT

  local total
  total="$(discover_files_to_list "${tmpdir}/all_files.txt")"
  log "Files found: ${total}"

  if [[ "${total}" -eq 0 ]]; then
    log "No files to index"
    return
  fi

  local processed
  processed="$(process_file_list "${db}" "${tmpdir}/all_files.txt" "${total}")"
  log "Catalog built: ${processed} files indexed"
}

run_update() {
  local db="$1"

  if [[ ! -f "${db}" ]]; then
    log "No existing catalog found, running full build..."
    run_build "${db}"
    return
  fi

  log "Updating catalog: ${INPUT_DIR}"
  log "Database: ${db}"

  local tmpdir
  tmpdir="$(mktemp -d)"
  trap "rm -rf '${tmpdir}'" EXIT

  # Discover current files on disk
  discover_files_to_list "${tmpdir}/current_files.txt" > /dev/null

  # Get already-indexed files (as absolute paths)
  sqlite3 "${db}" "SELECT file_path FROM photos;" > "${tmpdir}/indexed_files.txt" 2>/dev/null || touch "${tmpdir}/indexed_files.txt"

  # Convert current files to absolute paths for comparison
  while IFS= read -r f; do
    [[ -n "${f}" ]] && echo "$(cd "$(dirname "${f}")" && pwd)/$(basename "${f}")"
  done < "${tmpdir}/current_files.txt" > "${tmpdir}/current_abs.txt"

  # Find new files (in current but not in indexed)
  sort "${tmpdir}/current_abs.txt" > "${tmpdir}/current_sorted.txt"
  sort "${tmpdir}/indexed_files.txt" > "${tmpdir}/indexed_sorted.txt"
  comm -23 "${tmpdir}/current_sorted.txt" "${tmpdir}/indexed_sorted.txt" > "${tmpdir}/new_files.txt"

  local new_count
  new_count="$(wc -l < "${tmpdir}/new_files.txt" | tr -d ' ')"

  if [[ "${new_count}" -eq 0 ]]; then
    log "Catalog is up to date — no new files found"
    return
  fi

  local processed
  processed="$(process_file_list "${db}" "${tmpdir}/new_files.txt" "${new_count}")"
  log "Update complete: ${processed} new files indexed"
}

run_prune() {
  local db="$1"

  if [[ ! -f "${db}" ]]; then
    die "No catalog found at ${db}"
  fi

  log "Pruning catalog: removing entries for deleted files..."

  local removed=0
  local total
  total="$(sqlite3 "${db}" "SELECT COUNT(*) FROM photos;" 2>/dev/null || echo 0)"

  # Check each indexed file
  sqlite3 "${db}" "SELECT file_path FROM photos;" 2>/dev/null | while IFS= read -r fp; do
    if [[ ! -f "${fp}" ]]; then
      sqlite3 "${db}" "DELETE FROM photos WHERE file_path = '$(echo "${fp}" | sed "s/'/''/g")';" 2>/dev/null
      ((removed += 1)) || true
      vlog "  Removed: ${fp}"
    fi
  done

  local after
  after="$(sqlite3 "${db}" "SELECT COUNT(*) FROM photos;" 2>/dev/null || echo 0)"
  local pruned=$((total - after))

  log "Pruned ${pruned} entries (${after} remaining)"
}

run_stats() {
  local db="$1"

  if [[ ! -f "${db}" ]]; then
    die "No catalog found at ${db}"
  fi

  log "Catalog: ${db}"
  log ""

  sqlite3 -header -column "${db}" <<'SQL'
SELECT
    COUNT(*) AS total_files,
    COUNT(DISTINCT model) AS camera_models,
    COUNT(CASE WHEN gps_latitude IS NOT NULL AND gps_latitude != 0 THEN 1 END) AS with_gps,
    COUNT(CASE WHEN keywords != '' THEN 1 END) AS with_keywords,
    COUNT(CASE WHEN headline != '' THEN 1 END) AS with_headline,
    COUNT(CASE WHEN caption != '' THEN 1 END) AS with_caption,
    MIN(date_time_original) AS earliest_date,
    MAX(date_time_original) AS latest_date
FROM photos;
SQL

  log ""
  log "Camera models:"
  sqlite3 -column "${db}" "SELECT model, COUNT(*) AS count FROM photos WHERE model != '' GROUP BY model ORDER BY count DESC LIMIT 10;"

  log ""
  log "File types:"
  sqlite3 -column "${db}" "SELECT file_type, COUNT(*) AS count FROM photos GROUP BY file_type ORDER BY count DESC;"
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--db)
      [[ $# -lt 2 ]] && die "$1 requires a file path"
      DB_FILE="$2"
      shift 2
      ;;
    -t|--types)
      [[ $# -lt 2 ]] && die "$1 requires comma-separated extensions"
      FILE_TYPES="$2"
      shift 2
      ;;
    -D|--depth)
      [[ $# -lt 2 ]] && die "$1 requires a number"
      MAX_DEPTH="$2"
      shift 2
      ;;
    -j|--jobs)
      [[ $# -lt 2 ]] && die "$1 requires a number"
      JOBS="$2"
      shift 2
      ;;
    -b|--batch-size)
      [[ $# -lt 2 ]] && die "$1 requires a number"
      BATCH_SIZE="$2"
      shift 2
      ;;
    -f|--file-pattern)
      [[ $# -lt 2 ]] && die "$1 requires a glob pattern"
      FILE_PATTERN="$2"
      shift 2
      ;;
    -F|--folder-pattern)
      [[ $# -lt 2 ]] && die "$1 requires a glob pattern"
      FOLDER_PATTERN="$2"
      shift 2
      ;;
    -m|--mode)
      [[ $# -lt 2 ]] && die "$1 requires build|update|prune|stats"
      MODE="$2"
      shift 2
      ;;
    -v|--verbose)
      VERBOSE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      if [[ "${INPUT_DIR}" != "." ]]; then
        die "only one DIRECTORY argument is supported"
      fi
      INPUT_DIR="$1"
      shift
      ;;
  esac
done

# Validate
if [[ ! -d "${INPUT_DIR}" ]]; then
  die "input directory not found: ${INPUT_DIR}"
fi

INPUT_DIR="$(cd "${INPUT_DIR}" && pwd)"

# Default DB location
if [[ -z "${DB_FILE}" ]]; then
  DB_FILE="${INPUT_DIR}/.photoshell/catalog.db"
fi

mkdir -p "$(dirname "${DB_FILE}")"

# Check dependencies
command -v exiftool >/dev/null 2>&1 || die "exiftool is required"
command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 is required"
command -v python3 >/dev/null 2>&1 || die "python3 is required"

case "${MODE}" in
  build)   run_build "${DB_FILE}" ;;
  update)  run_update "${DB_FILE}" ;;
  prune)   run_prune "${DB_FILE}" ;;
  stats)   run_stats "${DB_FILE}" ;;
  *)       die "invalid mode: ${MODE} (use build|update|prune|stats)" ;;
esac

log ""
log "Done."
