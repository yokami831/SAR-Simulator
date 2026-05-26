"""Workspace operations."""
from __future__ import annotations
import logging
from typing import Any

logger = logging.getLogger(__name__)
from backend.tools.ws import send_command
from backend import workspace_manager
from backend.config import get_workspaces_dir


async def open_tab(title: str | None = None, filename: str | None = None, workspace_type: str = "flow") -> dict[str, Any]:
    """Open a workspace tab. Provide filename to open existing, or title to create new.

    If only title is given, check if a workspace with that title already exists
    (for the given type) and open it by filename. Otherwise create a new one.
    """
    if title is None and filename is None:
        return {"success": False, "message": "Must provide at least one of: title, filename"}

    if filename is not None:
        result = await send_command({"action": "open_flow_tab", "workspace_file": filename})
    else:
        # Check if a workspace with this title already exists
        ext = workspace_manager.EXT_MAP.get(workspace_type, ".rcflow")
        existing_filename = title.strip() + ext
        existing_path = get_workspaces_dir() / existing_filename
        if existing_path.exists():
            # Open existing workspace by filename
            result = await send_command({"action": "open_flow_tab", "workspace_file": existing_filename})
        else:
            result = await send_command({"action": "open_flow_tab", "title": title, "type": workspace_type})

    if not result.get("success"):
        return {"success": False, "message": result.get("message", "Failed to open workspace")}

    tab_id = result.get("tab_id", "")
    display_title = result.get("title") or title or filename or ""
    workspace_file = result.get("workspace_file") or filename or ""
    return {
        "success": True,
        "message": f"Opened: {display_title} (tab: {tab_id})",
        "tab_id": tab_id,
        "workspace_file": workspace_file,
    }


async def close_tab(tab_id: str) -> dict[str, Any]:
    """Close a workspace tab by tab ID."""
    result = await send_command({"action": "close_tab", "tab_id": tab_id})
    if not result.get("success"):
        return {"success": False, "message": result.get("message", f"Failed to close tab: {tab_id}")}
    return {"success": True, "message": f"Closed: {tab_id}"}


async def switch_tab(tab_id: str) -> dict[str, Any]:
    """Switch to a workspace tab by tab ID."""
    result = await send_command({"action": "switch_tab", "tab_id": tab_id})
    if not result.get("success"):
        return {"success": False, "message": result.get("message", f"Failed to switch to tab: {tab_id}")}
    display_title = result.get("title", tab_id)
    return {"success": True, "message": f"Switched to: {display_title} (tab: {tab_id})"}


async def get_tabs() -> dict[str, Any]:
    """Get all currently open workspace tabs."""
    result = await send_command({"action": "list_tabs"})
    if not result.get("success"):
        return {"success": False, "message": result.get("message", "Failed to list tabs")}

    tabs = result.get("tabs", [])
    if not tabs:
        return {"success": True, "message": "Open workspaces (0): (none)"}

    lines = [f"Open workspaces ({len(tabs)}):"]
    for tab in tabs:
        tab_id = tab.get("id", "")
        tab_type = tab.get("type", "")
        tab_title = tab.get("title", "")
        active_marker = " *" if tab.get("active") else ""
        lines.append(f"  {tab_id}: {tab_title} ({tab_type}){active_marker}")

    return {"success": True, "message": "\n".join(lines)}


async def list_saved() -> dict[str, Any]:
    """List all saved workspaces on disk."""
    workspaces = workspace_manager.list_workspaces()
    if not workspaces:
        return {"success": True, "message": "Saved workspaces (0): (none)"}

    lines = [f"Saved workspaces ({len(workspaces)}):"]
    for ws in workspaces:
        filename = ws.get("filename", "")
        title = ws.get("title", "")
        ws_type = ws.get("type", "")
        lines.append(f"  {filename}: {title} ({ws_type})")

    return {"success": True, "message": "\n".join(lines)}


async def delete_tab(filename: str) -> dict[str, Any]:
    """Delete a saved workspace from disk by filename."""
    try:
        result = workspace_manager.delete_workspace(filename)
    except (FileNotFoundError, ValueError) as e:
        return {"success": False, "message": f"Failed to delete: {e}"}
    if not result.get("success"):
        return {"success": False, "message": result.get("message", f"Failed to delete workspace: {filename}")}
    return {"success": True, "message": f"Deleted: {filename}"}


async def rename_tab(filename: str, new_title: str) -> dict[str, Any]:
    """Rename a saved workspace by filename."""
    try:
        result = workspace_manager.rename_workspace(filename, new_title)
    except (FileNotFoundError, ValueError) as e:
        return {"success": False, "message": f"Failed to rename: {e}"}
    if not result.get("success"):
        return {"success": False, "message": result.get("message", f"Failed to rename workspace: {filename}")}
    new_filename = result.get("filename", filename)
    # Update runtime tab title in frontend
    try:
        await send_command({"action": "rename_tab", "workspace_file": filename, "new_workspace_file": new_filename, "title": new_title})
    except Exception as e:
        logger.warning("rename_tab command failed: %s (disk rename succeeded but UI tab title may be stale)", e)
    return {"success": True, "message": f"Renamed: {filename} \u2192 {new_title}", "filename": new_filename}
