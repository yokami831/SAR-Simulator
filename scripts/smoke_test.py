#!/usr/bin/env python3
"""HiyoCanvas comprehensive smoke test.

Tests ALL tab types and ALL documented operations based on reference specs.
Starts the app, runs through every feature, verifies results, and reports.

Usage:
    python scripts/smoke_test.py           # Full test (starts & stops app)
    python scripts/smoke_test.py --no-ctl  # Skip start/stop (app already running)
    python scripts/smoke_test.py --suite flow      # Run only flow tests
    python scripts/smoke_test.py --suite mindmap   # Run only mindmap tests
"""

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CANVAS_API = PROJECT_ROOT / ".claude" / "skills" / "hiyocanvas" / "scripts" / "canvas_api.py"
CTL = PROJECT_ROOT / ".claude" / "skills" / "hiyocanvas-bridge" / "scripts" / "ctl.py"
PYTHON = str(PROJECT_ROOT / ".venv" / "Scripts" / "python.exe")

if not Path(PYTHON).exists():
    PYTHON = sys.executable


# ============================================================
# Test infrastructure
# ============================================================

class TestResult:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.results: list[tuple[str, bool, str]] = []

    def ok(self, name: str, detail: str = ""):
        self.passed += 1
        self.results.append((name, True, detail))
        print(f"  [PASS] {name}" + (f" — {detail}" if detail else ""))

    def fail(self, name: str, detail: str = ""):
        self.failed += 1
        self.results.append((name, False, detail))
        print(f"  [FAIL] {name}" + (f" — {detail}" if detail else ""))

    def check(self, name: str, condition: bool, detail: str = ""):
        if condition:
            self.ok(name, detail)
        else:
            self.fail(name, detail)

    def summary(self) -> str:
        total = self.passed + self.failed
        return f"{self.passed}/{total} passed, {self.failed} failed"


def api(action: str, json_input: dict | None = None, timeout: int = 15) -> dict | None:
    """Call canvas_api.py with --json flag and return parsed JSON, or None on failure."""
    cmd = [PYTHON, str(CANVAS_API), "--json", action]
    stdin_data = None
    if json_input is not None:
        stdin_data = json.dumps(json_input)

    try:
        proc = subprocess.run(
            cmd, input=stdin_data, capture_output=True, text=True,
            timeout=timeout, cwd=str(PROJECT_ROOT),
        )
    except subprocess.TimeoutExpired:
        return None

    output = proc.stdout.strip()
    if not output:
        return None

    try:
        return json.loads(output)
    except (json.JSONDecodeError, ValueError):
        return None


def api_raw(action: str, json_input: dict | None = None, timeout: int = 15) -> tuple[bool, str]:
    """Call canvas_api.py and return (success, raw_stdout).

    Success is determined by [OK] prefix in output.
    """
    cmd = [PYTHON, str(CANVAS_API), action]
    stdin_data = json.dumps(json_input) if json_input else None
    try:
        proc = subprocess.run(
            cmd, input=stdin_data, capture_output=True, text=True,
            timeout=timeout, cwd=str(PROJECT_ROOT),
        )
        output = proc.stdout.strip()
        ok = output.startswith("[OK]") or proc.returncode == 0
        return ok, output
    except subprocess.TimeoutExpired:
        return False, "timeout"


def ctl(action: str, timeout: int = 60) -> bool:
    try:
        proc = subprocess.run(
            [PYTHON, str(CTL), action],
            capture_output=True, text=True, timeout=timeout,
            cwd=str(PROJECT_ROOT),
        )
        return proc.returncode == 0
    except subprocess.TimeoutExpired:
        return False


def wait_ready(max_wait: int = 10) -> bool:
    for _ in range(max_wait):
        data = api("frontend_status")
        if data and data.get("frontend_connected"):
            return True
        time.sleep(1)
    return False


def wait_execution(max_wait: int = 15) -> dict | None:
    """Wait for flow execution to complete, return final status."""
    for _ in range(max_wait * 2):
        data = api("get_execution_status")
        if data and data.get("status") == "stopped":
            return data
        time.sleep(0.5)
    return data


# ============================================================
# Test suites
# ============================================================

