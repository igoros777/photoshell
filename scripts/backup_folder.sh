#!/usr/bin/env bash
# backup_folder.sh - Create a timestamped backup archive of a photo folder
#
# Usage:
#   backup_folder.sh [OPTIONS]
#
# Options:
#   --source DIR        Source directory to back up (required)
#   --dest DIR          Destination directory for the archive (default: source dir)
#   --recursive         Include subdirectories (default: top-level files only)
#   --estimate          Only show estimated size and available space, do not back up
#   --dry-run           Show what would be archived without creating the archive
#   -h, --help          Show this help message
#
# The archive is a .tar.gz file named:
#   backup_YYYYMMDD-HHMMSS_<foldername>.tar.gz

set -euo pipefail

SOURCE=""
DEST=""
RECURSIVE=false
ESTIMATE_ONLY=false
DRY_RUN=false

usage() {
    sed -n '2,/^$/{ s/^# \?//; p }' "$0"
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --source)      SOURCE="$2"; shift 2 ;;
        --dest)        DEST="$2"; shift 2 ;;
        --recursive)   RECURSIVE=true; shift ;;
        --estimate)    ESTIMATE_ONLY=true; shift ;;
        --dry-run)     DRY_RUN=true; shift ;;
        -h|--help)     usage ;;
        *)             echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "$SOURCE" ]]; then
    echo "ERROR: --source is required" >&2
    exit 1
fi

if [[ ! -d "$SOURCE" ]]; then
    echo "ERROR: Source directory does not exist: $SOURCE" >&2
    exit 1
fi

# Default destination to the source directory
if [[ -z "$DEST" ]]; then
    DEST="$SOURCE"
fi

if [[ ! -d "$DEST" ]]; then
    echo "ERROR: Destination directory does not exist: $DEST" >&2
    exit 1
fi

# Resolve to absolute paths
SOURCE="$(cd "$SOURCE" && pwd)"
DEST="$(cd "$DEST" && pwd)"

FOLDER_NAME="$(basename "$SOURCE")"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE_NAME="backup_${TIMESTAMP}_${FOLDER_NAME}.tar.gz"
ARCHIVE_PATH="${DEST}/${ARCHIVE_NAME}"

# ---- Estimate size ----

human_size() {
    local bytes=$1
    if (( bytes >= 1073741824 )); then
        printf "%.2f GB" "$(echo "scale=2; $bytes / 1073741824" | bc)"
    elif (( bytes >= 1048576 )); then
        printf "%.2f MB" "$(echo "scale=2; $bytes / 1048576" | bc)"
    elif (( bytes >= 1024 )); then
        printf "%.2f KB" "$(echo "scale=2; $bytes / 1024" | bc)"
    else
        printf "%d bytes" "$bytes"
    fi
}

echo "============================================================"
echo "Backup: $SOURCE"
echo "Destination: $DEST"
echo "Recursive: $RECURSIVE"
echo "============================================================"
echo

# Calculate source size and file count
if $RECURSIVE; then
    FILE_COUNT=$(find "$SOURCE" -type f | wc -l)
    DIR_COUNT=$(find "$SOURCE" -mindepth 1 -type d | wc -l)
    SIZE_BYTES=$(find "$SOURCE" -type f -exec stat --format='%s' {} + 2>/dev/null \
                 || find "$SOURCE" -type f -exec stat -f '%z' {} + 2>/dev/null \
                 || echo "0")
    # Sum all sizes if multiple lines
    SIZE_BYTES=$(echo "$SIZE_BYTES" | awk '{ s += $1 } END { print s+0 }')
else
    FILE_COUNT=$(find "$SOURCE" -maxdepth 1 -type f | wc -l)
    DIR_COUNT=0
    SIZE_BYTES=$(find "$SOURCE" -maxdepth 1 -type f -exec stat --format='%s' {} + 2>/dev/null \
                 || find "$SOURCE" -maxdepth 1 -type f -exec stat -f '%z' {} + 2>/dev/null \
                 || echo "0")
    SIZE_BYTES=$(echo "$SIZE_BYTES" | awk '{ s += $1 } END { print s+0 }')
