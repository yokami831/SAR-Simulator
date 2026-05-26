#!/usr/bin/env python3
"""HiyoCanvas API wrapper script.

Single entry point for all HiyoCanvas REST API calls.
Routes through one script so Claude Code grants permission once.

Usage:
    python canvas_api.py <action> [arg]
    echo '{"key":"value"}' | python canvas_api.py <action> -

Examples:
    python canvas_api.py frontend_status
    python canvas_api.py add_element '{"type":"python_code","parameters":{"code":"result = 42"}}'
    python canvas_api.py connect '{"source":"n1","source_port":"out_0","target":"n2","target_port":"in_0"}'
    python canvas_api.py start_execution
    python canvas_api.py get_execution_result '{"node_id":"n1"}'
    python canvas_api.py search_block_types '{"query":"python"}'
    python canvas_api.py screenshot '{"mode":"full"}'

    # Use stdin (-) for JSON with special characters (quotes, backslashes):
    cat <<'ENDJSON' | python canvas_api.py update_element -
    {"node_id":"n100","code":"print(f'hello {name}')"}
    ENDJSON
"""

import io
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# Force UTF-8 for stdin/stdout on Windows (default is CP932 which breaks Japanese)
if sys.platform == "win32":
    sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8", errors="replace")
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

TIMEOUT = 15  # seconds

_LEGACY_ROOT = "http://127.0.0.1:18731"


def _health_ok(root: str) -> bool:
    """Return True if `root` answers /api/health with app=='hiyocanvas'."""
    try:
        with urllib.request.urlopen(f"{root}/api/health", timeout=2) as resp:
            if resp.status != 200:
                return False
            body = json.loads(resp.read().decode("utf-8"))
            return body.get("app") == "hiyocanvas"
    except Exception:
        return False


def discover_base() -> str:
    """Discover the HiyoCanvas server root (http://host:port).

    Precedence:
      1. HIYOCANVAS_URL env (its host:port portion).
      2. .hiyocanvas-runtime.json server_port (verified via /api/health).
      3. Legacy http://127.0.0.1:18731 (verified; returned regardless so the
         normal connection-refused error fires downstream if nothing is up).
    """
    # 1. Explicit env override (use the scheme://host:port part).
    env_url = os.environ.get("HIYOCANVAS_URL")
    if env_url:
        parsed = urllib.parse.urlsplit(env_url)
        if parsed.scheme and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}"

    # 2. Runtime discovery file: scripts -> hiyocanvas -> skills -> .claude -> PROJECT_ROOT
    try:
        project_root = Path(__file__).resolve().parents[4]
        runtime_file = project_root / ".hiyocanvas-runtime.json"
        if runtime_file.exists():
            data = json.loads(runtime_file.read_text(encoding="utf-8"))
            port = data.get("server_port")
            if port:
                root = f"http://127.0.0.1:{port}"
                if _health_ok(root):
                    return root
    except Exception:
        pass

    # 3. Legacy fallback (return even if unverified so downstream surfaces the error).
    return _LEGACY_ROOT


_ROOT = discover_base()

# Explicit per-endpoint env overrides take highest precedence; otherwise derive
# from the discovered root.
BASE_URL = os.environ.get("HIYOCANVAS_URL", f"{_ROOT}/api/tools")
CDP_BASE_URL = os.environ.get("HIYOCANVAS_CDP_URL", f"{_ROOT}/api/cdp")
WORKSPACE_BASE_URL = os.environ.get("HIYOCANVAS_WS_URL", f"{_ROOT}/api/workspaces")

