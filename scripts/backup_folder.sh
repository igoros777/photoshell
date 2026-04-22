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
#   --jobs N            Parallel workers for multi-part archive.
#                       1 (default) = single archive, backwards compatible.
#                       >=2 = split into N .partNN archive files, produced
#                       in parallel. Use "auto" to auto-detect cores (capped
#                       at 8 — more rarely helps when I/O is the bottleneck).
#   --compress MODE     Compression mode: none (default), pigz, gzip, zstd.
#                       "none" writes .tar (fastest — photos don't compress).
#                       "pigz" uses all cores in store mode (-0).
#                       "gzip" is single-threaded gzip compression.
#                       "zstd" uses all cores with small compression (-1 -T0).
#   --estimate          Only show estimated size and available space
#   --preflight-json    Emit machine-readable preflight (size/space/status/fs).
#                       Exits 0 if ok, non-zero if insufficient/tight — caller
#                       decides whether to proceed.
#   --force             Proceed even if preflight says disk space is "tight"
#                       (below safe reserve but above required size).
#   --no-wrap           Deprecated, kept for backward compatibility (no-op).
#                       Multi-part backups always produce a subdirectory
#                       containing parts + README — the old concat-into-one
#                       step doubled I/O on slow filesystems and has been
#                       removed. Users who want a single .tar can run
#                       `tar -cf backup.tar backup_dir/` themselves.
#   --dry-run           Show what would be archived without creating the archive
#   -h, --help          Show this help message
#
# Output layout (multi-part, --jobs >=2):
#   backup_YYYYMMDD-HHMMSS_<foldername>/           ← one directory per run
#     part01.<ext>
#     part02.<ext>
#     ...
#     README.txt
#
# Single-worker mode (--jobs 1):
#   backup_YYYYMMDD-HHMMSS_<foldername>.<ext>     ← single file

set -euo pipefail

SOURCE=""
DEST=""
RECURSIVE=false
ESTIMATE_ONLY=false
DRY_RUN=false
JOBS="1"
COMPRESS="none"
PREFLIGHT_JSON=false
FORCE_TIGHT=false
NO_WRAP=false

usage() {
    sed -n '2,/^$/{ s/^# \?//; p }' "$0"
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --source)         SOURCE="$2"; shift 2 ;;
        --dest)           DEST="$2"; shift 2 ;;
        --recursive)      RECURSIVE=true; shift ;;
        --jobs)           JOBS="$2"; shift 2 ;;
        --compress)       COMPRESS="$2"; shift 2 ;;
        --estimate)       ESTIMATE_ONLY=true; shift ;;
        --preflight-json) PREFLIGHT_JSON=true; shift ;;
        --force)          FORCE_TIGHT=true; shift ;;
        --no-wrap)        NO_WRAP=true; shift ;;
        --dry-run)        DRY_RUN=true; shift ;;
        -h|--help)        usage ;;
        *)                echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

# ---- Signal handling: clean up partial archives, kill child processes ----
# Track filesystem artifacts to remove if we get SIGTERM/SIGINT mid-run.
declare -a CREATED_ARTIFACTS=()
SIGNAL_CLEANUP_ACTIVE=false

cleanup_on_signal() {
    # Re-entry guard — the signal handler can fire twice if the child death
    # triggers a second signal propagation.
    $SIGNAL_CLEANUP_ACTIVE && exit 130
    SIGNAL_CLEANUP_ACTIVE=true
    trap - TERM INT   # avoid re-entry from the signal we're about to send
    echo >&2
    echo "*** Cancel signal received — terminating workers and cleaning up ***" >&2

    # STEP 1 — Kill workers but NOT ourselves. Sending to the process group
    # includes this shell, so we target direct children and their descendants
    # instead. `jobs -p` lists backgrounded jobs started by this shell; pkill
    # -P then reaches each job's descendants (tar, pigz, zstd, etc.).
    local child
    for child in $(jobs -p 2>/dev/null); do
        pkill -TERM -P "$child" 2>/dev/null || true
        kill -TERM "$child" 2>/dev/null || true
    done

    # STEP 2 — Wait briefly for graceful termination, then SIGKILL stragglers.
    sleep 0.3
    for child in $(jobs -p 2>/dev/null); do
        pkill -KILL -P "$child" 2>/dev/null || true
        kill -KILL "$child" 2>/dev/null || true
    done

    # STEP 3 — Remove every partial archive we know about. Do this AFTER the
    # workers are dead so nothing is re-creating files as we delete them.
    for f in "${CREATED_ARTIFACTS[@]}"; do
        [[ -f "$f" ]] && rm -f "$f"
    done
    if [[ -n "${ARCHIVE_BASE:-}" && -d "${DEST:-}" ]]; then
        # Multi-part mode: parts live in ${DEST}/${ARCHIVE_BASE}/ — nuke the
        # whole subdirectory.
        [[ -d "${DEST}/${ARCHIVE_BASE}" ]] && rm -rf "${DEST}/${ARCHIVE_BASE}"
        # Single-file mode leftover.
        rm -f "${DEST}/${ARCHIVE_BASE}.${ARCHIVE_EXT:-tar}" 2>/dev/null || true
    fi

    echo "*** Cleanup complete ***" >&2
    exit 130
}
trap cleanup_on_signal TERM INT

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

