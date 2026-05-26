"""Workspace file management for HiyoCanvas.

Each workspace is a single JSON file under get_workspaces_dir():
  - *.rcflow        — flow workspaces
  - *.rcmind        — mindmap workspaces
  - *.rcexcalidraw  — excalidraw drawing workspaces
  - *.rcnotes       — notes workspaces (multi-page BlockNote documents)

Some workspace types have companion asset folders:
  - notes: <Title>_rcnotes/ for pasted/uploaded images
"""

from __future__ import annotations

import json
import logging
import shutil
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from backend.config import get_workspaces_dir

logger = logging.getLogger(__name__)

# Characters not allowed in Windows filenames (used for title validation)
_INVALID_FILENAME_CHARS = set(':\\/*?"<>|')


def _validate_title(title: str) -> None:
    """Raise ValueError if title contains characters invalid for filenames."""
    invalid = _INVALID_FILENAME_CHARS & set(title)
    if invalid:
        chars = " ".join(sorted(invalid))
        raise ValueError(
            f"Title contains characters not allowed in filenames: {chars}"
        )


EXT_MAP: dict[str, str] = {"flow": ".rcflow"}
ALL_EXTS: set[str] = {".rcflow"}

# Initial data factories for each workspace type
_INITIAL_DATA_FACTORIES: dict[str, Callable[[str], dict]] = {}


def register_workspace_type(
    type_id: str,
    ext: str,
    initial_data_factory: Callable[[str], dict] | None = None,
) -> None:
    """Register a workspace type with its file extension and optional initial data factory."""
    EXT_MAP[type_id] = ext
    ALL_EXTS.add(ext)
    if initial_data_factory:
        _INITIAL_DATA_FACTORIES[type_id] = initial_data_factory


def _mindmap_initial_data(title: str) -> dict:
    return {
        "mindmapData": {
            "nodeData": {
                "id": "root",
                "topic": title.strip(),
                "root": True,
                "children": [],
            }
        }
    }


register_workspace_type("mindmap", ".rcmind", _mindmap_initial_data)


def _excalidraw_initial_data(title: str) -> dict:
    return {"excalidrawData": {"elements": []}}


register_workspace_type("excalidraw", ".rcexcalidraw", _excalidraw_initial_data)


def _notes_initial_data(title: str) -> dict:
    return {
        "notesData": {
            "pages": [],
            "content": {},
            "activePageId": None,
        }
    }


register_workspace_type("notes", ".rcnotes", _notes_initial_data)


def _files_initial_data(title: str) -> dict:
    return {"filesData": {"rootFolders": [], "history": []}}


register_workspace_type("files", ".rcfiles", _files_initial_data)


# Workspace types that have companion asset folders: type_id -> folder suffix
_ASSET_FOLDER_SUFFIXES: dict[str, str] = {
    "notes": "_materials",
}


def _get_asset_folder(filepath: Path, ws_type: str) -> Path | None:
    """Return the companion asset folder path for a workspace file, or None."""
    suffix = _ASSET_FOLDER_SUFFIXES.get(ws_type)
    if not suffix:
        return None
    return filepath.parent / (filepath.stem + suffix)


def _ensure_dir() -> None:
    """Create workspaces root directory if it doesn't exist."""
    get_workspaces_dir().mkdir(parents=True, exist_ok=True)


def _safe_path(filename: str) -> Path:
    """Resolve filename under workspaces dir and verify it stays within bounds.

    Raises:
        ValueError: If the resolved path escapes the workspaces directory.
    """
    ws_dir = get_workspaces_dir()
    resolved = (ws_dir / filename).resolve()
    if not resolved.is_relative_to(ws_dir.resolve()):
        raise ValueError(f"Invalid filename: {filename}")
    return resolved


def _read_workspace_metadata(f: Path, rel_prefix: str = "") -> dict | None:
    """Read workspace file metadata. Returns dict or None on error."""
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Failed to read %s: %s", f, e)
        return None
    filename = (rel_prefix + "/" + f.name) if rel_prefix else f.name
    return {
        "filename": filename,
        "type": data.get("type", "flow"),
        "title": data.get("title", f.stem),
        "created": data.get("created", ""),
        "modified": data.get("modified", ""),
        "description": data.get("description", ""),
        "path": str(f),
    }


