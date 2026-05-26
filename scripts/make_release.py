"""HiyoCanvas release zip builder.

Usage:
    python scripts/make_release.py          # -> release/HiyoCanvas-v1.0.0.zip
    python scripts/make_release.py --dry    # list files without creating zip
"""

import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Directories to include (relative to ROOT)
INCLUDE_DIRS = [
    "backend",
    "frontend",
    "src",
    "patches",
    "assets",
    ".claude/skills",
]

# Individual files to include (relative to ROOT)
INCLUDE_FILES = [
    "package.json",
    "package-lock.json",
    "requirements.txt",
    "vite.config.js",
    "tsconfig.json",
    "start.bat",
    "app-config.json",
    "README.md",
    "CLAUDE.md",
    ".gitignore",
]

# Patterns to always exclude (matched against relative path parts)
EXCLUDE_PATTERNS = [
    "__pycache__",
    ".pyc",
    ".pyo",
    "node_modules",
    ".venv",
    "venv",
    ".pytest_cache",
    ".DS_Store",
    "Thumbs.db",
]


def should_exclude(rel_path: Path) -> bool:
    parts_str = str(rel_path)
    for pattern in EXCLUDE_PATTERNS:
        if pattern in parts_str:
            return True
    return False


def collect_files() -> list[Path]:
    """Collect all files to include in the release zip."""
    files: list[Path] = []

    # Individual files
    for f in INCLUDE_FILES:
        p = ROOT / f
        if p.is_file():
            files.append(p)
        else:
            print(f"  WARN: {f} not found, skipping")

    # Directories (recursive)
    for d in INCLUDE_DIRS:
        dir_path = ROOT / d
        if not dir_path.is_dir():
            print(f"  WARN: {d}/ not found, skipping")
            continue
        for p in dir_path.rglob("*"):
            if p.is_file() and not should_exclude(p.relative_to(ROOT)):
                files.append(p)

    return sorted(set(files))


def get_version() -> str:
    pkg = ROOT / "package.json"
    with open(pkg, encoding="utf-8") as f:
        data = json.load(f)
    return data.get("version", "0.0.0")


def make_default_config() -> dict:
    """Return a clean app-config.json for distribution."""
    return {
        "lastWorkspacesDir": "workspaces",
        "features": {"fpga": False, "rina": False},
    }


def main():
    dry_run = "--dry" in sys.argv
    version = get_version()
    zip_name = f"HiyoCanvas-v{version}.zip"
    prefix = f"HiyoCanvas-v{version}"

    print(f"HiyoCanvas Release Builder v{version}")
    print(f"{'=' * 40}")

    files = collect_files()
    print(f"Collected {len(files)} files")

    if dry_run:
        print("\n--- DRY RUN (no zip created) ---")
        for f in files:
            print(f"  {f.relative_to(ROOT)}")
        print(f"\nTotal: {len(files)} files")
        return

    # Create release directory
    release_dir = ROOT / "release"
    release_dir.mkdir(exist_ok=True)
    zip_path = release_dir / zip_name

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            rel = f.relative_to(ROOT)
            arcname = f"{prefix}/{rel}"

            # Replace app-config.json with clean default
            if rel == Path("app-config.json"):
                clean_config = json.dumps(make_default_config(), indent=2)
                zf.writestr(arcname, clean_config)
            else:
                zf.write(f, arcname)

    size_mb = zip_path.stat().st_size / (1024 * 1024)
    print(f"\nCreated: {zip_path}")
    print(f"Size: {size_mb:.1f} MB")
    print(f"Files: {len(files)}")


if __name__ == "__main__":
    main()