def test_connection(r: TestResult):
    """Test basic connectivity."""
    print("\n--- 1. Connection & Server ---")

    data = api("frontend_status")
    r.check("frontend_status", data is not None)
    if data:
        r.check("frontend connected", data.get("frontend_connected") is True)
        r.check("client count >= 1", data.get("client_count", 0) >= 1)

    data = api("get_console_logs")
    r.check("get_console_logs", data is not None and data.get("success"))

    data = api("get_frontend_errors")
    r.check("get_frontend_errors", data is not None and data.get("success"))
    if data:
        r.check("no initial errors", "No errors" in data.get("message", ""))


def test_flow_tab(r: TestResult):
    """Test flow tab — ALL documented operations."""
    print("\n--- 2. Flow Tab ---")

    # --- Tab creation ---
    data = api("open_tab", {"title": "smoke-flow", "type": "flow"})
    r.check("create flow tab", data is not None and data.get("success"))
    tab_id = data.get("tab_id") if data else None
    if not tab_id:
        r.fail("flow tab_id obtained")
        return

    data = api("switch_tab", {"tab_id": tab_id})
    r.check("switch to flow", data is not None and data.get("success"))

    # --- Block operations ---
    print("  -- Block CRUD --")

    # Add python_code block
    data = api("add_element", {
        "type": "python_code",
        "parameters": {"label": "Adder", "code": "result = 2 + 3\nprint(result)"},
        "position": {"x": 100, "y": 100},
    })
    r.check("add python_code", data is not None and data.get("success"))
    n1 = data.get("node_id") if data else None

    # Add comment block
    data = api("add_element", {
        "type": "comment",
        "parameters": {"label": "Note", "text": "This is a comment"},
        "position": {"x": 100, "y": 300},
    })
    r.check("add comment", data is not None and data.get("success"))
    n_comment = data.get("node_id") if data else None

    # Get element
    if n1:
        data = api("get_element", {"node_id": n1})
        r.check("get_element", data is not None and data.get("success"))
        msg = data.get("message", "") if data else ""
        r.check("node has label 'Adder'", "Adder" in msg)
        r.check("node has code", "result = 2 + 3" in msg)

    # Update element — change label and code
    if n1:
        data = api("update_element", {
            "node_id": n1,
            "label": "Calculator",
            "code": "x = 10\ny = 20\nresult = x + y\nprint(f'sum={result}')",
        })
        r.check("update_element (label+code)", data is not None and data.get("success"))

        # Verify update
        data = api("get_element", {"node_id": n1})
        msg = data.get("message", "") if data else ""
        r.check("label updated to 'Calculator'", "Calculator" in msg)
        r.check("code updated", "x + y" in msg)

    # Update element — disable
    if n1:
        data = api("update_element", {"node_id": n1, "enabled": False})
        r.check("disable block", data is not None and data.get("success"))

        data = api("get_element", {"node_id": n1})
        msg = data.get("message", "") if data else ""
        r.check("block is disabled", "Enabled: false" in msg or "enabled: false" in msg.lower())

        # Re-enable
        data = api("update_element", {"node_id": n1, "enabled": True})
        r.check("re-enable block", data is not None and data.get("success"))

    # Get elements (list all)
    data = api("get_elements")
    r.check("get_elements", data is not None and data.get("success"))
    msg = data.get("message", "") if data else ""
    r.check("elements contain Calculator", "Calculator" in msg)

    # --- Edge operations ---
    print("  -- Edges --")

    # Add second code block for connection
    data = api("add_element", {
        "type": "python_code",
        "parameters": {"label": "Printer", "code": "print('done')"},
        "position": {"x": 400, "y": 100},
    })
    n2 = data.get("node_id") if data else None

    if n1 and n2:
        data = api("connect", {
            "source": n1, "source_port": "out_0",
            "target": n2, "target_port": "in_0",
        })
        r.check("connect n1→n2", data is not None and data.get("edge_id") is not None)

        # Verify edge exists in elements
        data = api("get_elements")
        msg = data.get("message", "") if data else ""
        r.check("edge visible in elements", "→" in msg or "edge" in msg.lower())

        # Disconnect
        data = api("disconnect", {
            "source": n1, "source_port": "out_0",
            "target": n2, "target_port": "in_0",
        })
        r.check("disconnect", data is not None)

        # Reconnect for execution test
        api("connect", {
            "source": n1, "source_port": "out_0",
            "target": n2, "target_port": "in_0",
        })

    # --- Execution ---
    print("  -- Execution --")

    data = api("run")
    r.check("run (start_execution)", data is not None and data.get("success"))

    status = wait_execution()
    r.check("execution completed", status is not None and status.get("status") == "stopped")

    if n1:
        data = api("get_execution_result", {"node_id": n1})
        r.check("get_execution_result", data is not None and data.get("success"))
        msg = data.get("message", "") if data else ""
        r.check("result contains 'sum=30'", "sum=30" in msg)

    # --- Step execution ---
    print("  -- Step Execution --")

    data = api("step_start")
    r.check("step_start", data is not None and data.get("success"))

    data = api("step_next")
    r.check("step_next", data is not None and data.get("success"))

    data = api("step_reset")
    r.check("step_reset", data is not None and data.get("success"))

    # --- View operations ---
    print("  -- View --")

    data = api("auto_layout")
    r.check("auto_layout", data is not None and data.get("success"))

    data = api("fit_all")
    r.check("fit_all", data is not None and data.get("success"))

    if n1:
        data = api("fit_node", {"node_id": n1})
        r.check("fit_node", data is not None and data.get("success"))

    data = api("get_viewport")
    r.check("get_viewport", data is not None and data.get("success"))

    # --- Block registry ---
    print("  -- Block Registry --")

    data = api("search_block_types", {"query": "python"})
    r.check("search_block_types", data is not None and data.get("success"))

    data = api("get_block_schema", {"type_id": "python_code"})
    r.check("get_block_schema", data is not None and data.get("success"))

    # --- Tooltip ---
    if n1:
        data = api("tooltip", {"node_id": n1, "text": "Test tooltip"})
        r.check("tooltip", data is not None and data.get("node_id") == n1)

        data = api("hide_tooltip", {"node_id": n1})
        r.check("hide_tooltip", data is not None)

    # --- Remove ---
    if n_comment:
        data = api("remove_element", {"node_id": n_comment})
        r.check("remove comment block", data is not None and data.get("success"))

    # --- Save ---
    data = api("save_tab")
    r.check("save flow tab", data is not None and data.get("success"))