# ---- Resolve --jobs ----

if [[ "$JOBS" == "auto" ]]; then
    JOBS=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
    # I/O bound work: more than 8 workers typically hurts
    (( JOBS > 8 )) && JOBS=8
fi
if ! [[ "$JOBS" =~ ^[0-9]+$ ]] || (( JOBS < 1 )); then
    echo "ERROR: --jobs must be a positive integer or 'auto' (got: $JOBS)" >&2
    exit 1
fi

# ---- Resolve --compress ----

case "$COMPRESS" in
    none)
        ARCHIVE_EXT="tar"
        COMPRESS_PROG=""
        COMPRESS_LABEL="none (tar only)"
        ;;
    gzip)
        ARCHIVE_EXT="tar.gz"
        COMPRESS_PROG="gzip"
        COMPRESS_LABEL="gzip (single-threaded)"
        ;;
    pigz)
        if ! command -v pigz >/dev/null 2>&1; then
            echo "ERROR: --compress pigz requested but pigz is not installed" >&2
            exit 1
        fi
        CORES=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
        # In multi-part mode, give each worker fewer pigz threads so we don't
        # oversubscribe CPU — each part has its own pigz.
        if (( JOBS > 1 )); then
            PIGZ_THREADS=$(( CORES / JOBS ))
            (( PIGZ_THREADS < 1 )) && PIGZ_THREADS=1
        else
            PIGZ_THREADS=$CORES
        fi
        ARCHIVE_EXT="tar.gz"
        COMPRESS_PROG="pigz -0 -p ${PIGZ_THREADS}"
        COMPRESS_LABEL="pigz -0 (${PIGZ_THREADS} threads/worker, store)"
        ;;
    zstd)
        if ! command -v zstd >/dev/null 2>&1; then
            echo "ERROR: --compress zstd requested but zstd is not installed" >&2
            exit 1
        fi
        CORES=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
        if (( JOBS > 1 )); then
            ZSTD_THREADS=$(( CORES / JOBS ))
            (( ZSTD_THREADS < 1 )) && ZSTD_THREADS=1
        else
            ZSTD_THREADS=$CORES
        fi
        ARCHIVE_EXT="tar.zst"
        COMPRESS_PROG="zstd -1 -T${ZSTD_THREADS} -q"
        COMPRESS_LABEL="zstd -1 (${ZSTD_THREADS} threads/worker)"
        ;;
    *)
        echo "ERROR: --compress must be one of: none, gzip, pigz, zstd (got: $COMPRESS)" >&2
        exit 1
        ;;
esac

# ---- Helpers ----

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

# Detect filesystem type of a path. Empty string if unknown.
detect_fs_type() {
    local path="$1"
    if command -v findmnt >/dev/null 2>&1; then
        findmnt -T "$path" -n -o FSTYPE 2>/dev/null | head -1
    elif command -v stat >/dev/null 2>&1; then
        stat -f -c %T "$path" 2>/dev/null | head -1
    fi
}

# True if filesystem type indicates a network mount or network-proxied mount
# (9p in WSL2, sshfs, fuse.*, NFS, CIFS/SMB, davfs, etc.).
is_network_fs() {
    case "$1" in
        nfs|nfs4|cifs|smb|smb3|smbfs|sshfs|9p|davfs|fuse.sshfs|fuse.rclone|fuse.s3fs)
            return 0 ;;
        fuse*)
            # Be conservative — most fuse mounts are network-proxied (rclone,
            # s3fs, GCSFuse) or slow in ways the user cares about.
            return 0 ;;
        *)  return 1 ;;
    esac
}

