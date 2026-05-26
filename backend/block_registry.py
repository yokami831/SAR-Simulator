"""Block definition registry for HiyoCanvas.

Manages block definitions stored as JSON files.
Provides CRUD operations and search functionality.

Plugins register their block directories via register_block_dir().
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# Registered block directories (plugins call register_block_dir)
_block_dirs: list[Path] = []

# In-memory cache: block_id -> definition dict
_cache: dict[str, dict] = {}

# Category prefixes to exclude (set by feature flags at startup)
_excluded_category_prefixes: list[str] = []


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


def _load_one_dir(directory: Path) -> None:
    """Load blocks from a single registered directory into cache."""
    builtin = directory / "_builtin"
    user = directory / "user"
    builtin.mkdir(parents=True, exist_ok=True)
    user.mkdir(parents=True, exist_ok=True)
    for block in _load_from_dir(builtin):
        _cache[block["id"]] = block
    for block in _load_from_dir(user):
        _cache[block["id"]] = block


def register_block_dir(directory: Path) -> None:
    """Register a block definition directory (called by plugins).

    The directory should contain _builtin/ and/or user/ subdirectories.
    """
    _block_dirs.append(directory)
    _load_one_dir(directory)
    logger.info("Block directory registered: %s (%d blocks total)", directory, len(_cache))


def _load_from_dir(directory: Path) -> list[dict]:
    """Load all JSON block definitions from a directory."""
    blocks = []
    if not directory.exists():
        return blocks
    for path in sorted(directory.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            # Ensure id matches filename
            if "id" not in data:
                data["id"] = path.stem
            blocks.append(data)
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("Failed to load block definition %s: %s", path, e)
    return blocks


def reload() -> None:
    """Force reload all block definitions from disk."""
    _cache.clear()
    for d in _block_dirs:
        _load_one_dir(d)
    logger.info("Block registry reloaded: %d blocks from %d directories", len(_cache), len(_block_dirs))


def load_all() -> list[dict]:
    """Load and return all block definitions (respecting feature flags)."""
    return [b for b in _cache.values() if not _is_excluded(b)]


def get_block(block_id: str) -> dict | None:
    """Get a block definition by ID."""

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
            results.append(block)
    return results


def register(definition: dict) -> dict:
    """Register a new block definition, saving to the first registered dir's user/.

    Args:
        definition: Block definition dict. Must have 'id' and 'label'.

    Returns:
        The saved definition.

    Raises:
        ValueError: If required fields are missing or no block dirs registered.
    """
    block_id = definition.get("id")
    if not block_id:
        raise ValueError("Block definition must have an 'id' field")
    if not definition.get("label"):
        raise ValueError("Block definition must have a 'label' field")
    if not _block_dirs:
        raise ValueError("No block directories registered")

    # Set defaults
    definition.setdefault("category", "User")
    definition.setdefault("parameters", [])
    definition.setdefault("inputs", [])
    definition.setdefault("outputs", [])

    # Save to first registered directory's user/
    user_dir = _block_dirs[0] / "user"
    user_dir.mkdir(parents=True, exist_ok=True)
    path = user_dir / f"{block_id}.json"
    path.write_text(json.dumps(definition, indent=2, ensure_ascii=False), encoding="utf-8")

    # Update cache
    _cache[block_id] = definition
    logger.info("Registered block: %s -> %s", block_id, path)
    return definition


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
        {"categories": {"General": {"label": "General", "blocks": [...]}, ...}}
    """

    categories: dict[str, list[dict]] = {}
    for block in _cache.values():
        if _is_excluded(block):
            continue
        cat = block.get("category", "Uncategorized")
        if cat not in categories:
            categories[cat] = []
        categories[cat].append(block)

    result = {}
    for cat_name, blocks in sorted(categories.items()):
        result[cat_name] = {
            "label": cat_name,
            "blocks": sorted(blocks, key=lambda b: b.get("label", "")),
        }
    return result