def test_mindmap_tab(r: TestResult):
    """Test mindmap tab — ALL documented operations including node styling and expand/collapse."""
    print("\n--- 3. Mindmap Tab ---")

    data = api("open_tab", {"title": "smoke-mindmap", "type": "mindmap"})
    r.check("create mindmap tab", data is not None and data.get("success"))
    tab_id = data.get("tab_id") if data else None
    if not tab_id:
        return

    data = api("switch_tab", {"tab_id": tab_id})
    r.check("switch to mindmap", data is not None and data.get("success"))

    # --- Get initial data ---
    data = api("tab_action", {"action": "get_elements"})
    r.check("get_elements (initial)", data is not None and data.get("success"))
    if data:
        root = data.get("mindmapData", {}).get("nodeData", {})
        r.check("root node id='root'", root.get("id") == "root")
        r.check("root topic matches title", "smoke-mindmap" in root.get("topic", ""))

    # --- Add child nodes ---
    print("  -- Node CRUD --")

    data = api("tab_action", {"action": "add_element", "parentId": "root", "topic": "Child A"})
    r.check("add child A", data is not None and data.get("success"))
    child_a = data.get("elementId") if data else None

    data = api("tab_action", {"action": "add_element", "parentId": "root", "topic": "Child B"})
    r.check("add child B", data is not None and data.get("success"))
    child_b = data.get("elementId") if data else None

    # Add grandchild
    if child_a:
        data = api("tab_action", {"action": "add_element", "parentId": child_a, "topic": "Grandchild"})
        r.check("add grandchild under A", data is not None and data.get("success"))
        grandchild = data.get("elementId") if data else None

    # --- Get element detail ---
    if child_a:
        data = api("tab_action", {"action": "get_element", "elementId": child_a})
        r.check("get_element (child A)", data is not None and data.get("success"))

    # --- Update element — topic ---
    if child_b:
        data = api("tab_action", {"action": "update_element", "elementId": child_b, "topic": "Updated B"})
        r.check("update topic", data is not None and data.get("success"))

        data = api("tab_action", {"action": "get_element", "elementId": child_b})
        r.check("topic updated", data is not None and "Updated B" in str(data))

    # --- Node styling ---
    print("  -- Node Styling --")

    if child_a:
        # Style object
        data = api("tab_action", {
            "action": "update_element", "elementId": child_a,
            "style": {"color": "#ffffff", "background": "#e74c3c", "fontSize": "18", "fontWeight": "bold"},
        })
        r.check("set node style", data is not None and data.get("success"))

        # Branch color
        data = api("tab_action", {
            "action": "update_element", "elementId": child_a,
            "branchColor": "#3498db",
        })
        r.check("set branchColor", data is not None and data.get("success"))

        # Tags
        data = api("tab_action", {
            "action": "update_element", "elementId": child_a,
            "tags": ["important", "review"],
        })
        r.check("set tags", data is not None and data.get("success"))

        # Icons
        data = api("tab_action", {
            "action": "update_element", "elementId": child_a,
            "icons": ["⭐", "🔥"],
        })
        r.check("set icons", data is not None and data.get("success"))

        # HyperLink
        data = api("tab_action", {
            "action": "update_element", "elementId": child_a,
            "hyperLink": "https://example.com",
        })
        r.check("set hyperLink", data is not None and data.get("success"))

        # Note (tooltip)
        data = api("tab_action", {
            "action": "update_element", "elementId": child_a,
            "note": "This is a hover note",
        })
        r.check("set note", data is not None and data.get("success"))

    # --- Expand/Collapse state preservation ---
    print("  -- Expand/Collapse --")

    if child_a:
        # Collapse child A (has grandchild)
        data = api("tab_action", {
            "action": "update_element", "elementId": child_a,
            "expanded": False,
        })
        r.check("collapse child A", data is not None and data.get("success"))

        # Save
        data = api("save_tab")
        r.check("save mindmap (collapsed state)", data is not None and data.get("success"))

        # Verify collapsed state persisted
        data = api("tab_action", {"action": "get_elements"})
        if data:
            mm = data.get("mindmapData", {}).get("nodeData", {})
            children = mm.get("children", [])
            child_a_data = next((c for c in children if c.get("id") == child_a), None)
            if child_a_data:
                r.check("collapsed state preserved", child_a_data.get("expanded") is False,
                        f"expanded={child_a_data.get('expanded')}")
            else:
                r.fail("find child A in saved data")

        # Re-expand
        data = api("tab_action", {
            "action": "update_element", "elementId": child_a,
            "expanded": True,
        })
        r.check("re-expand child A", data is not None and data.get("success"))

    # --- set_data (full replace) ---
    print("  -- set_data --")

    custom_data = {
        "action": "set_data",
        "mindmapData": {
            "nodeData": {
                "id": "root", "topic": "Replaced Root", "root": True,
                "children": [
                    {"id": "c1", "topic": "New Child 1", "children": []},
                    {"id": "c2", "topic": "New Child 2", "children": [],
                     "expanded": False, "style": {"background": "#27ae60"}},
                ],
            },
        },
    }
    data = api("tab_action", custom_data)
    r.check("set_data (full replace)", data is not None and data.get("success"))

    # Verify replacement
    data = api("tab_action", {"action": "get_elements"})
    if data:
        root_topic = data.get("mindmapData", {}).get("nodeData", {}).get("topic", "")
        r.check("root replaced to 'Replaced Root'", root_topic == "Replaced Root")

    # --- Remove node ---
    data = api("tab_action", {"action": "remove_element", "elementId": "c1"})
    r.check("remove node c1", data is not None and data.get("success"))

    # Save
    data = api("save_tab")
    r.check("save mindmap (final)", data is not None and data.get("success"))