# ---- Estimate size, available space, safe reserve ----

if ! $PREFLIGHT_JSON; then
    echo "============================================================"
    echo "Backup: $SOURCE"
    echo "Destination: $DEST"
    echo "Recursive: $RECURSIVE"
    echo "Workers: $JOBS $([[ $JOBS -gt 1 ]] && echo '(parallel multi-part)' || echo '(single archive)')"
    echo "Compression: $COMPRESS_LABEL"
    echo "============================================================"
    echo
fi

if $RECURSIVE; then
    FIND_ARGS=(-type f)
else
    FIND_ARGS=(-maxdepth 1 -type f)
fi

FILE_COUNT=$(find "$SOURCE" "${FIND_ARGS[@]}" | wc -l)
if $RECURSIVE; then
    DIR_COUNT=$(find "$SOURCE" -mindepth 1 -type d | wc -l)
else
    DIR_COUNT=0
fi
SIZE_BYTES=$(find "$SOURCE" "${FIND_ARGS[@]}" -exec stat --format='%s' {} + 2>/dev/null \
             || find "$SOURCE" "${FIND_ARGS[@]}" -exec stat -f '%z' {} + 2>/dev/null \
             || echo "0")
SIZE_BYTES=$(echo "$SIZE_BYTES" | awk '{ s += $1 } END { print s+0 }')

# Required = source size + small tar overhead. For multi-part with --no-wrap
# we need exactly this. For the default bundle wrap, peak usage during
# concat-and-remove is ~1 part size extra (~1/JOBS fraction), so we pad 15%.
if [[ "$COMPRESS" == "none" ]]; then
    ARCHIVE_FACTOR=101   # tar overhead ~1%
else
    ARCHIVE_FACTOR=85    # light compression savings estimate
fi
REQUIRED_BYTES=$((SIZE_BYTES * ARCHIVE_FACTOR / 100))
if (( JOBS > 1 )) && ! $NO_WRAP; then
    # Bundle wrap needs transient headroom for the part we're currently
    # concatenating (one part size = total / JOBS), then removed.
    REQUIRED_BYTES=$((REQUIRED_BYTES + REQUIRED_BYTES / JOBS + 65536))
fi
(( REQUIRED_BYTES < 65536 )) && REQUIRED_BYTES=65536

AVAIL_BYTES=$(df --output=avail -B1 "$DEST" 2>/dev/null | tail -1 | tr -d ' ' \
              || df -k "$DEST" 2>/dev/null | tail -1 | awk '{ print $4 * 1024 }')
TOTAL_BYTES=$(df --output=size -B1 "$DEST" 2>/dev/null | tail -1 | tr -d ' ' \
              || df -k "$DEST" 2>/dev/null | tail -1 | awk '{ print $2 * 1024 }')

# Safe reserve: keep the filesystem from getting "too full". Rule of thumb:
#   5% of total, min 1 GB, max 10 GB.
# On network/FUSE filesystems we double the reserve — those mounts degrade
# badly (or lock up entirely) when nearly full.
SAFE_RESERVE=$((TOTAL_BYTES * 5 / 100))
(( SAFE_RESERVE < 1073741824 )) && SAFE_RESERVE=1073741824        # 1 GB min
(( SAFE_RESERVE > 10737418240 )) && SAFE_RESERVE=10737418240      # 10 GB max

SOURCE_FS=$(detect_fs_type "$SOURCE" || echo "")
DEST_FS=$(detect_fs_type "$DEST" || echo "")
NETWORK_WARNING=""
if [[ -n "$SOURCE_FS" ]] && is_network_fs "$SOURCE_FS"; then
    NETWORK_WARNING="source on $SOURCE_FS"
fi
if [[ -n "$DEST_FS" ]] && is_network_fs "$DEST_FS"; then
    NETWORK_WARNING="${NETWORK_WARNING:+$NETWORK_WARNING; }dest on $DEST_FS"
    SAFE_RESERVE=$((SAFE_RESERVE * 2))
fi

# Classify space: ok / tight / insufficient
PREFLIGHT_STATUS="ok"
if (( AVAIL_BYTES < REQUIRED_BYTES )); then
    PREFLIGHT_STATUS="insufficient"
elif (( AVAIL_BYTES - REQUIRED_BYTES < SAFE_RESERVE )); then
    PREFLIGHT_STATUS="tight"
