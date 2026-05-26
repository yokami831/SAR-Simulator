"""Block definition registry for HiyoCanvas.

3-tier loading system:
  1. _builtin/   - HiyoCanvas core blocks (python_code, gui_*, etc.)
  2. user/       - Plugin-provided global library blocks (csv_reader, etc.)
  3. workspace/  - <workspaces_dir>/blocks/*.json (workspace-scoped)

Load order: builtin -> plugin_user -> workspace. Same id: later wins + WARNING.
Plugins register their block directories via register_plugin_block_dir().
Active workspace blocks dir is set via set_workspace_blocks_dir().
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# Plugin-provided block directories (each contains _builtin/ + user/ subdirs)
_plugin_dirs: list[Path] = []

# Currently-active workspace blocks dir (flat *.json layout). At most one.
_workspace_dir: Path | None = None

# In-memory cache: block_id -> definition dict.
# Each entry has internal meta: _source ("builtin"|"plugin_user"|"workspace"), _origin (path str).
_cache: dict[str, dict] = {}

# Category prefixes to exclude (set by feature flags at startup)
_excluded_category_prefixes: list[str] = []

# Back-compat alias for tests/code that referenced the old name.
_block_dirs = _plugin_dirs


def set_excluded_categories(prefixes: list[str]) -> None:
    """Set category prefixes to exclude from API responses."""
    global _excluded_category_prefixes
    _excluded_category_prefixes = [p.lower() for p in prefixes]
    logger.info("Block categories excluded: %s", prefixes)


def _is_excluded(block: dict) -> bool:
    """Check if a block should be excluded based on its category."""
    if not _excluded_category_prefixes:
        return False
    cat = block.get("category", "").lower()
    return any(cat.startswith(prefix) for prefix in _excluded_category_prefixes)


def register_plugin_block_dir(directory: Path) -> None:
    """Register a plugin-provided block directory.

    The directory should contain _builtin/ and/or user/ subdirectories.
    Called once at startup by each plugin.
    """
    if directory in _plugin_dirs:
        return
    _plugin_dirs.append(directory)
    (directory / "_builtin").mkdir(parents=True, exist_ok=True)
    (directory / "user").mkdir(parents=True, exist_ok=True)
    _reload_all()
    logger.info("Plugin block directory registered: %s (%d blocks total)", directory, len(_cache))


def register_block_dir(directory: Path) -> None:
    """Deprecated: use register_plugin_block_dir()."""
    register_plugin_block_dir(directory)


def set_workspace_blocks_dir(path: Path | None) -> None:
    """Set the active workspace's blocks/ directory (flat *.json layout).

    Pass None to clear the workspace layer. The full cache is rebuilt so that
    block ids previously sourced from the old workspace dir are removed.
    """
    global _workspace_dir
    _workspace_dir = path
    _reload_all()
    n_ws = sum(1 for b in _cache.values() if b.get("_source") == "workspace")
    logger.info("Workspace blocks dir set: %s (%d workspace blocks, %d total)",
                path, n_ws, len(_cache))


def get_workspace_blocks_dir() -> Path | None:
    """Return the current workspace blocks dir, or None if unset."""
    return _workspace_dir


def _reload_all() -> None:
    """Reload all blocks from the 3 tiers in strict order.

    Order: 1) plugin _builtin/, 2) plugin user/, 3) workspace flat *.json
    Same-id collisions: later wins + WARNING log.
    """
    _cache.clear()
    for d in _plugin_dirs:
        for block in _load_from_dir(d / "_builtin"):
            _put(block, source="builtin", origin=d / "_builtin")
    for d in _plugin_dirs:
        for block in _load_from_dir(d / "user"):
            _put(block, source="plugin_user", origin=d / "user")
    if _workspace_dir is not None and _workspace_dir.is_dir():
        for block in _load_from_dir(_workspace_dir):
            _put(block, source="workspace", origin=_workspace_dir)


def _put(block: dict, *, source: str, origin: Path) -> None:
    """Insert block into cache, logging collisions."""
    bid = block.get("id")
    if not bid:
        logger.warning("Skipping block without 'id' from %s", origin)
        return
    if bid in _cache:
        prev = _cache[bid]
        logger.warning(
            "Block id collision: '%s' from %s (%s) overrides %s (%s)",
            bid, source, str(origin).replace("\\", "/"),
            prev.get("_source"), str(prev.get("_origin", "?")).replace("\\", "/"),
        )
    block["_source"] = source
    block["_origin"] = str(origin)
    _cache[bid] = block


def _load_from_dir(directory: Path) -> list[dict]:
    """Load all JSON block definitions from a directory (non-recursive)."""
    blocks = []
    if not directory.exists():
        return blocks
    for path in sorted(directory.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if "id" not in data:
                data["id"] = path.stem
            blocks.append(data)
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("Failed to load block definition %s: %s", path, e)
    return blocks


def reload() -> None:
    """Force reload all block definitions from disk (all 3 tiers)."""
    _reload_all()
    logger.info("Block registry reloaded: %d blocks from %d plugin dir(s) + workspace=%s",
                len(_cache), len(_plugin_dirs), _workspace_dir)


def _public_view(block: dict) -> dict:
    """Return a copy of the block with internal-only meta stripped.

    Keeps _source (UI may want to badge workspace blocks) but drops _origin
    (absolute filesystem path; not for API consumers).
    """
    return {k: v for k, v in block.items() if k != "_origin"}


def load_all() -> list[dict]:
    """Load and return all block definitions (respecting feature flags)."""
    return [_public_view(b) for b in _cache.values() if not _is_excluded(b)]


def get_block(block_id: str) -> dict | None:
    """Get a block definition by ID (with internal meta intact)."""
    return _cache.get(block_id)


def search(query: str) -> list[dict]:
    """Search blocks by keyword across id, label, category, description."""
    q = query.lower()
    results = []
    for block in _cache.values():
        if _is_excluded(block):
            continue
        if (q in block.get("id", "").lower()
                or q in block.get("label", "").lower()
                or q in block.get("category", "").lower()
                or q in block.get("description", "").lower()):
            results.append(_public_view(block))
    return results


def register(definition: dict, scope: str = "auto") -> dict:
    """Register a new block definition, saving to a JSON file.

    Args:
        definition: Block definition dict. Must have 'id' and 'label'.
        scope: Where to save the new block.
            - "auto" (default): workspace if a workspace blocks dir is active,
              otherwise the first plugin's user/ dir.
            - "workspace": force workspace dir; error if none is set.
            - "global": force plugin user/ dir (first registered plugin dir).

    Returns:
        The saved definition (public view, internal meta stripped).

    Raises:
        ValueError: If required fields are missing, scope is invalid, or
            the target directory cannot be determined.
    """
    block_id = definition.get("id")
    if not block_id:
        raise ValueError("Block definition must have an 'id' field")
    if not definition.get("label"):
        raise ValueError("Block definition must have a 'label' field")
    if scope not in ("auto", "workspace", "global"):
        raise ValueError(f"Invalid scope '{scope}'. Use 'auto', 'workspace', or 'global'.")

    definition.setdefault("category", "User")
    definition.setdefault("parameters", [])
    definition.setdefault("inputs", [])
    definition.setdefault("outputs", [])

    target_dir: Path
    source_label: str
    if scope == "workspace":
        if _workspace_dir is None:
            raise ValueError("scope='workspace' requires an active workspace blocks dir")
        target_dir = _workspace_dir
        source_label = "workspace"
    elif scope == "global":
        if not _plugin_dirs:
            raise ValueError("scope='global' requires at least one registered plugin dir")
        target_dir = _plugin_dirs[0] / "user"
        source_label = "plugin_user"
    else:  # auto
        if _workspace_dir is not None:
            target_dir = _workspace_dir
            source_label = "workspace"
        elif _plugin_dirs:
            target_dir = _plugin_dirs[0] / "user"
            source_label = "plugin_user"
        else:
            raise ValueError("No block directories available for registration")

    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / f"{block_id}.json"

    to_write = {k: v for k, v in definition.items() if not k.startswith("_")}
    path.write_text(json.dumps(to_write, indent=2, ensure_ascii=False), encoding="utf-8")

    cached = dict(to_write)
    cached["id"] = block_id
    _put(cached, source=source_label, origin=target_dir)
    logger.info("Registered block '%s' (scope=%s) -> %s", block_id, scope, path)
    return _public_view(cached)


def list_categories() -> list[str]:
    """Return sorted list of all unique category names."""
    cats = set()
    for block in _cache.values():
        if _is_excluded(block):
            continue
        cat = block.get("category", "Uncategorized")
        cats.add(cat)
    return sorted(cats)


def get_blocks_by_category() -> dict[str, dict]:
    """Return blocks organized by category for the /api/blocks endpoint.

    Returns:
        {"<Category>": {"label": "...", "blocks": [...public views...]}, ...}
    """
    categories: dict[str, list[dict]] = {}
    for block in _cache.values():
        if _is_excluded(block):
            continue
        cat = block.get("category", "Uncategorized")
        categories.setdefault(cat, []).append(_public_view(block))

    result = {}
    for cat_name, blocks in sorted(categories.items()):
        result[cat_name] = {
            "label": cat_name,
            "blocks": sorted(blocks, key=lambda b: b.get("label", "")),
        }
    return result