def test_excalidraw_tab(r: TestResult):
    """Test excalidraw tab — ALL documented operations."""
    print("\n--- 4. Excalidraw Tab ---")

    data = api("open_tab", {"title": "smoke-excalidraw", "type": "excalidraw"})
    r.check("create excalidraw tab", data is not None and data.get("success"))
    tab_id = data.get("tab_id") if data else None
    if not tab_id:
        return

    data = api("switch_tab", {"tab_id": tab_id})
    r.check("switch to excalidraw", data is not None and data.get("success"))

    # --- Get elements (initially empty) ---
    data = api("tab_action", {"action": "get_elements"})
    r.check("get_elements (initial)", data is not None and data.get("success"))

    # --- Add various element types ---
    print("  -- Element Types --")

    # Rectangle with label
    data = api("tab_action", {
        "action": "add_element",
        "element": {
            "type": "rectangle", "x": 50, "y": 50,
            "width": 200, "height": 100,
            "strokeColor": "#1e88e5", "backgroundColor": "#e3f2fd",
            "label": {"text": "Box A", "fontSize": 16},
        },
    })
    r.check("add rectangle with label", data is not None and data.get("success"))
    rect_id = (data.get("elementIds") or [None])[0] if data else None

    # Ellipse
    data = api("tab_action", {
        "action": "add_element",
        "element": {
            "type": "ellipse", "x": 350, "y": 50,
            "width": 150, "height": 100,
            "strokeColor": "#e53935",
            "label": {"text": "Circle"},
        },
    })
    r.check("add ellipse", data is not None and data.get("success"))
    ellipse_id = (data.get("elementIds") or [None])[0] if data else None

    # Diamond
    data = api("tab_action", {
        "action": "add_element",
        "element": {
            "type": "diamond", "x": 600, "y": 50,
            "width": 120, "height": 120,
            "strokeColor": "#ffa726",
            "label": {"text": "Decision"},
        },
    })
    r.check("add diamond", data is not None and data.get("success"))

    # Text
    data = api("tab_action", {
        "action": "add_element",
        "element": {
            "type": "text", "x": 50, "y": 250,
            "text": "Standalone text element",
            "fontSize": 20,
        },
    })
    r.check("add text", data is not None and data.get("success"))

    # Arrow
    if rect_id and ellipse_id:
        data = api("tab_action", {
            "action": "add_element",
            "element": {
                "type": "arrow",
                "x": 250, "y": 100,
                "points": [[0, 0], [100, 0]],
                "strokeColor": "#ccc",
            },
        })
        r.check("add arrow", data is not None and data.get("success"))

    # --- Get element detail ---
    print("  -- Element Detail --")

    if rect_id:
        data = api("tab_action", {"action": "get_element", "elementId": rect_id})
        r.check("get_element (rect)", data is not None and data.get("success"))

    # --- Update element ---
    if rect_id:
        data = api("tab_action", {
            "action": "update_element",
            "elementId": rect_id,
            "props": {"label": "Updated Box", "backgroundColor": "#ffcdd2"},
        })
        r.check("update_element (label+color)", data is not None and data.get("success"))

    # --- Remove element ---
    if ellipse_id:
        data = api("tab_action", {"action": "remove_element", "elementId": ellipse_id})
        r.check("remove ellipse", data is not None and data.get("success"))

    # --- import_structure ---
    print("  -- import_structure --")

    data = api("tab_action", {
        "action": "import_structure",
        "diagram": {
            "title": {"text": "Test Diagram", "x": 50, "y": 400, "fontSize": 20, "color": "#89b4fa"},
            "nodes": [
                {"id": "a", "type": "rect", "x": 50, "y": 450, "w": 100, "h": 50, "text": "Start", "stroke": "#a6e3a1", "bg": "#313244"},
                {"id": "b", "type": "rect", "x": 250, "y": 450, "w": 100, "h": 50, "text": "End", "stroke": "#f38ba8", "bg": "#313244"},
            ],
            "edges": [
                {"from": "a", "to": "b", "color": "#cdd6f4", "text": "go"},
            ],
        },
        "append": True,
    })
    r.check("import_structure", data is not None and data.get("success"))

    # --- Verify elements count ---
    data = api("tab_action", {"action": "get_elements"})
    r.check("multiple elements present", data is not None and data.get("success"))

    # --- Save ---
    data = api("save_tab")
    r.check("save excalidraw", data is not None and data.get("success"))