fi

# Estimate compressed size (rough: 85% of original for photos, which don't compress well)
ESTIMATED_ARCHIVE=$((SIZE_BYTES * 85 / 100))
if (( ESTIMATED_ARCHIVE < 1024 )); then
    ESTIMATED_ARCHIVE=$SIZE_BYTES
fi

# Available space at destination
AVAIL_BYTES=$(df --output=avail -B1 "$DEST" 2>/dev/null | tail -1 | tr -d ' ' \
              || df -k "$DEST" 2>/dev/null | tail -1 | awk '{ print $4 * 1024 }')

echo "Source size:          $(human_size "$SIZE_BYTES") ($FILE_COUNT files${DIR_COUNT:+, $DIR_COUNT subdirectories})"
echo "Estimated archive:    $(human_size "$ESTIMATED_ARCHIVE")"
echo "Available at dest:    $(human_size "$AVAIL_BYTES")"
echo

if (( ESTIMATED_ARCHIVE > AVAIL_BYTES )); then
    echo "WARNING: Estimated archive size exceeds available disk space!"
    echo "         You may run out of space during the backup."
    echo
fi

if $ESTIMATE_ONLY; then
    echo "Estimate-only mode. No archive created."
    exit 0
fi

# ---- Dry run ----

if $DRY_RUN; then
    echo "Dry run - files that would be archived:"
    echo "Archive would be: $ARCHIVE_PATH"
    echo
    if $RECURSIVE; then
        find "$SOURCE" -type f -print | head -200
        TOTAL=$(find "$SOURCE" -type f | wc -l)
    else
        find "$SOURCE" -maxdepth 1 -type f -print | head -200
        TOTAL=$(find "$SOURCE" -maxdepth 1 -type f | wc -l)
    fi
    if (( TOTAL > 200 )); then
        echo "... and $((TOTAL - 200)) more files"
    fi
    echo
    echo "Total: $TOTAL files"
    exit 0
fi

# ---- Create backup ----

# Select compression program: pigz (parallel) > gzip (single-threaded)
COMPRESS_PROG="gzip"
COMPRESS_LABEL="gzip (single-threaded)"
if command -v pigz >/dev/null 2>&1; then
    CORES=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
    COMPRESS_PROG="pigz -0 -p ${CORES}"
    COMPRESS_LABEL="pigz -0 (${CORES} threads, store — photos don't compress)"
fi

echo "Creating archive: $ARCHIVE_PATH"
echo "Compression: ${COMPRESS_LABEL}"
echo

if $RECURSIVE; then
    tar -cf - -C "$(dirname "$SOURCE")" "$FOLDER_NAME" | ${COMPRESS_PROG} > "$ARCHIVE_PATH"
else
    # Non-recursive: only top-level files
    # Use null-terminated strings to handle filenames with spaces/special chars
    find "$SOURCE" -maxdepth 1 -type f -printf '%f\0' 2>/dev/null \
        | tar -cf - -C "$SOURCE" --null -T - 2>/dev/null \
        | ${COMPRESS_PROG} > "$ARCHIVE_PATH" \
    || {
        # macOS/BSD fallback: -printf not available
        cd "$SOURCE"
        find . -maxdepth 1 -type f -print0 | sed -z 's|^\./||' \
            | tar -cf - --null -T - | ${COMPRESS_PROG} > "$ARCHIVE_PATH"
    }
fi

ACTUAL_SIZE=$(stat --format='%s' "$ARCHIVE_PATH" 2>/dev/null \
              || stat -f '%z' "$ARCHIVE_PATH" 2>/dev/null \
              || echo "0")

echo
echo "============================================================"
echo "Backup complete!"
echo "Archive:    $ARCHIVE_PATH"
echo "Size:       $(human_size "$ACTUAL_SIZE")"
echo "Files:      $FILE_COUNT"
if $RECURSIVE && (( DIR_COUNT > 0 )); then
    echo "Subdirs:    $DIR_COUNT"
fi
echo "============================================================"