# Routing table: action -> (http_method, path_template, arg_type)
# arg_type: "json_body", "no_arg", "path_param", "query_param"
ENDPOINTS = {
    # POST with JSON body — Node operations
    "add_element":      ("POST", "/add_element",      "json_body"),
    "remove_element":   ("POST", "/remove_element",   "json_body"),
    "get_element":      ("POST", "/get_element",      "json_body"),
    "update_element":   ("POST", "/update_element",   "json_body"),
    "get_elements":     ("POST", "/get_elements",     "json_body"),
    # Edges
    "connect":       ("POST", "/connect",       "json_body"),
    "disconnect":    ("POST", "/disconnect",    "json_body"),
    # Block registry
    "register_block":("POST", "/register_block","json_body"),
    "get_block_schema": ("POST", "/get_block_schema", "json_body"),
    "search_block_types": ("POST", "/search_block_types", "json_body"),
    # File I/O
    "save_tab":      ("POST", "/save_tab",      "no_arg"),
    "load_tab":      ("POST", "/load_tab",      "json_body"),
    "batch":         ("POST", "/batch",         "json_body"),
    # Tooltip
    "tooltip":        ("POST", "/tooltip",        "json_body"),
    "hide_tooltip":   ("POST", "/hide_tooltip",   "json_body"),
    # Subgraph
    "create_subgraph":  ("POST", "/create_subgraph",  "json_body"),
    "set_subgraph":     ("POST", "/set_subgraph",     "json_body"),
    "ungroup_subgraph": ("POST", "/ungroup_subgraph", "json_body"),
    # View
    "fit_all":       ("POST", "/fit_all",       "json_body"),
    "fit_node":      ("POST", "/fit_node",      "json_body"),
    "zoom":          ("POST", "/zoom",          "json_body"),
    "get_viewport":  ("POST", "/get_viewport",  "json_body"),
    # Tab operations
    "open_tab":        ("POST", "/open_tab",        "json_body"),
    "close_tab":       ("POST", "/close_tab",       "json_body"),
    "switch_tab":      ("POST", "/switch_tab",      "json_body"),
    "get_tab_contents": ("POST", "/get_tab_contents", "json_body"),
    "get_tabs":        ("POST", "/get_tabs",        "json_body"),
    "tab_action":      ("POST", "/tab_action",      "json_body"),
    "list_saved":      ("POST", "/list_saved",      "json_body"),
    "delete_tab":      ("POST", "/delete_tab",      "json_body"),
    "rename_tab":      ("POST", "/rename_tab",      "json_body"),
    # Execution
    "get_execution_status": ("POST", "/get_execution_status", "json_body"),
    "get_execution_result": ("POST", "/get_execution_result", "json_body"),
    # Modal dialog
    "get_modal_state":  ("POST", "/get_modal_state",  "json_body"),
    "dismiss_modal":    ("POST", "/dismiss_modal",    "json_body"),
    # Server
    "frontend_status": ("POST", "/frontend_status", "json_body"),
    "get_console_logs": ("POST", "/get_console_logs", "json_body"),
    "get_frontend_errors": ("POST", "/get_frontend_errors", "json_body"),
    # POST no body
    "start_execution": ("POST", "/start_execution", "no_arg"),
    "run":             ("POST", "/start_execution", "no_arg"),  # alias
    "stop_execution":  ("POST", "/stop_execution",  "no_arg"),
    "stop":            ("POST", "/stop_execution",  "no_arg"),  # alias
    "clear_canvas":  ("POST", "/clear",         "no_arg"),
    "clear_tooltips":("POST", "/clear_tooltips","no_arg"),
    "auto_layout":   ("POST", "/auto_layout",   "no_arg"),
    "reload":        ("POST", "/reload",        "no_arg"),
    "shutdown":      ("POST", "/shutdown",      "no_arg"),
    "clear_logs":    ("POST", "/clear_logs",    "no_arg"),
    "step_start":    ("POST", "/step_start",    "no_arg"),
    "step_next":     ("POST", "/step_next",     "no_arg"),
    "step_reset":    ("POST", "/step_reset",    "no_arg"),
    "run_remaining": ("POST", "/run_remaining", "no_arg"),
    # GET with path param
    "block_schema":  ("GET",  "/block_schema/{}", "path_param"),
}

