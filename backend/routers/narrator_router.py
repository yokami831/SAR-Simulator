"""Narrator API router for HiyoCanvas.

Provides endpoints to inspect the narrator event buffer,
application state, errors, and clear the buffer.
"""

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from backend.narrator import get_narrator

router = APIRouter(prefix="/api/narrator", tags=["narrator"])


@router.get("/events")
async def get_events(
    n: int = Query(default=50, ge=1, le=500),
) -> JSONResponse:
    """Return the n most recent narrator events."""
    narrator = get_narrator()
    events = narrator.recent(n)
    return JSONResponse(content={
        "events": events,
        "count": len(events),
        "total_buffered": len(narrator._buf),
    })


@router.get("/state")
async def get_state() -> JSONResponse:
    """Return the current narrator state."""
    narrator = get_narrator()
    return JSONResponse(content=narrator.get_state())


@router.get("/errors")
async def get_errors(
    n: int = Query(default=20, ge=1, le=100),
) -> JSONResponse:
    """Return the n most recent narrator errors."""
    narrator = get_narrator()
    errors = narrator.errors(n)
    return JSONResponse(content={
        "errors": errors,
        "count": len(errors),
    })


@router.post("/clear")
async def clear_narrator() -> JSONResponse:
    """Clear the narrator event buffer."""
    get_narrator().clear()
    return JSONResponse(content={"success": True, "message": "Narrator buffer cleared"})
