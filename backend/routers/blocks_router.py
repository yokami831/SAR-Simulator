"""Block registry API endpoints (/api/blocks).

Block definition listing by category.
"""

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from backend import block_registry

router = APIRouter(tags=["blocks"])


@router.get("/api/blocks")
async def get_blocks() -> JSONResponse:
    categories = block_registry.get_blocks_by_category()
    return JSONResponse(content={"categories": categories})