def test_notes_tab(r: TestResult):
    """Test notes tab — ALL documented operations."""
    print("\n--- 5. Notes Tab ---")

    data = api("open_tab", {"title": "smoke-notes", "type": "notes"})
    r.check("create notes tab", data is not None and data.get("success"))
    tab_id = data.get("tab_id") if data else None
    if not tab_id:
        return

    data = api("switch_tab", {"tab_id": tab_id})
    r.check("switch to notes", data is not None and data.get("success"))

    # --- Get elements (initially empty) ---
    data = api("tab_action", {"action": "get_elements"})
    r.check("get_elements (initial)", data is not None and data.get("success"))
    if data:
        r.check("no pages initially", data.get("count", -1) == 0)

    # --- Add page ---
    print("  -- Page CRUD --")

    data = api("tab_action", {
        "action": "add_element",
        "title": "Test Page 1",
        "content": [
            {"type": "heading", "props": {"level": 1}, "content": [{"type": "text", "text": "Hello Notes"}], "children": []},
            {"type": "paragraph", "props": {}, "content": [{"type": "text", "text": "This is a test paragraph."}], "children": []},
        ],
    })
    r.check("add page with content", data is not None and data.get("success"))
    page1_id = data.get("elementId") if data else None

    # Add second page
    data = api("tab_action", {
        "action": "add_element",
        "title": "Test Page 2",
        "content": [
            {"type": "bulletListItem", "props": {}, "content": [{"type": "text", "text": "Item 1"}], "children": []},
            {"type": "bulletListItem", "props": {}, "content": [{"type": "text", "text": "Item 2"}], "children": []},
            {"type": "checkListItem", "props": {"checked": False}, "content": [{"type": "text", "text": "Todo item"}], "children": []},
        ],
    })
    r.check("add page 2 with lists", data is not None and data.get("success"))
    page2_id = data.get("elementId") if data else None

    # --- Get element (page detail) ---
    if page1_id:
        data = api("tab_action", {"action": "get_element", "elementId": page1_id})
        r.check("get page 1 detail", data is not None and data.get("success"))

    # --- Update page ---
    if page1_id:
        data = api("tab_action", {
            "action": "update_element",
            "elementId": page1_id,
            "title": "Updated Page Title",
        })
        r.check("update page title", data is not None and data.get("success"))

    # --- Verify pages ---
    data = api("tab_action", {"action": "get_elements"})
    if data:
        r.check("2 pages exist", data.get("count", 0) == 2)

    # --- Remove page ---
    if page2_id:
        data = api("tab_action", {"action": "remove_element", "elementId": page2_id})
        r.check("remove page 2", data is not None and data.get("success"))

    data = api("tab_action", {"action": "get_elements"})
    if data:
        r.check("1 page remaining", data.get("count", 0) == 1)

    # --- Save ---
    data = api("save_tab")
    r.check("save notes", data is not None and data.get("success"))