fi

# ---- Preflight JSON mode ----
# Machine-readable output for the Flask UI to render a modal before running
# the actual backup. Emits JSON then exits 0.
if $PREFLIGHT_JSON; then
    # Escape filesystem strings for JSON
    json_escape() { printf '%s' "$1" | sed 's/["\\]/\\&/g; s/[[:cntrl:]]//g'; }
    cat <<EOF
{
  "status": "$PREFLIGHT_STATUS",
  "size_bytes": $SIZE_BYTES,
  "required_bytes": $REQUIRED_BYTES,
  "available_bytes": $AVAIL_BYTES,
  "total_bytes": $TOTAL_BYTES,
  "safe_reserve_bytes": $SAFE_RESERVE,
  "file_count": $FILE_COUNT,
  "dir_count": $DIR_COUNT,
  "source_fs": "$(json_escape "$SOURCE_FS")",
  "dest_fs": "$(json_escape "$DEST_FS")",
  "network_warning": "$(json_escape "$NETWORK_WARNING")",
  "jobs": $JOBS,
  "compress": "$COMPRESS",
  "bundle": $([[ $JOBS -gt 1 ]] && ! $NO_WRAP && echo true || echo false)
}
EOF
    exit 0
fi

echo "Source size:          $(human_size "$SIZE_BYTES") ($FILE_COUNT files${DIR_COUNT:+, $DIR_COUNT subdirectories})"
echo "Estimated needed:     $(human_size "$REQUIRED_BYTES")"
echo "Available at dest:    $(human_size "$AVAIL_BYTES")"
echo "Safe reserve:         $(human_size "$SAFE_RESERVE") ($DEST_FS)"
if [[ -n "$NETWORK_WARNING" ]]; then
    echo "NOTE: network filesystem detected ($NETWORK_WARNING) — this may take longer."
fi
echo

case "$PREFLIGHT_STATUS" in
    insufficient)
        echo "ERROR: Insufficient disk space." >&2
        echo "       Need $(human_size "$REQUIRED_BYTES"), only $(human_size "$AVAIL_BYTES") available." >&2
        exit 2
        ;;
    tight)
        if ! $FORCE_TIGHT; then
            echo "WARNING: Backup will leave less than $(human_size "$SAFE_RESERVE") free." >&2
            echo "         Pass --force to proceed anyway." >&2
            exit 3
        fi
        echo "Proceeding despite tight space (--force)."
        echo
        ;;
esac

if $ESTIMATE_ONLY; then
    echo "Estimate-only mode. No archive created."
    exit 0
fi

if (( FILE_COUNT == 0 )); then
    echo "No files to archive. Nothing to do."
    exit 0
fi

# ---- Dry run ----

if $DRY_RUN; then
    echo "Dry run - files that would be archived:"
    echo
    find "$SOURCE" "${FIND_ARGS[@]}" -print | head -200
    if (( FILE_COUNT > 200 )); then
        echo "... and $((FILE_COUNT - 200)) more files"
    fi
    echo
    echo "Total: $FILE_COUNT files"
    if (( JOBS > 1 )); then
        echo "Would produce $JOBS archive parts:"
        for i in $(seq 1 $JOBS); do
            printf "  %s/backup_%s_%s.part%02d.%s\n" \
                "$DEST" "$TIMESTAMP" "$FOLDER_NAME" "$i" "$ARCHIVE_EXT"
        done
    else
        echo "Would produce: $DEST/backup_${TIMESTAMP}_${FOLDER_NAME}.${ARCHIVE_EXT}"
    fi
    exit 0
fi

# ---- Build tar pipeline helper ----
# Writes archive from a file list (one relative path per line, -C = SOURCE).
# Args: $1 = path-list file, $2 = output archive path
run_tar_pipeline() {
    local filelist="$1"
    local outpath="$2"

    if [[ -n "$COMPRESS_PROG" ]]; then
        # Pipe tar through compressor. eval is unavoidable because
        # COMPRESS_PROG contains shell words (flags).
        tar -cf - -C "$SOURCE" -T "$filelist" | eval "$COMPRESS_PROG" > "$outpath"
    else
        # No compression: tar writes directly (one less pipe).
        tar -cf "$outpath" -C "$SOURCE" -T "$filelist"
    fi
}

