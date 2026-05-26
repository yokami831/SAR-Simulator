"""Plugin manager for AI Canvas platform.

Handles plugin registration and lookup by canvas type ID.
"""

from __future__ import annotations

import logging
from backend.plugin_base import CanvasPlugin

logger = logging.getLogger(__name__)

_plugins: dict[str, CanvasPlugin] = {}


def register(plugin: CanvasPlugin) -> None:
    """Register a canvas plugin."""
    _plugins[plugin.plugin_id] = plugin
    logger.info("Plugin registered: %s (%s)", plugin.plugin_id, plugin.display_name)


def get(plugin_id: str) -> CanvasPlugin | None:
    """Get a plugin by its ID."""
    return _plugins.get(plugin_id)


def get_all() -> dict[str, CanvasPlugin]:
    """Get all registered plugins."""
    return dict(_plugins)


def get_plugin_list() -> list[dict]:
    """Get list of available plugins for tab creation UI."""
    return [
        {"id": p.plugin_id, "name": p.display_name}
        for p in _plugins.values()
    ]