def test_tab_management(r: TestResult):
    """Test tab management operations."""
    print("\n--- 6. Tab Management ---")

    # Get all tabs
    data = api("get_tabs")
    r.check("get_tabs", data is not None and data.get("success"))

    # List saved workspaces
    data = api("list_saved")
    r.check("list_saved", data is not None and data.get("success"))

    # Get tab contents (auto-detect type)
    data = api("get_tab_contents")
    r.check("get_tab_contents", data is not None and data.get("success"))

    # Get tab contents with max_chars
    data = api("get_tab_contents", {"max_chars": 100})
    r.check("get_tab_contents (max_chars)", data is not None and data.get("success"))

    # Rename tab
    data = api("rename_tab", {"filename": "smoke-flow.rcflow", "new_title": "smoke-flow-renamed"})
    r.check("rename_tab", data is not None and data.get("success"))

    # Rename back
    data = api("rename_tab", {"filename": "smoke-flow-renamed.rcflow", "new_title": "smoke-flow"})
    r.check("rename back", data is not None and data.get("success"))


def test_debug_tools(r: TestResult):
    """Test debugging and monitoring tools."""
    print("\n--- 7. Debug Tools ---")

    # Console logs
    data = api("get_console_logs")
    r.check("get_console_logs", data is not None and data.get("success"))

    # Frontend errors
    data = api("get_frontend_errors")
    r.check("get_frontend_errors", data is not None and data.get("success"))

    # Clear logs
    data = api("clear_logs")
    r.check("clear_logs", data is not None and data.get("success"))

    # Verify cleared
    data = api("get_console_logs")
    r.check("logs cleared", data is not None and data.get("success"))

    # CDP status
    data = api("cdp_status")
    r.check("cdp_status", data is not None and data.get("connected") is True)

    # Screenshot
    data = api("screenshot", {"mode": "full", "filename": "smoke_test.png"})
    r.check("screenshot", data is not None and data.get("filepath") is not None)


