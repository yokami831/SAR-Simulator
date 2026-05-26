"""Shared utility functions for backend routers."""

from fastapi import HTTPException


def require_keys(req: dict, *keys: str) -> None:
    """Validate that all required keys are present in request body.

    Raises:
        HTTPException(400): If any required key is missing.
    """
    missing = [k for k in keys if k not in req]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Missing required field(s): {', '.join(missing)}",
        )
