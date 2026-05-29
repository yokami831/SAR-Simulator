"""HiyoCanvas process control: start, stop, status."""

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

import requests

# Auto-detect project root from script location:
# .claude/skills/hiyocanvas-bridge/scripts/ctl.py  (5 levels up)
PROJECT_DIR = str(Path(__file__).resolve().parents[4])
RUNTIME_FILE = Path(PROJECT_DIR) / ".hiyocanvas-runtime.json"


def discover_ports() -> dict:
    """Read resolved ports from the runtime file, falling back to legacy."""
    ports = {"server_port": 18731, "voice_port": 18733}
    try:
        if RUNTIME_FILE.exists():
            data = json.loads(RUNTIME_FILE.read_text(encoding="utf-8"))
            if data.get("server_port"):
                ports["server_port"] = data["server_port"]
            if data.get("voice_port"):
                ports["voice_port"] = data["voice_port"]
    except Exception:
        pass
    return ports


_PORTS = discover_ports()
SERVER_PORT = _PORTS["server_port"]
VOICE_PORT = _PORTS["voice_port"]
SERVER_URL = f"http://127.0.0.1:{SERVER_PORT}"
HEALTH_URL = f"{SERVER_URL}/api/health"
SHUTDOWN_URL = f"{SERVER_URL}/api/tools/shutdown"
STARTUP_TIMEOUT = 30  # seconds


def is_running() -> bool:
    """Return True only if HiyoCanvas itself answers /api/health."""
    try:
        r = requests.get(HEALTH_URL, timeout=2)
        if r.status_code != 200:
            return False
        return r.json().get("app") == "hiyocanvas"
    except Exception:
        return False


def _get_pids_on_port(port: int) -> list[int]:
    """Get PIDs listening on a given port (Windows)."""
    try:
        out = subprocess.check_output(
            f"netstat -ano | findstr :{port} | findstr LISTENING",
            shell=True, encoding="utf-8", timeout=5,
        )
        pids = set()
        for line in out.strip().splitlines():
            parts = line.split()
            if parts:
                pid = int(parts[-1])
                if pid > 0:
                    pids.add(pid)
        return list(pids)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return []


def _kill_stale_processes() -> bool:
    """Kill any stale processes on HiyoCanvas ports. Returns True if any were killed."""
    killed = False
    for port in (SERVER_PORT, VOICE_PORT):
        pids = _get_pids_on_port(port)
        for pid in pids:
            print(f"  Killing stale process on port {port}: PID {pid}")
            try:
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(pid)],
                    capture_output=True, timeout=5,
                )
                killed = True
            except Exception:
                pass
    if killed:
        time.sleep(2)  # Wait for sockets to release
    return killed


def start() -> None:
    if is_running():
        # Verified HiyoCanvas already up — nothing to do.
        print("HiyoCanvas is already running.")
        return

    # A confirmed-stale HiyoCanvas on the legacy port? Ask it to shut down
    # gracefully (Electron now shifts ports, so we do NOT blind-kill foreign
    # holders of 18731 — that may be an unrelated process).
    try:
        r = requests.get("http://127.0.0.1:18731/api/health", timeout=2)
        if r.status_code == 200 and r.json().get("app") == "hiyocanvas":
            print("Found stale HiyoCanvas on legacy port — requesting shutdown.")
            try:
                # Force-shutdown the stale instance: we are about to start a
                # fresh one so the dirty-guard would just block startup.
                requests.post(
                    "http://127.0.0.1:18731/api/tools/shutdown",
                    json={"force": True},
                    timeout=5,
                )
            except Exception:
                pass
            time.sleep(2)
    except Exception:
        pass

    env = dict(os.environ)
    env.pop("ELECTRON_RUN_AS_NODE", None)

    subprocess.Popen(
        ["npx", "electron", "."],
        cwd=PROJECT_DIR,
        env=env,
        shell=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    print("Starting HiyoCanvas...", end="", flush=True)
    for i in range(STARTUP_TIMEOUT):
        time.sleep(1)
        if is_running():
            print(f" OK ({i + 1}s)")
            return
        print(".", end="", flush=True)

    print(f" FAIL (timeout after {STARTUP_TIMEOUT}s)")
    sys.exit(1)


def stop(force: bool = False) -> None:
    if not is_running():
        print("HiyoCanvas is not running.")
        return

    body = {"force": True} if force else {}
    try:
        # Allow up to ~5s for the dirty-guard round-trip (frontend 2s + slack).
        r = requests.post(SHUTDOWN_URL, json=body, timeout=8)
    except Exception as e:
        print(f"Shutdown request failed: {e}")
        sys.exit(1)

    # Dirty-guard refusal: server returns 200 with success=false + dirty_tabs.
    try:
        data = r.json() if r.content else {}
    except ValueError:
        data = {}
    if isinstance(data, dict) and data.get("success") is False and data.get("dirty_tabs"):
        dirty = data.get("dirty_tabs", [])
        msg = data.get(
            "message",
            f"Shutdown refused: unsaved changes in {len(dirty)} workspace(s).",
        )
        print(msg)
        for t in dirty:
            title = t.get("title") or t.get("id") or "?"
            print(f"  - {title}")
        print("Save in HiyoCanvas (or use save_tab), or run: ctl.py stop --force")
        sys.exit(1)

    print(f"Shutdown request: {r.status_code}")

    print("Waiting for shutdown...", end="", flush=True)
    for i in range(10):
        time.sleep(1)
        if not is_running():
            print(f" done ({i + 1}s)")
            return
        print(".", end="", flush=True)

    print(" WARN: still running after 10s")
    sys.exit(1)


def status() -> None:
    if is_running():
        print("running")
    else:
        print("stopped")


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: ctl.py <start|stop [--force]|status|restart>")
        sys.exit(1)

    cmd = sys.argv[1]
    extra = sys.argv[2:]
    if cmd == "start":
        start()
    elif cmd == "stop":
        force = "--force" in extra
        stop(force=force)
    elif cmd == "status":
        status()
    elif cmd == "restart":
        # Restart implies discarding any pending work — keep parity with the
        # old behavior by forcing the shutdown side.
        stop(force=True)
        time.sleep(2)
        start()
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()
