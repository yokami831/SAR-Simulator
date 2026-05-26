"""Batch operations: execute multiple commands sequentially with variable substitution."""
from __future__ import annotations

import re
from typing import Any

MAX_BATCH_COMMANDS = 20


async def run_batch(commands: list[dict]) -> dict[str, Any]:
    """Execute a batch of operations sequentially. Stops on first error.

    Each command: {"operation": "add_element", "params": {...}}
    Supports $N variable substitution: $0 references result of command[0].
    For add_element results, $N expands to the node_id.
    """
    if not commands:
        return {"success": False, "message": "Error: Empty command list"}
    if len(commands) > MAX_BATCH_COMMANDS:
        return {
            "success": False,
            "message": f"Error: Too many commands ({len(commands)}, max {MAX_BATCH_COMMANDS})",
        }

    from backend import tools

    results = []
    result_vars: dict[str, str] = {}  # index -> node_id or other extractable value

    for i, cmd in enumerate(commands):
        operation = cmd.get("operation", "")
        params = cmd.get("params", {})

        # $N variable substitution in string values
        params = _substitute_vars(params, result_vars)

        # Dispatch to the appropriate function
        func = getattr(tools, operation, None)
        if func is None:
            results.append({"index": i, "success": False, "message": f"Unknown operation: {operation}"})
            break

        try:
            result = await func(**params)
        except TypeError as e:
            results.append({"index": i, "success": False, "message": f"Error: {e}"})
            break
        except Exception as e:
            results.append({"index": i, "success": False, "message": f"Error: {e}"})
            break

        results.append({"index": i, **result})

        # Extract referenceable values for $N substitution
        if result.get("node_id"):
            result_vars[str(i)] = result["node_id"]
        if result.get("edge_id"):
            result_vars[str(i)] = result["edge_id"]
        if result.get("subgraph_id"):
            result_vars[str(i)] = result["subgraph_id"]

        if not result.get("success"):
            break  # Stop on first error

    # Format summary
    succeeded = sum(1 for r in results if r.get("success"))
    total = len(results)

    lines = [f"Batch: {len(commands)} commands"]
    for r in results:
        idx = r["index"]
        msg = r.get("message", "")
        first_line = msg.split("\n")[0] if msg else ""
        op = commands[idx].get("operation", "?")
        status = "OK" if r.get("success") else "FAIL"
        lines.append(f"  [{idx}] {op} [{status}] {first_line}")

    lines.append(f"Summary: {succeeded}/{total} succeeded")

    return {
        "success": succeeded == len(commands),
        "message": "\n".join(lines),
        "results": results,
    }



def _substitute_vars(obj: Any, vars: dict[str, str]) -> Any:
    """Replace $N patterns in string values with stored results."""
    if isinstance(obj, str):
        def replacer(m: re.Match) -> str:
            idx = m.group(1)
            return vars.get(idx, m.group(0))
        return re.sub(r'\$(\d+)', replacer, obj)
    elif isinstance(obj, dict):
        return {k: _substitute_vars(v, vars) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_substitute_vars(item, vars) for item in obj]
    return obj
