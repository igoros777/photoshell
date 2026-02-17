# detect_blurry_photos.sh

`scripts/detect_blurry_photos.sh` implements the blur-detection workflow from the assignment using ImageMagick.

It can:

- score JPG/JPEG sharpness with `-statistic StandardDeviation`
- copy scored files into an `analyzed` folder
- split photos into scenes by EXIF timestamp gaps plus visual similarity
- pick one sharpest photo per scene into a `selected` folder

## Requirements

- Linux Bash
- ImageMagick
  - IM7: `magick`
  - or IM6: `identify` + `convert` + `compare` (for visual scene split)
- common GNU tools: `find`, `sort`, `date`, `stat`

## Usage

```bash
scripts/detect_blurry_photos.sh [options]
```

Modes:

- `analyze`: score all images and copy as `<score>_<filename>`
- `select`: create scenes and select best from each scene
- `all`: run both (default)

Options:

- `-i, --input DIR`: input folder (default: `.`)
- `--analyzed-dir DIR`: output for analyzed files (default: `./analyzed`)
- `--scenes-dir DIR`: output for scenes (default: `./scenes`)
- `--selected-dir DIR`: output for selected files (default: `./selected`)
- `-t, --time-gap SECONDS`: new-scene threshold by EXIF time gap (default: `5`)
- `--no-visual`: disable visual similarity in scene split
- `--visual-threshold FLOAT`: visual-delta threshold for new scene (default: `0.10`)
- `--thumb-size PX`: normalized thumbnail size used for visual comparison (default: `256`)
- `-w, --window WxH`: ImageMagick window for blur metric (default: `5x5`)
- `-m, --mode MODE`: `analyze|select|all` (default: `all`)
- `--clean`: clear output folders before run
- `-n, --dry-run`: print actions only
- `-h, --help`: show help

## Examples

```bash
# Score and copy all JPEGs in current folder
scripts/detect_blurry_photos.sh --mode analyze --clean

# Split using both time and visual change
scripts/detect_blurry_photos.sh --mode select --time-gap 8 --visual-threshold 0.12 --clean

# Timestamp-only split (legacy behavior)
scripts/detect_blurry_photos.sh --mode select --time-gap 8 --no-visual --clean

# Full pipeline on a folder
scripts/detect_blurry_photos.sh --mode all --input "./trip_2026_02_14" --clean
```

## Workflow Diagram

```mermaid
flowchart TD
    A([Start]) --> B[Parse args and validate input/options]
    B --> C[Detect ImageMagick commands]
    C --> D{Visual split enabled<br/>and mode != analyze?}
    D -->|Yes| E{compare command available?}
    E -->|No| Z1([Exit with error])
    E -->|Yes| F[List JPG/JPEG images]
    D -->|No| F
    F --> G{Any images found?}
    G -->|No| Z2([Exit with error])
    G -->|Yes| H{Mode}

    H -->|analyze| I[run_analyze]
    H -->|select| J[run_select]
    H -->|all| K[run_analyze then run_select]

    I --> I1[Prepare analyzed dir]
    I1 --> I2[For each image: blur_score and copy as score_filename]
    I2 --> Z3([Done])

    J --> J1[split_scenes]
    K --> J1

    J1 --> S1[Prepare scenes dir and sort images by epoch]
    S1 --> S2[For each image]
    S2 --> S3{New scene?}
    S3 -->|Yes| S4[Create scene dir and record reason]
    S3 -->|No| S5[Keep current scene]
    S4 --> S6[Copy image into scene and update previous image/time]
    S5 --> S6
    S6 --> S2
    S2 -->|loop ends| J2[pick_best_per_scene]

    J2 --> P1[Prepare selected dir]
    P1 --> P2[For each scene: score images, keep highest score]
    P2 --> P3[Copy winner into selected dir]
    P3 --> Z3
```

## Notes

- Higher score means sharper image.
- Scene split uses timestamp and visual delta (`RMSE`) together by default.
- Timestamp extraction order: `EXIF:DateTimeOriginal`, then `EXIF:DateTime`, then file mtime fallback.
- The script only copies files; it does not edit metadata.
- For safety, non-empty output directories require `--clean`.