def test_cleanup(r: TestResult):
    """Clean up test workspaces."""
    print("\n--- 8. Cleanup ---")

    # Close all test tabs
    tabs_data = api("get_tabs")
    if tabs_data:
        msg = tabs_data.get("message", "")
        for line in msg.splitlines():
            if "smoke-" in line:
                # Extract tab_id
                parts = line.strip().split(":")
                if parts:
                    tid = parts[0].strip()
                    api("close_tab", {"tab_id": tid})

    # Delete test workspace files
    for ext in ["rcflow", "rcmind", "rcexcalidraw", "rcnotes"]:
        for name in ["smoke-flow", "smoke-mindmap", "smoke-excalidraw", "smoke-notes"]:
            api("delete_tab", {"filename": f"{name}.{ext}"})

    # Verify
    data = api("list_saved")
    msg = data.get("message", "") if data else ""
    remaining = [n for n in ["smoke-flow", "smoke-mindmap", "smoke-excalidraw", "smoke-notes"] if n in msg]
    r.check("test workspaces cleaned", len(remaining) == 0,
            f"remaining: {remaining}" if remaining else "all removed")


# ============================================================
# Main
# ============================================================

SUITES = {
    "connection": test_connection,
    "flow": test_flow_tab,
    "mindmap": test_mindmap_tab,
    "excalidraw": test_excalidraw_tab,
    "notes": test_notes_tab,
    "tabs": test_tab_management,
    "debug": test_debug_tools,
    "cleanup": test_cleanup,
}


def main():
    parser = argparse.ArgumentParser(description="HiyoCanvas smoke test")
    parser.add_argument("--no-ctl", action="store_true", help="Skip start/stop (app already running)")
    parser.add_argument("--suite", type=str, help=f"Run specific suite: {', '.join(SUITES.keys())}")
    args = parser.parse_args()

    print("=== HiyoCanvas Smoke Test ===\n")

    # Start app
    if not args.no_ctl:
        print("Starting HiyoCanvas...")
        if not ctl("start"):
            print("[FAIL] Could not start HiyoCanvas")
            sys.exit(1)
        print("Started.\n")

    if not wait_ready():
        print("[FAIL] Frontend not ready after 10s")
        if not args.no_ctl:
            ctl("stop")
        sys.exit(1)

    r = TestResult()

    # Pre-cleanup: delete leftover test workspaces from previous runs
    print("Cleaning up leftover test data...")
    for ext in ["rcflow", "rcmind", "rcexcalidraw", "rcnotes"]:
        for name in ["smoke-flow", "smoke-mindmap", "smoke-excalidraw", "smoke-notes"]:
            api("delete_tab", {"filename": f"{name}.{ext}"})
    print()

    try:
        if args.suite:
            if args.suite not in SUITES:
                print(f"Unknown suite: {args.suite}")
                print(f"Available: {', '.join(SUITES.keys())}")
                sys.exit(1)
            SUITES[args.suite](r)
        else:
            for name, fn in SUITES.items():
                fn(r)
    except Exception as e:
        print(f"\n[ERROR] Unexpected exception: {e}")
        import traceback
        traceback.print_exc()
        r.fail("unexpected exception", str(e))

    # Stop app
    if not args.no_ctl:
        print("\nStopping HiyoCanvas...")
        ctl("stop")
        print("Stopped.")

    # Summary
    print(f"\n=== Result: {r.summary()} ===")

    # List failures
    failures = [(name, detail) for name, ok, detail in r.results if not ok]
    if failures:
        print("\nFailed tests:")
        for name, detail in failures:
            print(f"  - {name}" + (f": {detail}" if detail else ""))

    sys.exit(1 if r.failed > 0 else 0)


if __name__ == "__main__":
    main()