# ---- Build file list (relative paths) ----
# Use NUL-safe format to survive exotic filenames, then convert to one-per-line
# manifests (tar -T expects one path per line by default).

WORK_DIR=$(mktemp -d -t photoshell-backup.XXXXXX)
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

FULL_MANIFEST="$WORK_DIR/all.lst"
find "$SOURCE" "${FIND_ARGS[@]}" -printf '%s\t%P\n' > "$FULL_MANIFEST"

START_TIME=$(date +%s)

# ---- Single-archive mode ----

if (( JOBS == 1 )); then
    ARCHIVE_BASE="backup_${TIMESTAMP}_${FOLDER_NAME}"
    ARCHIVE_NAME="${ARCHIVE_BASE}.${ARCHIVE_EXT}"
    ARCHIVE_PATH="${DEST}/${ARCHIVE_NAME}"
    CREATED_ARTIFACTS+=("$ARCHIVE_PATH")
    echo "Creating archive: $ARCHIVE_PATH"
    echo

    PATH_LIST="$WORK_DIR/single.lst"
    awk -F'\t' '{ sub(/^[0-9]+\t/, ""); print }' "$FULL_MANIFEST" > "$PATH_LIST"

    run_tar_pipeline "$PATH_LIST" "$ARCHIVE_PATH"

    ACTUAL_SIZE=$(stat --format='%s' "$ARCHIVE_PATH" 2>/dev/null \
                  || stat -f '%z' "$ARCHIVE_PATH" 2>/dev/null \
                  || echo "0")

    DURATION=$(( $(date +%s) - START_TIME ))
    echo
    echo "============================================================"
    echo "Backup complete!"
    echo "Archive:    $ARCHIVE_PATH"
    echo "Size:       $(human_size "$ACTUAL_SIZE")"
    echo "Files:      $FILE_COUNT"
    if $RECURSIVE && (( DIR_COUNT > 0 )); then
        echo "Subdirs:    $DIR_COUNT"
    fi
    echo "Duration:   ${DURATION}s"
    if (( DURATION > 0 )); then
        echo "Throughput: $(human_size $((SIZE_BYTES / DURATION)))/s"
    fi
    echo "============================================================"
    exit 0
fi

# ---- Multi-part parallel mode — static size-balanced bin packing ----
#
# Approach:
#   1. Sort the full file manifest largest-first.
#   2. Greedy bin-pack into JOBS bins (place each file in the currently
#      smallest bin). Produces near-equal byte counts per bin — within a few
#      percent even with mixed RAW + JPEG sizes.
#   3. Launch JOBS tar processes in parallel. Each runs ONE tar command,
#      streaming its entire bin in a single sequential pass. No per-file
#      overhead, no appends, no seeks. Maximum disk throughput.
#
# Why this beats dynamic work-stealing on slow / network filesystems:
#   `tar -rf archive file` (append) re-opens the archive, seeks to end,
#   reads the trailing zero blocks, truncates, writes, re-writes the trailer,
#   closes. On 9P / NFS / CIFS each of those syscalls incurs a round-trip.
#   At small batch sizes the overhead swamps actual data transfer and the
#   disk sits idle. ONE tar per worker means pure streaming I/O for the life
#   of each process — CPU cores and disk both stay pinned.

ARCHIVE_BASE="backup_${TIMESTAMP}_${FOLDER_NAME}"
OUT_DIR="${DEST}/${ARCHIVE_BASE}"
mkdir -p "$OUT_DIR"
CREATED_ARTIFACTS+=("$OUT_DIR")

echo "Partitioning $FILE_COUNT files across $JOBS bins (balanced by bytes)..."

# Greedy bin-packing. awk keeps JOBS running totals and assigns each file
# to the currently smallest bin. Sorted largest-first so big files get
# placed when there's still room to balance; small files fill the gaps.
sort -t $'\t' -k1,1 -rn "$FULL_MANIFEST" | gawk -v N="$JOBS" -v DIR="$WORK_DIR" '
    BEGIN { for (i = 1; i <= N; i++) { bin_size[i] = 0; bin_count[i] = 0 } }
    {
        # Split at first tab — paths may contain tabs in the extreme case.
        idx = index($0, "\t")
        size = substr($0, 1, idx - 1) + 0
        path = substr($0, idx + 1)

        # Place in the smallest bin so far.
        min = 1
        for (i = 2; i <= N; i++) if (bin_size[i] < bin_size[min]) min = i
        bin_size[min] += size
        bin_count[min]++
        print path >> (DIR "/chunk-" min ".lst")
    }
    END {
        for (i = 1; i <= N; i++) {
            if (bin_count[i] > 0) {
                printf "  bin %d: %d files, %.1f MB\n", \
                    i, bin_count[i], bin_size[i] / 1048576 > "/dev/stderr"
            }
        }
    }