# CDP endpoints (routed via CDP_BASE_URL)
CDP_ENDPOINTS = {
    "cdp_status":  ("GET",  "/status",      "no_arg"),
    "screenshot":  ("POST", "/screenshot",  "json_body"),
    "viewport":    ("GET",  "/viewport",    "no_arg"),
    "send_chat":   ("POST", "/send_chat",   "json_body"),
    "get_chat":    ("POST", "/get_chat",    "json_body"),
}

# Workspace endpoints (routed via WORKSPACE_BASE_URL)
WORKSPACE_ENDPOINTS = {
    "workspaces":       ("GET",  "",           "no_arg"),
    "create_workspace": ("POST", "",           "json_body"),
}


def call_api(action: str, arg: str = None) -> dict:
    """Execute a HiyoCanvas API call."""
    # Determine routing table and base URL
    if action in CDP_ENDPOINTS:
        method, path_template, arg_type = CDP_ENDPOINTS[action]
        base_url = CDP_BASE_URL
    elif action in WORKSPACE_ENDPOINTS:
        method, path_template, arg_type = WORKSPACE_ENDPOINTS[action]
        base_url = WORKSPACE_BASE_URL
    elif action in ENDPOINTS:
        method, path_template, arg_type = ENDPOINTS[action]
        base_url = BASE_URL
    else:
        all_actions = sorted(set(
            list(ENDPOINTS.keys()) +
            list(CDP_ENDPOINTS.keys()) +
            list(WORKSPACE_ENDPOINTS.keys())
        ))
        print(f"[FAIL] Unknown action: {action}")
        print(f"Available: {', '.join(all_actions)}")
        sys.exit(1)

    # Build URL
    if arg_type == "path_param":
        if not arg:
            print(f"[FAIL] Action '{action}' requires a parameter (e.g., node_id)")
            sys.exit(1)
        url = base_url + path_template.format(urllib.parse.quote(arg, safe=""))
    elif arg_type == "query_param":
        if not arg:
            print(f"[FAIL] Action '{action}' requires a search query")
            sys.exit(1)
        url = base_url + path_template + "?" + urllib.parse.urlencode({"q": arg})
    else:
        url = base_url + path_template

    # Build request body
    data = None
    headers = {}

    if method == "POST":
        headers["Content-Type"] = "application/json"
        if arg_type == "json_body":
            if not arg:
                arg = "{}"
            # @file support: read JSON from file (e.g. @tmp_data.json)
            if arg.startswith("@"):
                file_path = Path(arg[1:])
                if not file_path.exists():
                    print(f"[FAIL] JSON file not found: {file_path}")
                    sys.exit(1)
                arg = file_path.read_text(encoding="utf-8-sig")
            try:
                parsed = json.loads(arg)
            except json.JSONDecodeError as e:
                print(f"[FAIL] Invalid JSON argument: {e}")
                sys.exit(1)
            # Resolve code_file → code (avoids shell escaping issues)
            if isinstance(parsed, dict):
                # Top-level: update_element '{"node_id":"n1","code_file":"/tmp/code.py"}'
                if "code_file" in parsed:
                    code_path = Path(parsed.pop("code_file"))
                    if not code_path.exists():
                        print(f"[FAIL] Code file not found: {code_path}")
                        sys.exit(1)
                    parsed["code"] = code_path.read_text(encoding="utf-8")
                # Nested: add_element '{"type":"python_code","parameters":{"code_file":"/tmp/code.py"}}'
                params = parsed.get("parameters", {})
                if isinstance(params, dict) and "code_file" in params:
                    code_path = Path(params.pop("code_file"))
                    if not code_path.exists():
                        print(f"[FAIL] Code file not found: {code_path}")
                        sys.exit(1)
                    params["code"] = code_path.read_text(encoding="utf-8")
            # screenshot: default output_dir to CWD/screenshots/
            if action == "screenshot" and isinstance(parsed, dict):
                if "output_dir" not in parsed:
                    parsed["output_dir"] = str(Path.cwd() / "screenshots")
            data = json.dumps(parsed).encode("utf-8")
        else:
            data = b"{}"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body)
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace")
        try:
            error_json = json.loads(error_body)
            detail = error_json.get("detail", error_body)
        except json.JSONDecodeError:
            detail = error_body
        print(f"[FAIL] {action}: HTTP {e.code}: {detail}")
        sys.exit(1)
    except urllib.error.URLError as e:
        if "Connection refused" in str(e.reason):
            print(f"[FAIL] {action}: Connection refused - HiyoCanvas server is not running")
            print("  Start with: start.bat")
        else:
            print(f"[FAIL] {action}: Connection error: {e.reason}")
        sys.exit(1)
    except TimeoutError:
        print(f"[FAIL] {action}: Request timed out after {TIMEOUT}s")
        sys.exit(1)