def list_workspaces() -> list[dict]:
    """Return metadata for all workspaces, sorted by modified date (newest first)."""
    _ensure_dir()
    result = []
    for f in get_workspaces_dir().iterdir():
        if not f.is_file() or f.suffix not in ALL_EXTS:
            continue
        meta = _read_workspace_metadata(f)
        if meta:
            result.append(meta)
    result.sort(key=lambda w: w.get("modified", ""), reverse=True)
    return result


def list_workspaces_with_folders() -> dict:
    """Return workspaces grouped by folder (1-level deep subdirectories).

    Returns:
        {
            "workspaces": [...],  # all files flat (backward compat)
            "rootFiles": [...],   # files in workspace root
            "folders": [{"name": str, "files": [...]}, ...]  # subdirectories
        }
    """
    _ensure_dir()
    ws_dir = get_workspaces_dir()
    root_files: list[dict] = []
    folders: list[dict] = []
    all_flat: list[dict] = []

    for entry in sorted(ws_dir.iterdir(), key=lambda p: p.name.lower()):
        if entry.is_file() and entry.suffix in ALL_EXTS:
            meta = _read_workspace_metadata(entry)
            if meta:
                root_files.append(meta)
                all_flat.append(meta)
        elif entry.is_dir() and not entry.name.startswith(".") and not entry.name.endswith("_materials"):
            folder_files: list[dict] = []
            for f in sorted(entry.iterdir(), key=lambda p: p.name.lower()):
                if f.is_file() and f.suffix in ALL_EXTS:
                    meta = _read_workspace_metadata(f, rel_prefix=entry.name)
                    if meta:
                        folder_files.append(meta)
                        all_flat.append(meta)
            # Include folder even if empty (so it appears in bookmark bar)
            folders.append({"name": entry.name, "files": folder_files})

    root_files.sort(key=lambda w: w.get("modified", ""), reverse=True)
    all_flat.sort(key=lambda w: w.get("modified", ""), reverse=True)
    return {"workspaces": all_flat, "rootFiles": root_files, "folders": folders}


def create_workspace(workspace_type: str, title: str, description: str = "", folder: str = "") -> dict:
    """Create a new workspace file.

    Args:
        workspace_type: Workspace type id (e.g. "flow", "mindmap").
        title: Display name (also used as filename stem).
        description: Optional description.
        folder: Optional subfolder name (e.g. "MyProject"). Created if absent.

    Returns:
        Workspace metadata dict.

    Raises:
        ValueError: If title is empty or file already exists.
    """
    if not title.strip():
        raise ValueError("Workspace title cannot be empty")
    _validate_title(title.strip())

    _ensure_dir()

    ext = EXT_MAP.get(workspace_type, ".rcflow")
    bare_filename = title.strip() + ext
    if folder:
        filename = folder.strip() + "/" + bare_filename
    else:
        filename = bare_filename
    filepath = _safe_path(filename)
    # Ensure parent directory exists (for subfolder creation)
    filepath.parent.mkdir(parents=True, exist_ok=True)

    if filepath.exists():
        raise ValueError(f"Workspace '{filename}' already exists. Please choose a different name.")

    now = datetime.now(timezone.utc).isoformat()
    ws_data: dict = {
        "version": 1,
        "type": workspace_type,
        "title": title.strip(),
        "description": description,
        "created": now,
        "modified": now,
    }
    factory = _INITIAL_DATA_FACTORIES.get(workspace_type)
    if factory:
        ws_data.update(factory(title))
    else:
        ws_data["canvas"] = {
            "nodes": [],
            "edges": [],
            "viewport": {"x": 0, "y": 0, "zoom": 1},
        }

    filepath.write_text(json.dumps(ws_data, indent=2, ensure_ascii=False), encoding="utf-8")

    logger.info("Created workspace: %s -> %s", title, filepath)
    return {
        "filename": filename,
        "type": workspace_type,
        "title": title.strip(),
        "created": now,
        "modified": now,
        "path": str(filepath),
    }


