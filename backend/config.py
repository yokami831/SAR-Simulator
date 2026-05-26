"""Centralized configuration constants for HiyoCanvas.

All port numbers and network addresses are defined here.
Backend modules should import from this module instead of hardcoding values.
Frontend receives these values via the /api/config endpoint.

Ports are env-aware: Electron main.js resolves free ports at startup (shifting
up from the preferred number if taken) and passes them to the backend via
HIYOCANVAS_SERVER_PORT / HIYOCANVAS_CDP_PORT / HIYOCANVAS_VOICE_PORT.
"""

import os

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

LOCALHOST = "127.0.0.1"

# ---------------------------------------------------------------------------
# Ports (env-aware — see module docstring)
# ---------------------------------------------------------------------------

SERVER_PORT = int(os.environ.get("HIYOCANVAS_SERVER_PORT", "18731"))       # FastAPI + static frontend
VOICE_AGENT_PORT = int(os.environ.get("HIYOCANVAS_VOICE_PORT", "18733"))   # voice-agent (LiveKit + Claude Agent SDK)
CDP_PORT = int(os.environ.get("HIYOCANVAS_CDP_PORT", "9222"))              # Chrome DevTools Protocol debug port
CDP_MAX_MSG_SIZE = 50 * 1024 * 1024  # CDP WebSocketの最大メッセージサイズ (50MB)

# App identity — used by /api/health so external consumers can verify they
# reached HiyoCanvas (not some other process holding a shifted port).
APP_NAME = "hiyocanvas"

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

import json
import logging
import socket
from datetime import datetime, timezone
from pathlib import Path

_logger = logging.getLogger(__name__)

# Project root directory
PROJECT_ROOT = Path(__file__).parent.parent

# Runtime discovery file (written by Electron main.js after the server is
# health-verified, deleted on graceful shutdown). External consumers
# (canvas_api.py, ctl.py, check.py) read it to find the active port.
RUNTIME_FILE = PROJECT_ROOT / ".hiyocanvas-runtime.json"


# ---------------------------------------------------------------------------
# Dynamic port discovery
# ---------------------------------------------------------------------------