def format_output(action: str, result: dict, raw_json: bool = False) -> None:
    """Format and print API response."""
    if raw_json:
        print(json.dumps(result, ensure_ascii=False))
        return

    # Check response-level success field
    if isinstance(result, dict) and result.get("success") is False:
        print(f"[FAIL] {action}")
        error_msg = result.get("error") or result.get("message") or ""
        if error_msg:
            print(f"  {error_msg}")
        return
    print(f"[OK] {action}")

    if action == "connect":
        print(f"  edge_id: {result.get('edge_id')}")
    elif action == "register_block":
        block = result.get("block", result)
        print(f"  id: {block.get('id')}")
        print(f"  label: {block.get('label')}")
    elif action == "block_schema":
        print(f"  id: {result.get('id')}")
        print(f"  label: {result.get('label')}")
        print(f"  category: {result.get('category')}")
        params = result.get("parameters", [])
        visible = [p for p in params if not p.get("hidden")]
        print(f"  parameters ({len(visible)} visible):")
        for p in visible:
            line = f"    {p['id']}: {p.get('dtype', '')}"
            if p.get("options"):
                line += f" [{', '.join(str(o) for o in p['options'])}]"
            if p.get("default"):
                line += f" (default: {p['default']})"
            print(line)
        inputs = result.get("inputs", [])
        outputs = result.get("outputs", [])
        if inputs:
            print(f"  inputs: {', '.join(p['id'] + ':' + p.get('dtype','') for p in inputs)}")
        if outputs:
            print(f"  outputs: {', '.join(p['id'] + ':' + p.get('dtype','') for p in outputs)}")
    elif action == "screenshot":
        filepath = result.get("filepath", "")
        print(f"  filepath: {filepath}")
        if result.get("url"):
            print(f"  url: {result['url']}")
        dom = result.get("dom_rect", {})
        w = result.get("width") or dom.get("width")
        h = result.get("height") or dom.get("height")
        if w:
            print(f"  size: {int(w)}x{int(h)}")
    elif action == "tooltip":
        print(f"  node_id: {result.get('node_id')}")
        print(f"  type: {result.get('type')}")
    elif action == "get_modal_state":
        if result.get("visible"):
            print(f"  visible: true")
            print(f"  title: {result.get('title', '')}")
            print(f"  message: {result.get('message', '')}")
            print(f"  buttons: {', '.join(result.get('buttons', []))}")
        else:
            print(f"  visible: false")
    elif action == "dismiss_modal":
        print(f"  clicked: {result.get('clicked', '')}")
    elif action in ("hide_tooltip", "clear_tooltips"):
        pass  # [OK] header is sufficient
    elif action == "cdp_status":
        print(f"  connected: {result.get('connected')}")
        if result.get("debug_port"):
            print(f"  debug_port: {result['debug_port']}")
        if result.get("page_title"):
            print(f"  page_title: {result['page_title']}")
    elif action == "viewport":
        print(json.dumps(result, indent=2, ensure_ascii=False))
    elif action == "workspaces":
        ws_list = result.get("workspaces", result) if isinstance(result, dict) else result
        if isinstance(ws_list, list):
            print(f"  {len(ws_list)} workspaces:")
            for w in ws_list:
                title = w.get("title", w.get("name", "?"))
                fname = w.get("filename", "?")
                wtype = w.get("type", "flow")
                print(f"    {fname}: {title} ({wtype})")
        else:
            print(json.dumps(result, indent=2, ensure_ascii=False))
    elif action == "create_workspace":
        print(f"  filename: {result.get('filename')}")
        print(f"  title: {result.get('title')}")
    elif action == "send_chat":
        pass  # [OK] is sufficient
    elif action == "get_chat":
        messages = result.get("messages", [])
        total = result.get("total", 0)
        print(f"  {len(messages)} messages (of {total} total):")
        for msg in messages:
            role = msg.get("role", "?")
            content = msg.get("content", "")
            if len(messages) > 1 and len(content) > 1000:
                content = content[:1000] + "..."
            print(f"  [{role}] {content}")
    else:
        # Generic: compact JSON for small responses
        text = json.dumps(result, ensure_ascii=False)
        if len(text) > 200:
            print(json.dumps(result, indent=2, ensure_ascii=False))
        else:
            print(f"  {text}")