def load_workspace(filename: str) -> dict:
    """Load a workspace's full data.

    Raises:
        FileNotFoundError: If workspace file doesn't exist.
        ValueError: If file is invalid JSON.
    """
    filepath = _safe_path(filename)
    if not filepath.exists():
        raise FileNotFoundError(f"Workspace not found: {filename}")

    try:
        data = json.loads(filepath.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid workspace file: {filename} ({e})")

    data["filename"] = filename
    data["path"] = str(filepath)
    return data


def save_workspace(filename: str, data: dict) -> dict:
    """Save canvas state and update modified timestamp.

    Args:
        filename: Workspace filename (e.g. "my-flow.rcflow").
        data: Dict with canvas/mindmapData/title/description keys to merge.

    Returns:
        {"success": True, "modified": ISO timestamp}

    Raises:
        FileNotFoundError: If workspace file doesn't exist.
    """
    filepath = _safe_path(filename)
    if not filepath.exists():
        raise FileNotFoundError(f"Workspace not found: {filename}")

    try:
        existing = json.loads(filepath.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        existing = {}

    now = datetime.now(timezone.utc).isoformat()
    existing["modified"] = now

    _META_KEYS = {"title", "description", "created", "modified", "version", "type", "filename", "path"}
    if "canvas" in data:
        existing["canvas"] = data["canvas"]
    if "subgraphStore" in data:
        existing["subgraphStore"] = data["subgraphStore"]
    if "title" in data:
        existing["title"] = data["title"]
    if "description" in data:
        existing["description"] = data["description"]
    # Pass through any plugin data keys (e.g. mindmapData)
    for key, value in data.items():
        if key not in _META_KEYS and key not in ("canvas", "subgraphStore", "title", "description"):
            existing[key] = value

    filepath.write_text(json.dumps(existing, indent=2, ensure_ascii=False), encoding="utf-8")
    logger.info("Saved workspace: %s", filename)
    return {"success": True, "modified": now}


def delete_workspace(filename: str) -> dict:
    """Delete a workspace file and its companion asset folder (if any).

    Raises:
        FileNotFoundError: If workspace file doesn't exist.
    """
    filepath = _safe_path(filename)
    if not filepath.exists():
        raise FileNotFoundError(f"Workspace not found: {filename}")

    # Determine workspace type to check for companion folder
    try:
        data = json.loads(filepath.read_text(encoding="utf-8"))
        ws_type = data.get("type", "flow")
    except (json.JSONDecodeError, OSError):
        ws_type = "flow"

    # Delete companion asset folder if it exists
    asset_folder = _get_asset_folder(filepath, ws_type)
    if asset_folder and asset_folder.is_dir():
        shutil.rmtree(asset_folder)
        logger.info("Deleted asset folder: %s", asset_folder)

    filepath.unlink()
    logger.info("Deleted workspace: %s", filename)
    return {"success": True, "filename": filename}


def rename_workspace(filename: str, new_title: str, description: str | None = None) -> dict:
    """Update workspace title, optionally description, and rename the file.

    Raises:
        FileNotFoundError: If workspace file doesn't exist.
        ValueError: If new title is empty or target file already exists.
    """
    if not new_title.strip():
        raise ValueError("Title cannot be empty")
    _validate_title(new_title.strip())

    filepath = _safe_path(filename)
    if not filepath.exists():
        raise FileNotFoundError(f"Workspace not found: {filename}")

    try:
        data = json.loads(filepath.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        data = {}

    data["title"] = new_title.strip()
    if description is not None:
        data["description"] = description.strip()
    data["modified"] = datetime.now(timezone.utc).isoformat()

    # Determine new filename (preserve subfolder prefix if present)
    ext = filepath.suffix
    # filename may be "subfolder/old-name.ext" — keep the prefix
    if "/" in filename:
        folder_prefix = filename.rsplit("/", 1)[0]
        new_filename = folder_prefix + "/" + new_title.strip() + ext
    else:
        new_filename = new_title.strip() + ext
    new_filepath = _safe_path(new_filename)

    if new_filename != filename and new_filepath.exists():
        raise ValueError(f"Workspace '{new_filename}' already exists. Please choose a different name.")

    # Write data to new path (or same path if name unchanged)
    new_filepath.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    # Remove old file if renamed
    if new_filename != filename:
        filepath.unlink()

        # Rename companion asset folder if it exists
        ws_type = data.get("type", "flow")
        old_asset = _get_asset_folder(filepath, ws_type)
        new_asset = _get_asset_folder(new_filepath, ws_type)
        if old_asset and new_asset and old_asset.is_dir():
            old_asset.rename(new_asset)
            logger.info("Renamed asset folder: %s -> %s", old_asset, new_asset)

    logger.info("Renamed workspace %s -> %s", filename, new_title)
    return {
        "success": True,
        "filename": new_filename,
        "title": new_title.strip(),
        "description": data.get("description", ""),
        "modified": data["modified"],
    }


def move_workspace(filename: str, target_folder: str) -> dict:
    """Move a workspace file to a different folder (or root).

    Args:
        filename: Current filename (e.g. "my-flow.rcflow" or "old-folder/my-flow.rcflow").
        target_folder: Target folder name, or "" for workspace root.

    Returns:
        {"success": True, "filename": new_filename}

    Raises:
        FileNotFoundError: If workspace file doesn't exist.
        ValueError: If target already exists.
    """
    filepath = _safe_path(filename)
    if not filepath.exists():
        raise FileNotFoundError(f"Workspace not found: {filename}")

    bare_name = filepath.name
    if target_folder:
        new_filename = target_folder.strip() + "/" + bare_name
    else:
        new_filename = bare_name
    new_filepath = _safe_path(new_filename)

    if new_filepath == filepath:
        return {"success": True, "filename": filename}

    if new_filepath.exists():
        raise ValueError(f"File '{bare_name}' already exists in target folder")

    new_filepath.parent.mkdir(parents=True, exist_ok=True)
    filepath.rename(new_filepath)

    # Move companion asset folder if it exists
    try:
        data = json.loads(new_filepath.read_text(encoding="utf-8"))
        ws_type = data.get("type", "flow")
    except (json.JSONDecodeError, OSError):
        ws_type = "flow"
    old_asset = _get_asset_folder(filepath, ws_type)
    new_asset = _get_asset_folder(new_filepath, ws_type)
    if old_asset and new_asset and old_asset.is_dir():
        new_asset.parent.mkdir(parents=True, exist_ok=True)
        old_asset.rename(new_asset)

    # Clean up empty source folder
    old_dir = filepath.parent
    ws_dir = get_workspaces_dir()
    if old_dir != ws_dir and old_dir.is_dir() and not any(old_dir.iterdir()):
        old_dir.rmdir()

    logger.info("Moved workspace %s -> %s", filename, new_filename)
    return {"success": True, "filename": new_filename}


def create_folder(name: str) -> dict:
    """Create a new empty folder in the workspace directory.

    Raises:
        ValueError: If name is empty or folder already exists.
    """
    if not name.strip():
        raise ValueError("Folder name cannot be empty")
    _validate_title(name.strip())
    _ensure_dir()

    folder_path = get_workspaces_dir() / name.strip()
    if folder_path.exists():
        raise ValueError(f"Folder '{name.strip()}' already exists")

    folder_path.mkdir(parents=True)
    logger.info("Created folder: %s", folder_path)
    return {"success": True, "name": name.strip()}


# ---------------------------------------------------------------------------
# Migration: folder-based → single-file
# ---------------------------------------------------------------------------


def _migrate_folders_to_files() -> None:
    """Convert old folder-based workspaces to single files. Run once at import."""
    _ensure_dir()
    marker = get_workspaces_dir() / ".migration_done"
    if marker.exists():
        return
    # Early exit if no subdirectories exist (nothing to migrate)
    if not any(p.is_dir() for p in get_workspaces_dir().iterdir()):
        marker.touch()
        return
    for folder in list(get_workspaces_dir().iterdir()):
        if not folder.is_dir():
            continue
        ws_file = folder / "workspace.json"
        if not ws_file.exists():
            continue
        try:
            data = json.loads(ws_file.read_text(encoding="utf-8"))
            ws_type = data.get("type", "flow")
            title = data.get("title", folder.name)
            ext = EXT_MAP.get(ws_type, ".rcflow")
            target = get_workspaces_dir() / f"{title}{ext}"
            # Avoid overwriting
            if target.exists():
                target = get_workspaces_dir() / f"{title} ({folder.name}){ext}"
            target.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
            # Remove folder if only workspace.json + empty subdirs
            has_extra = any(
                f.name != "workspace.json"
                for f in folder.rglob("*")
                if f.is_file()
            )
            if not has_extra:
                shutil.rmtree(folder)
            else:
                logger.warning("Migrated %s but folder has extra files, keeping folder", folder.name)
        except Exception as e:
            logger.error("Failed to migrate workspace folder %s: %s", folder.name, e)
    marker.touch()


_migrate_folders_to_files()
