#!/usr/bin/env python3
"""HiyoCanvas API wrapper script.

Single entry point for all HiyoCanvas REST API calls.
Routes through one script so Claude Code grants permission once.

Usage:
    python canvas_api.py <action> [arg]

Examples:
    python canvas_api.py status
    python canvas_api.py add_block '{"type":"python_code","parameters":{"code":"result = 42"}}'
    python canvas_api.py connect '{"source":"n1","source_port":"out_0","target":"n2","target_port":"in_0"}'
    python canvas_api.py run
    python canvas_api.py result n1
    python canvas_api.py search_blocks "python"
    python canvas_api.py screenshot '{"mode":"full"}'
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE_URL = os.environ.get("HIYOCANVAS_URL", "http://127.0.0.1:18731/api/tools")
CDP_BASE_URL = os.environ.get("HIYOCANVAS_CDP_URL", "http://127.0.0.1:18731/api/cdp")
WORKSPACE_BASE_URL = os.environ.get("HIYOCANVAS_WS_URL", "http://127.0.0.1:18731/api/workspaces")
TIMEOUT = 15  # seconds

# Routing table: action -> (http_method, path_template, arg_type)
# arg_type: "json_body", "no_arg", "path_param", "query_param"
ENDPOINTS = {
    # POST with JSON body
    "add_block":     ("POST", "/add_block",     "json_body"),
    "remove_block":  ("POST", "/remove_block",  "json_body"),
    "connect":       ("POST", "/connect",       "json_body"),
    "disconnect":    ("POST", "/disconnect",    "json_body"),
    "set_parameter": ("POST", "/set_parameter", "json_body"),
    "register_block":("POST", "/register_block","json_body"),
    "save":          ("POST", "/save",          "json_body"),
    "load":          ("POST", "/load",          "json_body"),
    "view":          ("POST", "/view",          "json_body"),
    "batch":         ("POST", "/batch",         "json_body"),
    # Tooltip
    "tooltip":        ("POST", "/tooltip",        "json_body"),
    "hide_tooltip":   ("POST", "/hide_tooltip",   "json_body"),
    # Subgraph (node grouping)
    "create_subgraph":  ("POST", "/create_subgraph",  "json_body"),
    "toggle_collapse":  ("POST", "/toggle_collapse",  "json_body"),
    "expand_subgraph":  ("POST", "/expand_subgraph",  "json_body"),
    "ungroup_subgraph": ("POST", "/ungroup_subgraph", "json_body"),
    "rename_subgraph":  ("POST", "/rename_subgraph",  "json_body"),
    "set_subgraph_description": ("POST", "/set_subgraph_description", "json_body"),
    # Tab operations
    "open_flow_tab": ("POST", "/open_flow_tab", "json_body"),
    "switch_tab":    ("POST", "/switch_tab",    "json_body"),
    "close_tab":     ("POST", "/close_tab",     "json_body"),
    # POST no body
    "run":           ("POST", "/run",           "no_arg"),
    "stop":          ("POST", "/stop",          "no_arg"),
    "clear":         ("POST", "/clear",         "no_arg"),
    "clear_tooltips":("POST", "/clear_tooltips","no_arg"),
    "auto_layout":   ("POST", "/auto_layout",   "no_arg"),
    "reload":        ("POST", "/reload",        "no_arg"),
    "shutdown":      ("POST", "/shutdown",      "no_arg"),
    "clear_logs":    ("POST", "/clear_logs",    "no_arg"),
    # GET simple
    "tabs":          ("GET",  "/tabs",          "no_arg"),
    "status":        ("GET",  "/status",        "no_arg"),
    "flowgraph":     ("GET",  "/flowgraph",     "no_arg"),
    "errors":        ("GET",  "/errors",        "no_arg"),
    "logs":          ("GET",  "/logs",          "no_arg"),
    # GET with path param
    "block_info":    ("GET",  "/block_info/{}", "path_param"),
    "block_schema":  ("GET",  "/block_schema/{}", "path_param"),
    "result":        ("GET",  "/result/{}",     "path_param"),
    # GET with query param
    "search_blocks": ("GET",  "/search_blocks", "query_param"),
}

# CDP endpoints (routed via CDP_BASE_URL)
CDP_ENDPOINTS = {
    "cdp_status":  ("GET",  "/status",      "no_arg"),
    "screenshot":  ("POST", "/screenshot",  "json_body"),
    "viewport":    ("GET",  "/viewport",    "no_arg"),
}

# Workspace endpoints (routed via WORKSPACE_BASE_URL)
WORKSPACE_ENDPOINTS = {
    "workspaces":       ("GET",  "",           "no_arg"),
    "create_workspace": ("POST", "",           "json_body"),
    "open_workspace":   ("GET",  "/{}",        "path_param"),
}


def call_api(action: str, arg: str = None) -> dict:
    """Execute an HiyoCanvas API call."""
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
                print(f"[FAIL] Action '{action}' requires a JSON body argument")
                sys.exit(1)
            try:
                parsed = json.loads(arg)
            except json.JSONDecodeError as e:
                print(f"[FAIL] Invalid JSON argument: {e}")
                sys.exit(1)
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

    print(f"[OK] {action}")

    if action == "add_block":
        print(f"  node_id: {result.get('node_id')}")
        print(f"  block_type: {result.get('block_type')}")
        hints = result.get("hints", [])
        if hints:
            print(f"  HINTS ({len(hints)}):")
            for h in hints:
                print(f"    - {h}")
    elif action == "connect":
        print(f"  edge_id: {result.get('edge_id')}")
    elif action == "register_block":
        block = result.get("block", result)
        print(f"  id: {block.get('id')}")
        print(f"  label: {block.get('label')}")
    elif action == "search_blocks":
        blocks = result.get("blocks", [])
        print(f"  Found {len(blocks)} blocks:")
        for b in blocks[:10]:
            print(f"    {b['id']}: {b.get('label', '')} ({b.get('category', '')})")
        if len(blocks) > 10:
            print(f"    ... and {len(blocks) - 10} more")
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
    elif action == "tabs":
        tab_list = result.get("tabs", [])
        print(f"  {len(tab_list)} tabs:")
        for t in tab_list:
            active = " *" if t.get("active") else ""
            ws = f" [{t['workspace_folder']}]" if t.get("workspace_folder") else ""
            print(f"    {t['id']}: {t.get('title', '?')} ({t.get('type', '?')}){ws}{active}")
    elif action == "open_flow_tab":
        print(f"  tab_id: {result.get('tab_id')}")
        print(f"  title: {result.get('title')}")
        if result.get("workspace_folder"):
            print(f"  workspace: {result['workspace_folder']}")
    elif action == "status":
        status = result.get("status", "unknown")
        print(f"  status: {status}")
        last = result.get("last_result")
        if last:
            print(f"  last_result: {last.get('status')} ({last.get('total_time', 0)}s)")
            nr = last.get("node_results", {})
            for nid, r in nr.items():
                ok = "OK" if r.get("success") else "FAIL"
                out = r.get("output", "").strip()[:80]
                err = r.get("error", "").strip()[:80]
                t = r.get("execution_time", 0)
                detail = out if r.get("success") else err
                print(f"    {nid}: [{ok}] {t:.3f}s {detail}")
        node_results = result.get("node_results")
        if node_results and not last:
            for nid, r in node_results.items():
                ok = "OK" if r.get("success") else "FAIL"
                print(f"    {nid}: [{ok}] {r.get('execution_time', 0):.3f}s")
    elif action == "result":
        print(f"  success: {result.get('success')}")
        if result.get("output"):
            print(f"  output: {result['output'].strip()[:200]}")
        if result.get("result_value"):
            print(f"  result_value: {str(result['result_value'])[:200]}")
        if result.get("display_data"):
            dd = result["display_data"]
            print(f"  display_data: {len(dd)} item(s)")
            for d in dd:
                print(f"    - {d.get('mime_type')}")
        if result.get("error"):
            print(f"  error: {result['error'].strip()[:200]}")
        if result.get("execution_time") is not None:
            print(f"  time: {result['execution_time']:.3f}s")
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
    elif action in ("hide_tooltip", "clear_tooltips"):
        pass  # [OK] header is sufficient
    elif action == "cdp_status":
        print(f"  connected: {result.get('connected')}")
        if result.get("debug_port"):
            print(f"  debug_port: {result['debug_port']}")
        if result.get("page_title"):
            print(f"  page_title: {result['page_title']}")
    elif action == "view":
        print(f"  success: {result.get('success')}")
    elif action == "viewport":
        print(json.dumps(result, indent=2, ensure_ascii=False))
    elif action == "logs":
        logs = result.get("logs", [])
        print(f"  {len(logs)} log entries:")
        for entry in logs[-20:]:
            ts = entry.get("timestamp", "")[:19].replace("T", " ")
            level = entry.get("level", "?").upper()
            msg = entry.get("message", "")
            print(f"    [{ts}] {level}: {msg}")
            details = entry.get("details", "")
            if details:
                for line in details.strip().split("\n"):
                    print(f"      {line}")
        if len(logs) > 20:
            print(f"    ... {len(logs) - 20} earlier entries (use --json for all)")
    elif action == "flowgraph":
        nodes = result.get("nodes", [])
        edges = result.get("edges", [])
        subgraphs = result.get("subgraphs", [])
        print(f"  nodes: {len(nodes)}, edges: {len(edges)}")
        for n in nodes:
            nid = n.get("id", "?")
            btype = n.get("blockType", n.get("type", "?"))
            label = n.get("label", "")
            sg_label = ""
            for sg in subgraphs:
                if nid in sg.get("childNodeIds", []):
                    sg_label = f" [in group: {sg.get('id')} \"{sg.get('label')}\"]"
                    break
            print(f"    {nid}: {label} ({btype}){sg_label}")
        for e in edges:
            sp = e.get("sourcePort", e.get("sourceHandle", "?"))
            tp = e.get("targetPort", e.get("targetHandle", "?"))
            print(f"    {e['source']}:{sp} -> {e['target']}:{tp}")
        if subgraphs:
            print(f"  subgraphs: {len(subgraphs)}")
            for sg in subgraphs:
                state = "collapsed" if sg.get("collapsed") else "expanded"
                desc = f" -- {sg['description']}" if sg.get("description") else ""
                children = ", ".join(sg.get("childNodeIds", []))
                print(f"    {sg['id']}: \"{sg.get('label')}\" ({state}, children: [{children}]){desc}")
    elif action == "workspaces":
        ws_list = result.get("workspaces", result) if isinstance(result, dict) else result
        if isinstance(ws_list, list):
            print(f"  {len(ws_list)} workspaces:")
            for w in ws_list:
                title = w.get("title", w.get("name", "?"))
                folder = w.get("folder_name", w.get("folder", "?"))
                wtype = w.get("type", "flow")
                print(f"    {folder}: {title} ({wtype})")
        else:
            print(json.dumps(result, indent=2, ensure_ascii=False))
    elif action == "create_workspace":
        print(f"  folder_name: {result.get('folder_name')}")
        print(f"  title: {result.get('title')}")
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
        print("  Block ops:   add_block, remove_block, connect, disconnect,")
        print("               set_parameter, register_block")
        print("  Execution:   run, stop, status, result <node_id>")
        print("  Canvas:      clear, auto_layout, view, batch, flowgraph")
        print("  State:       errors, logs, clear_logs, block_info <node_id>")
        print("  Search:      search_blocks <query>, block_schema <type_id>")
        print("  File:        save, load")
        print("  Tab:         tabs, open_flow_tab, switch_tab, close_tab")
        print("  Workspace:   workspaces, create_workspace, open_workspace <folder>")
        print("  Server:      reload, shutdown")
        print("  Tooltip:     tooltip, hide_tooltip, clear_tooltips")
        print("  Subgraph:    create_subgraph, toggle_collapse, expand_subgraph,")
        print("               ungroup_subgraph, rename_subgraph, set_subgraph_description")
        print("  CDP:         cdp_status, screenshot, viewport")
        sys.exit(1)

    action = args[0]
    arg = args[1] if len(args) > 1 else None

    result = call_api(action, arg)
    format_output(action, result, raw_json)


if __name__ == "__main__":
    main()