'
echo

# Launch one tar pipeline per non-empty bin. They run concurrently and each
# one streams its entire bin in a single open-read-write-close cycle.
declare -a PIDS
declare -a PARTS

for i in $(seq 1 $JOBS); do
    CHUNK="$WORK_DIR/chunk-$i.lst"
    [[ -s "$CHUNK" ]] || continue
    PART_NAME=$(printf "part%02d.%s" "$i" "$ARCHIVE_EXT")
    PART_PATH="${OUT_DIR}/${PART_NAME}"
    PARTS+=("$PART_PATH")
    # OUT_DIR is already in CREATED_ARTIFACTS so individual parts are
    # covered by the subdirectory cleanup on signal.

    echo "  launching bin $i → $(basename "$OUT_DIR")/$PART_NAME"
    if [[ -n "$COMPRESS_PROG" ]]; then
        ( tar -cf - -C "$SOURCE" -T "$CHUNK" | eval "$COMPRESS_PROG" > "$PART_PATH" ) &
    else
        tar -cf "$PART_PATH" -C "$SOURCE" -T "$CHUNK" &
    fi
    PIDS+=($!)
done

echo
echo "All ${#PIDS[@]} workers running in parallel. Waiting for completion..."
echo

# Background progress reporter — every 3s, print each part's current size.
# Three reasons this exists:
#   1. Windows Explorer over 9P caches file sizes aggressively and only
#      shows live growth for the last-polled file. Users looking at the
#      folder think the backup is dead when in fact all N workers are
#      running. This log line proves parallelism is working.
#   2. The `stat` call pokes the 9P client, which sometimes nudges the
#      Windows-side file metadata to refresh.
#   3. Long multi-GB backups with no output look broken. Periodic progress
#      tells the user something is happening.
(
    while :; do
        sleep 3
        # Exit if parent is gone (script finished / cancelled).
        kill -0 $$ 2>/dev/null || exit 0
        total=0
        line="  [progress $(date +%H:%M:%S)]"
        all_parts=""
        for p in "${PARTS[@]}"; do
            if [[ -f "$p" ]]; then
                s=$(stat --format='%s' "$p" 2>/dev/null || echo 0)
                all_parts="$all_parts $((s / 1048576))"
                total=$((total + s))
            else
                all_parts="$all_parts -"
            fi
        done
        printf "%s part MB:%s  (total %d MB)\n" "$line" "$all_parts" \
            $((total / 1048576))
    done
) &
PROGRESS_PID=$!

FAILED=0
for pid in "${PIDS[@]}"; do
    if ! wait "$pid"; then
        FAILED=$((FAILED + 1))
    fi
done

# Stop the progress reporter once every worker is done.
kill "$PROGRESS_PID" 2>/dev/null || true
wait "$PROGRESS_PID" 2>/dev/null || true

if (( FAILED > 0 )); then
    echo "ERROR: $FAILED of ${#PIDS[@]} workers failed" >&2
    # Clean up partial archives so retry is clean.
    for p in "${PARTS[@]}"; do
        [[ -f "$p" ]] && rm -f "$p"
    done
    exit 1
fi

# ---- Write README alongside the parts (no concatenation step) ----
# Earlier versions of this script concatenated every part into one container
# file. On slow / network filesystems the concat pass doubled total I/O
# (read-all + write-all) for no real benefit, so it was removed. Users who
# need a single file can run `tar -cf bundle.tar backup_dir/` themselves.

TOTAL_SIZE=0
for p in "${PARTS[@]}"; do
    S=$(stat --format='%s' "$p" 2>/dev/null || stat -f '%z' "$p" 2>/dev/null || echo 0)
    TOTAL_SIZE=$((TOTAL_SIZE + S))
done

README_PATH="${OUT_DIR}/README.txt"
cat > "$README_PATH" <<EOF
PhotoShell Backup — Restore Instructions
========================================

