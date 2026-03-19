# Contributing to PhotoShell

Thanks for your interest in contributing. PhotoShell is a practical toolkit — contributions that make photo workflows faster, more reliable, or easier to use are welcome.

## Getting Started

```bash
# Clone the repo
git clone https://github.com/igoros777/photoshell.git
cd photoshell

# Install script dependencies
# exiftool is required for almost everything
sudo apt install libimage-exiftool-perl   # Debian/Ubuntu
brew install exiftool                      # macOS

# Optional: ImageMagick (blur detection, contact sheets)
sudo apt install imagemagick               # Debian/Ubuntu
brew install imagemagick                   # macOS

# Optional: Ollama (AI annotation)
# See https://ollama.com for installation

# Run the web UI
cd ui/flask
pip install -r requirements.txt
python3 app.py
# Open http://localhost:5050
```

## Project Structure

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system diagram and design decisions.

**Key directories:**
- `scripts/` — standalone Bash scripts, each handles one workflow step
- `ui/flask/` — Flask web UI that orchestrates the scripts
- `docs/` — per-script documentation in Markdown

## Making Changes

### Bash Scripts

Each script in `scripts/` is self-contained. When modifying scripts:

- Use `set -euo pipefail` at the top
- Quote all variable references (`"$var"`, not `$var`)
- Use `mapfile -d '' -t` with `find -print0` for filename safety
- Batch exiftool calls — one `exiftool -T -n -Tag1 -Tag2 ... file` instead of multiple calls per tag
- Include `--dry-run` support where the script modifies files
- Don't change the script's CLI interface without updating `ui/flask/app.py` (`_build_step`)

### Web UI

The UI is vanilla JavaScript (no framework) with Bootstrap 5.3.

- CSS uses custom properties defined in `:root` (see [DESIGN.md](DESIGN.md) for the token spec)
- JS is split by feature but currently in one file (`app.js`)
- Form fields must have `name` attributes — `collectFormData()` reads them
- New API endpoints go in `app.py`, new constants in `functions/constants.py`

### Documentation

Each script has a corresponding `docs/{script_name}.md`. If you change a script's behavior, update its doc file. The README links to all doc files.

## Testing

PhotoShell currently uses:
- `--dry-run` modes in scripts for manual validation
- `bash -n script.sh` for syntax checking
- Pre-flight advisory checks in the web UI

When adding new features, include `--dry-run` support and test with real photo files before submitting.

## Code Style

- Bash: 2-space indent, snake_case functions, UPPER_CASE constants
- Python: PEP 8, 4-space indent, type hints welcome but not required
- JavaScript: var declarations (ES5 compat), 4-space indent, semicolons
- CSS: use `--ps-*` custom properties from `DESIGN.md`, no shadows, borders only

## Submitting

1. Fork the repo and create a feature branch
2. Make your changes with clear commit messages
3. Test with real photo files (the scripts modify metadata — verify with `exiftool`)
4. Open a pull request with a description of what changed and why

## Reporting Issues

See [SECURITY.md](SECURITY.md) for security vulnerability reporting. For bugs and feature requests, use [GitHub Issues](https://github.com/igoros777/photoshell/issues).