def find_free_port(preferred: int, max_tries: int = 50) -> int:
    """Return the first bindable port starting at ``preferred``.

    Probes ports by binding (no SO_REUSEADDR) on (LOCALHOST, port). The first
    port that binds successfully is returned. Shifts up by 1 each time the
    preferred port is taken. Raises RuntimeError if no port in the range
    [preferred, preferred + max_tries) is free.
    """
    for port in range(preferred, preferred + max_tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind((LOCALHOST, port))
            except OSError:
                continue
            return port
    raise RuntimeError(
        f"No free port found in range [{preferred}, {preferred + max_tries})"
    )


def write_runtime_file(server_port: int, cdp_port: int, voice_port: int | None = None) -> None:
    """Write the runtime discovery file with the resolved ports."""
    data = {
        "app": APP_NAME,
        "pid": os.getpid(),
        "started": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "server_port": server_port,
        "cdp_port": cdp_port,
        "voice_port": voice_port,
        "server_url": f"http://{LOCALHOST}:{server_port}",
    }
    RUNTIME_FILE.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def delete_runtime_file() -> None:
    """Delete the runtime discovery file (no-op if absent)."""
    try:
        if RUNTIME_FILE.exists():
            RUNTIME_FILE.unlink()
    except OSError as exc:
        _logger.warning("Failed to delete runtime file %s: %s", RUNTIME_FILE, exc)

# Default workspaces directory
_DEFAULT_WORKSPACES_DIR = PROJECT_ROOT / "workspaces"
_workspaces_dir = _DEFAULT_WORKSPACES_DIR

# Legacy constant — kept for import compatibility but prefer get_workspaces_dir()
WORKSPACES_DIR = _DEFAULT_WORKSPACES_DIR


def get_workspaces_dir() -> Path:
    """Get the current workspaces directory."""
    return _workspaces_dir


def set_workspaces_dir(path: Path) -> None:
    """Set the workspaces directory and update the legacy constant."""
    global _workspaces_dir, WORKSPACES_DIR
    _workspaces_dir = path
    WORKSPACES_DIR = path
    _logger.info("Workspaces directory set to: %s", path)


# ---------------------------------------------------------------------------
# App Config (project root — independent of workspace folder)
# ---------------------------------------------------------------------------

APP_CONFIG_PATH = PROJECT_ROOT / "app-config.json"


def read_app_config() -> dict:
    """Read app-wide config from project root."""
    if APP_CONFIG_PATH.exists():
        try:
            return json.loads(APP_CONFIG_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def write_app_config(data: dict) -> None:
    """Write app-wide config to project root."""
    APP_CONFIG_PATH.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def restore_workspaces_dir() -> None:
    """Restore workspaces directory from app-config.json on startup."""
    cfg = read_app_config()
    saved = cfg.get("lastWorkspacesDir")
    if saved:
        p = Path(saved)
        if p.is_dir():
            set_workspaces_dir(p)
            _logger.info("Restored workspaces dir from app-config: %s", p)
        else:
            _logger.warning("Saved workspaces dir not found, using default: %s", _DEFAULT_WORKSPACES_DIR)

# ---------------------------------------------------------------------------
# Feature Flags
# ---------------------------------------------------------------------------

_FEATURE_DEFAULTS: dict[str, bool] = {"fpga": False, "rina": False}


def get_feature_flags() -> dict[str, bool]:
    """Read feature flags from app-config.json, defaulting to disabled."""
    cfg = read_app_config()
    features = cfg.get("features", {})
    return {k: features.get(k, v) for k, v in _FEATURE_DEFAULTS.items()}


def is_feature_enabled(name: str) -> bool:
    """Check if a specific feature flag is enabled."""
    return get_feature_flags().get(name, False)


# ---------------------------------------------------------------------------
# WebSocket Command
# ---------------------------------------------------------------------------

WS_COMMAND_TIMEOUT = 5.0          # フロントエンドへのコマンド送信タイムアウト（秒）
FLOW_EXECUTION_TIMEOUT = 300.0    # フロー実行全体のタイムアウト（秒）

# ---------------------------------------------------------------------------
# Buffer Limits
# ---------------------------------------------------------------------------

MAX_FRONTEND_ERRORS = 20    # フロントエンドエラーバッファの最大件数
MAX_CONSOLE_LOGS = 500      # コンソールログバッファの最大件数

# ---------------------------------------------------------------------------
# File Format
# ---------------------------------------------------------------------------

FLOWGRAPH_EXTENSION = ".rcflow"   # フローグラフファイルの拡張子

# ---------------------------------------------------------------------------
# Kernel Timeouts（秒）
# ---------------------------------------------------------------------------

KERNEL_STARTUP_TIMEOUT = 10       # カーネル起動待ちタイムアウト
KERNEL_EXECUTION_TIMEOUT = None    # コード実行タイムアウト（None=無制限、STOPで中断）
KERNEL_SHELL_MSG_TIMEOUT = 30      # シェルメッセージ取得タイムアウト（実行完了後のreply取得）
KERNEL_IOPUB_MSG_TIMEOUT = 1      # IOPubメッセージ取得タイムアウト（短くしてストリーミング応答性向上）

# ---------------------------------------------------------------------------
# Voice Bridge Timeouts（秒）
# ---------------------------------------------------------------------------

VOICE_BRIDGE_STARTUP_TIMEOUT = 10  # VoiceBridge起動待ちタイムアウト
VOICE_BRIDGE_SHUTDOWN_TIMEOUT = 5  # VoiceBridge停止待ちタイムアウト

# ---------------------------------------------------------------------------
# Output Truncation
# ---------------------------------------------------------------------------

OUTPUT_TRUNCATE_FULL = 5000        # 実行結果の出力/エラー切り詰め（WebSocketブロードキャスト用）
OUTPUT_TRUNCATE_SUMMARY = 500      # プラグインステータスの要約切り詰め（get_status用）
RESULT_VALUE_TRUNCATE = 1000       # result_value 切り詰め

# ---------------------------------------------------------------------------
# Development
# ---------------------------------------------------------------------------

VITE_DEV_PORT = 5173               # Vite dev server ポート（npm run dev 用）
