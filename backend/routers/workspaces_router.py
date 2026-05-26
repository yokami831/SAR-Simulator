"""Workspace API endpoints (/api/workspaces/*).

CRUD operations for workspace management.
"""

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from backend import workspace_manager
from backend.utils import require_keys as _require_keys

router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])


@router.get("")
async def list_workspaces() -> JSONResponse:
    result = workspace_manager.list_workspaces_with_folders()
    return JSONResponse(content=result)


@router.post("")
async def create_workspace(req: dict) -> JSONResponse:
    _require_keys(req, "title")
    try:
        result = workspace_manager.create_workspace(
            workspace_type=req.get("type", "flow"),
            title=req["title"],
            description=req.get("description", ""),
            folder=req.get("folder", ""),
        )
        return JSONResponse(content=result)
    except ValueError as e:
        # Duplicate workspace name -> 409 Conflict
        status = 409 if "already exists" in str(e) else 400
        raise HTTPException(status, str(e))
    except OSError as e:
        raise HTTPException(500, f"File I/O error: {e}")


@router.get("/{filename:path}")
async def load_workspace(filename: str) -> JSONResponse:
    try:
        result = workspace_manager.load_workspace(filename)
        return JSONResponse(content=result)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.put("/{filename:path}")
async def save_workspace(filename: str, req: dict) -> JSONResponse:
    try:
        result = workspace_manager.save_workspace(filename, req)
        return JSONResponse(content=result)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@router.delete("/{filename:path}")
async def delete_workspace(filename: str) -> JSONResponse:
    try:
        result = workspace_manager.delete_workspace(filename)
        return JSONResponse(content=result)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@router.patch("/{filename:path}")
async def rename_workspace(filename: str, req: dict) -> JSONResponse:
    _require_keys(req, "title")
    try:
        result = workspace_manager.rename_workspace(filename, req["title"], req.get("description"))
        return JSONResponse(content=result)
    except (FileNotFoundError, ValueError) as e:
        status = 404 if isinstance(e, FileNotFoundError) else 400
        raise HTTPException(status, str(e))


@router.post("-move")
async def move_workspace(req: dict) -> JSONResponse:
    """Move a workspace file to a different folder."""
    _require_keys(req, "filename")
    try:
        result = workspace_manager.move_workspace(
            req["filename"], req.get("targetFolder", ""),
        )
        return JSONResponse(content=result)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.post("-folder")
async def create_folder(req: dict) -> JSONResponse:
    """Create a new empty folder in the workspace directory."""
    _require_keys(req, "name")
    try:
        result = workspace_manager.create_folder(req["name"])
        return JSONResponse(content=result)
    except ValueError as e:
        status = 409 if "already exists" in str(e) else 400
        raise HTTPException(status, str(e))