Backup folder:  $(basename "$OUT_DIR")
Created:        $(date)
Source folder:  $SOURCE
Files:          $FILE_COUNT
Size:           $(human_size "$TOTAL_SIZE")
Compression:    $COMPRESS_LABEL
Parts:          ${#PARTS[@]} (written in parallel by $JOBS workers)

This folder contains ${#PARTS[@]} tar archive parts — each one was written
concurrently by a separate tar process. To restore your files, extract every
part into the same destination. The parts are independent; extract in any
order, and files from different parts merge back into their original tree.

----------------------------------------------------------------
CLI restoration (any operating system)
----------------------------------------------------------------
The 'tar' command ships with macOS, Windows 10+, and every Linux distro.

From inside this folder:

  Linux / macOS / Windows (Git Bash / WSL):
      for p in part*.${ARCHIVE_EXT}; do tar -xf "\$p"; done

  Windows PowerShell:
      Get-ChildItem part*.${ARCHIVE_EXT} | ForEach-Object { tar -xf \$_.Name }

To extract into a specific folder, pass -C:

  for p in part*.${ARCHIVE_EXT}; do tar -xf "\$p" -C /path/to/restore; done

To list contents without extracting:

  for p in part*.${ARCHIVE_EXT}; do tar -tf "\$p"; done

----------------------------------------------------------------
GUI restoration
----------------------------------------------------------------

Windows
  • Windows 11 / Windows 10 (recent): select all part*.${ARCHIVE_EXT} files,
    right-click, choose "Extract all…". Windows Explorer uses bsdtar
    internally and handles each part.
  • 7-Zip: install from 7-zip.org, select all parts, right-click →
    7-Zip → "Extract Here". Each part extracts its share of files.
  • WinRAR: select all parts, right-click → "Extract Here".

macOS
  • Double-click each part*.${ARCHIVE_EXT} file. The built-in Archive
    Utility will extract them one at a time. For batch extraction, install
    "The Unarchiver" from the App Store.
  • From Terminal, navigate into this folder and run the CLI command above.

Linux
  • GNOME: select all parts, right-click → "Extract".
  • KDE Ark, xarchiver, engrampa: same — select parts, extract.
  • Or use the CLI command above in a terminal.

----------------------------------------------------------------
Why multiple parts?
----------------------------------------------------------------
Writing one big tar archive is fundamentally single-threaded: a single tar
process reads files one at a time. This backup was made by $JOBS tar processes
running in parallel, each writing its own part. On large photo libraries
this is 4–8× faster than the single-file approach, especially on external
drives or network-mounted destinations.

If you prefer a single .tar file (for example to move the backup as one
unit), from inside this folder run:

  tar -cf ../$(basename "$OUT_DIR").tar .

This concatenates the parts + README into one regular tar. Note that on
slow filesystems this step can take as long as the backup itself.

If compression was used (--compress pigz | gzip | zstd), the parts are
.tar.gz or .tar.zst files — every modern tar reads them transparently.
For .tar.zst files you may need the 'zstd' binary:
  • macOS:   brew install zstd
  • Linux:   apt install zstd  (or your distro's equivalent)
  • Windows: winget install zstd

PhotoShell source and documentation:
  https://github.com/igoros777/photoshell
EOF

# ---- Report ----

DURATION=$(( $(date +%s) - START_TIME ))
echo
echo "============================================================"
echo "Backup complete!"
echo "Folder:     $(basename "$OUT_DIR")/"
echo "Parts:"
for p in "${PARTS[@]}"; do
    S=$(stat --format='%s' "$p" 2>/dev/null || stat -f '%z' "$p" 2>/dev/null || echo 0)
    printf "  %s  (%s)\n" "$(basename "$p")" "$(human_size "$S")"
done
echo "README:     README.txt (restore instructions, all platforms)"
echo "Total size: $(human_size "$TOTAL_SIZE")"
echo "Files:      $FILE_COUNT"
if $RECURSIVE && (( DIR_COUNT > 0 )); then
    echo "Subdirs:    $DIR_COUNT"
fi
echo "Duration:   ${DURATION}s"
if (( DURATION > 0 )); then
    echo "Throughput: $(human_size $((SIZE_BYTES / DURATION)))/s"
fi
echo "Workers:    $JOBS"
echo "============================================================"
echo
echo "To restore: cd $(basename "$OUT_DIR") && for p in part*.${ARCHIVE_EXT}; do tar -xf \"\$p\"; done"
echo "            (see README.txt for Windows/Mac/Linux GUI options)"
