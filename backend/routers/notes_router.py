"""Notes API endpoints (/api/notes/*).

Image upload and serving for notes workspaces.
Note content is saved/loaded through the standard workspace API.
"""

import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse, JSONResponse

from backend.config import get_workspaces_dir

router = APIRouter(prefix="/api/notes", tags=["notes"])


def _asset_folder(workspace_name: str) -> Path:
    """Get the asset folder path for a notes workspace.

    workspace_name is the workspace filename stem (without extension).
    Assets are stored in <workspaces_dir>/<name>_rcnotes/
    """
    return get_workspaces_dir() / f"{workspace_name}_materials"


@router.post("/upload")
async def upload_image(
    file: UploadFile = File(...),
    workspace: str = Form(...),
) -> JSONResponse:
    """Upload an image file for a notes workspace.

    Args:
        file: The image file (multipart upload).
        workspace: The workspace filename (e.g. "MyNotes.rcnotes").

    Returns:
        {"url": "/api/notes/assets/<stem>/<image_filename>"}
    """
    if not file.filename:
        raise HTTPException(400, "No filename provided")

    # Derive workspace stem from filename
    ws_path = Path(workspace)
    ws_stem = ws_path.stem  # "MyNotes" from "MyNotes.rcnotes"

    # Determine file extension
    original_ext = Path(file.filename).suffix.lower()
    if original_ext not in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"}:
        raise HTTPException(400, f"Unsupported image type: {original_ext}")

    # Create asset folder
    folder = _asset_folder(ws_stem)
    folder.mkdir(parents=True, exist_ok=True)

    # Generate unique filename
    image_filename = f"img_{uuid.uuid4().hex[:12]}{original_ext}"
    image_path = folder / image_filename

    # Save file
    content = await file.read()
    image_path.write_bytes(content)

    # Return URL that can be served by the GET endpoint
    url = f"/api/notes/assets/{ws_stem}/{image_filename}"
    return JSONResponse(content={"url": url})


@router.get("/assets/{workspace_name}/{image_filename}")
async def serve_image(workspace_name: str, image_filename: str) -> FileResponse:
    """Serve an image file from a notes workspace's asset folder."""
    folder = _asset_folder(workspace_name)
    image_path = folder / image_filename

    if not image_path.exists():
        raise HTTPException(404, f"Image not found: {image_filename}")

    # Security: ensure path doesn't escape asset folder
    if not image_path.resolve().is_relative_to(folder.resolve()):
        raise HTTPException(400, "Invalid image path")

    return FileResponse(image_path)