def main():
    # Check for --json flag
    raw_json = False
    args = sys.argv[1:]
    if "--json" in args:
        raw_json = True
        args.remove("--json")

    if not args:
        print("Usage: python canvas_api.py [--json] <action> [arg]")
        print()
        print("Actions:")
        print("  Node ops:    add_element, remove_element, get_element, update_element, get_elements")
        print("  Edges:       connect, disconnect")
        print("  Canvas:      clear_canvas, auto_layout, batch")
        print("  View:        fit_all, fit_node, zoom, get_viewport, screenshot")
        print("  Registry:    register_block, get_block_schema, search_block_types")
        print("  Execution:   start_execution, stop_execution, get_execution_status,")
        print("               get_execution_result")
        print("  File:        save_tab, load_tab")
        print("  Tab:         get_tabs, list_saved, open_tab, close_tab, switch_tab,")
        print("               delete_tab, rename_tab, get_tab_contents")
        print("  Server:      frontend_status, reload, shutdown, get_console_logs,")
        print("               get_frontend_errors, clear_logs")
        print("  Tooltip:     tooltip, hide_tooltip, clear_tooltips")
        print("  Subgraph:    create_subgraph, set_subgraph, ungroup_subgraph")
        print("  CDP:         cdp_status, viewport")
        sys.exit(1)

    action = args[0]
    arg = args[1] if len(args) > 1 else None

    # Read JSON from stdin: explicit "-" arg, or auto-detect piped input
    # Note: sys.stdin.isatty() returns False in some environments (e.g. PowerShell tool
    # in Claude Code) even when no data is piped. msvcrt.kbhit() doesn't detect pipe data.
    # Solution: use a thread with timeout to try reading stdin non-blockingly.
    stdin_has_data = False
    if arg == "-":
        stdin_has_data = True
    elif arg is None and not sys.stdin.isatty():
        if sys.platform == "win32":
            import threading
            _stdin_result = [None]
            def _read_stdin():
                try:
                    _stdin_result[0] = sys.stdin.read()
                except Exception:
                    pass
            t = threading.Thread(target=_read_stdin, daemon=True)
            t.start()
            t.join(timeout=0.15)  # wait briefly for pipe data
            if _stdin_result[0] is not None:
                stdin_has_data = True
                arg = _stdin_result[0].strip().lstrip("\ufeff")
        else:
            import select
            stdin_has_data = bool(select.select([sys.stdin], [], [], 0.1)[0])
    if stdin_has_data and arg is None:
        arg = sys.stdin.read().strip().lstrip("\ufeff")  # strip BOM

    result = call_api(action, arg)
    format_output(action, result, raw_json)


if __name__ == "__main__":
    main()
