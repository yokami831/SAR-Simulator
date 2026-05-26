"""Custom LiveKit LLM plugin using Claude Agent SDK (Python).

Wraps ClaudeSDKClient to provide streaming text responses via
LiveKit's LLM interface. Claude Agent SDK handles tool execution
(Read/Write/Edit/Bash/Glob/Grep etc.) internally.

Uses persistent ClaudeSDKClient connection to avoid CLI startup
overhead on each query (~1.1s savings).

Based on Claude-Agent-SDK/backend/claude_llm_plugin.py (simplified: no emotion tags, no language switching).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Any

from livekit.agents import llm
from livekit.agents.types import (
    DEFAULT_API_CONNECT_OPTIONS,
    NOT_GIVEN,
    APIConnectOptions,
    FlushSentinel,
    NotGivenOr,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Backend selection
# ---------------------------------------------------------------------------
# "sdk" : claude-agent-sdk (ClaudeSDKClient) — persistent connection, ~1.1s faster per query
#         Requires claude-agent-sdk package. Auth via API key or subscription (CLAUDE_AGENT_SDK_AUTH).
# "cli" : claude CLI subprocess — uses `claude --print` directly.
#         No API key required — uses `claude login` subscription as-is.
#         ~1.1s slower per query (CLI startup overhead).
#         System prompt is written to a temp text file and passed via `--system-prompt-file <file>`.
#         (--append-system-prompt with a long prompt exceeds Windows cmd line limits ~32KB)
#         SKILLs supported via "Skill" in CLI_ALLOWED_TOOLS.
CLAUDE_BACKEND: str = "cli"  # "sdk" | "cli"

# CLI mode: allowed tools (only used when CLAUDE_BACKEND == "cli")
# Add "Skill" here to enable SKILL support (.claude/skills/ in cwd).
CLI_ALLOWED_TOOLS: list[str] = [
    "Read",
    "Glob",
    "Grep",
    "Bash(python*canvas_api.py*)",
    "Bash(python*-c*narrator*)",
    "Bash(python*-c*urllib*)",
    "Skill",
]


class ClaudeAgentLLM(llm.LLM):
    """LiveKit LLM that delegates to Claude Agent SDK or claude CLI."""

    def __init__(
        self,
        *,
        system_prompt: str = "",
        bridge: Any = None,
        cwd: str | None = None,
    ) -> None:
        super().__init__()
        self._system_prompt = system_prompt
        self._bridge = bridge
        self._cwd = cwd
        self._client: Any = None  # ClaudeSDKClient (persistent, sdk mode only)
        self._system_prompt_file: Path | None = None  # CLI mode: temp file for --settings
        self._project_root = Path(cwd or ".")
        self._is_resume = False

    def _get_app_state_path(self) -> Path:
        """Get app-state.json path for the currently active workspace.

        Reads app-config.json to find lastWorkspacesDir, falling back to
        the default workspaces/ folder if not set.
        """
        try:
            config_path = self._project_root / "app-config.json"
            if config_path.exists():
                cfg = json.loads(config_path.read_text(encoding="utf-8"))
                ws_dir = cfg.get("lastWorkspacesDir")
                if ws_dir:
                    return Path(ws_dir) / "app-state.json"
        except (json.JSONDecodeError, OSError):
            pass
        return self._project_root / "workspaces" / "app-state.json"

    def _load_session_id(self) -> str | None:
        """Load saved session_id from app-state.json."""
        path = self._get_app_state_path()
        try:
            if path.exists():
                state = json.loads(path.read_text(encoding="utf-8"))
                return state.get("chat_session_id")
        except (json.JSONDecodeError, OSError):
            pass
        return None

    def _save_session_id(self, session_id: str) -> None:
        """Save session_id to app-state.json."""
        path = self._get_app_state_path()
        try:
            state = {}
            if path.exists():
                state = json.loads(path.read_text(encoding="utf-8"))
            state["chat_session_id"] = session_id
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8"
            )
        except OSError:
            logger.exception("Failed to save session_id")

    @property
    def is_resume(self) -> bool:
        return self._is_resume

    async def connect(self) -> None:
        """Initialize backend connection."""
        session_id = self._load_session_id()
        self._is_resume = session_id is not None
        if session_id:
            logger.info(f"Resuming session: {session_id[:20]}...")

        if CLAUDE_BACKEND == "sdk":
            await self._connect_sdk(session_id)
        else:
            # CLI mode: stateless, no persistent connection needed
            logger.info("Claude CLI mode: no persistent connection (stateless)")

    async def _connect_sdk(self, session_id: str | None) -> None:
        """Create and connect persistent ClaudeSDKClient (sdk mode)."""
        os.environ["CLAUDE_AGENT_SDK_SKIP_VERSION_CHECK"] = "1"
        os.environ.pop("CLAUDECODE", None)
        from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

        options = ClaudeAgentOptions(
            system_prompt=self._system_prompt,
            permission_mode="default",
            allowed_tools=[
                "Read",
                "Write",
                "Edit",
                "Glob",
                "Grep",
                "Bash(python*canvas_api.py*)",
            ],
            include_partial_messages=True,
            model=os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6"),
            thinking={"type": "disabled"},
            cwd=self._cwd,
            setting_sources=["user", "project", "local"],
            resume=session_id,
        )
        self._client = ClaudeSDKClient(options)
        await self._client.connect()
        logger.info("ClaudeSDKClient connected")

    async def send_greeting(self, bridge: Any) -> None:
        """Send initial greeting query to UI (also serves as warmup)."""
        if self._is_resume:
            prompt = (
                "The user has returned. Greet them briefly in English. "
                "Do not repeat previous conversation content."
            )
        else:
            prompt = "This is a new user. Introduce yourself briefly in English."

        if CLAUDE_BACKEND == "sdk":
            await self._send_greeting_sdk(bridge, prompt)
        else:
            await self._send_greeting_cli(bridge, prompt)

    async def _send_greeting_sdk(self, bridge: Any, prompt: str) -> None:
        """Send greeting via SDK (sdk mode)."""
        if not self._client:
            return
        try:
            await self._client.query(prompt)
            full_text = ""
            async for message in self._client.receive_response():
                msg_type = type(message).__name__
                if msg_type == "StreamEvent":
                    event = message.event
                    if event.get("type") == "content_block_delta":
                        delta = event.get("delta", {})
                        if delta.get("type") == "text_delta":
                            text = delta.get("text", "")
                            if text:
                                clean = ClaudeAgentLLMStream._sanitize_for_tts(text)
                                if clean:
                                    full_text += clean
                elif msg_type == "ResultMessage":
                    if message.session_id:
                        self._save_session_id(message.session_id)

            if full_text:
                bridge.send_message_start()
                bridge.send_text_delta(full_text)
                bridge.send_message_end()
            logger.info(f"Greeting sent ({len(full_text)} chars)")
        except Exception:
            logger.exception("Greeting query failed")

    def _clean_env(self) -> dict[str, str]:
        """Return a clean environment for CLI subprocess.

        Removes Electron/Claude-specific variables that interfere with
        spawning a nested ``claude`` CLI process.
        """
        env = os.environ.copy()
        for key in [
            "CLAUDECODE", "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ASAR",
            "ELECTRON_EXTRA_LAUNCH_ARGS", "NODE_OPTIONS",
            "ANTHROPIC_API_KEY",  # Force Pro subscription instead of API billing
        ]:
            env.pop(key, None)
        # Force UTF-8 for Python subprocesses spawned by Claude CLI (canvas_api.py etc.)
        # Without this, Windows uses CP932 and Japanese characters are corrupted.
        env["PYTHONUTF8"] = "1"
        return env

    async def _send_greeting_cli(self, bridge: Any, prompt: str) -> None:
        """Send greeting via CLI subprocess (cli mode)."""
        try:
            cmd = self._build_cli_cmd()
            env = self._clean_env()
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,  # prompt fed via stdin for UTF-8 safety
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                cwd=self._cwd,
                limit=4 * 1024 * 1024,  # 4MB readline buffer (default 64KB too small)
            )
            # Write prompt to stdin as UTF-8 and close
            if proc.stdin:
                proc.stdin.write(prompt.encode("utf-8"))
                await proc.stdin.drain()
                proc.stdin.close()
            full_text = ""
            async for raw in proc.stdout:
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                event_type = event.get("type")
                # stream-json wraps API events: {"type":"stream_event","event":{...}}
                if event_type == "stream_event":
                    inner = event.get("event", {})
                    if inner.get("type") == "content_block_delta":
                        delta = inner.get("delta", {})
                        if delta.get("type") == "text_delta":
                            text = delta.get("text", "")
                            if text:
                                clean = ClaudeAgentLLMStream._sanitize_for_tts(text)
                                if clean:
                                    full_text += clean
                elif event_type == "result":
                    new_session_id = event.get("session_id")
                    if new_session_id:
                        self._save_session_id(new_session_id)

            await proc.wait()
            if proc.returncode != 0:
                stderr = await proc.stderr.read()
                raise RuntimeError(
                    f"claude CLI exited with {proc.returncode}: {stderr.decode()[:200]}"
                )

            if full_text:
                bridge.send_message_start()
                bridge.send_text_delta(full_text)
                bridge.send_message_end()
            logger.info(f"Greeting sent via CLI ({len(full_text)} chars)")
        except Exception:
            logger.exception("Greeting query (CLI) failed")

    def _ensure_system_prompt_file(self) -> Path:
        """Write system prompt to a temp file and return its path.

        The file is created once and reused across calls. It contains the
        raw system prompt text, passed to ``claude --system-prompt-file <path>``.
        """
        if self._system_prompt_file and self._system_prompt_file.exists():
            return self._system_prompt_file
        fd, path = tempfile.mkstemp(suffix=".txt", prefix="claude_sp_")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(self._system_prompt)
        self._system_prompt_file = Path(path)
        logger.info(f"[CLI] System prompt written to {path}")
        return self._system_prompt_file

    def _build_cli_cmd(self) -> list[str]:
        """Build the claude CLI command for a query.

        On Windows, ``claude`` is installed as a ``.CMD`` batch file via npm.
        ``.CMD`` files require ``cmd.exe /c`` to execute — they cannot be
        launched directly by ``create_subprocess_exec``.

        Prompt is passed via stdin (not -p) to preserve UTF-8 on Windows.
        cmd.exe /c mangles non-ASCII characters in command-line arguments.
        """
        claude_path = shutil.which("claude") or "claude"
        sp_file = self._ensure_system_prompt_file()
        args = [
            claude_path,
            "--print",
            "--output-format", "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--model", os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6"),
            "--system-prompt-file", str(sp_file),
            "--allowedTools", ",".join(CLI_ALLOWED_TOOLS),
        ]
        # Working directory is set via create_subprocess_exec(cwd=), not CLI flag
        session_id = self._load_session_id()
        if session_id:
            args += ["--resume", session_id]
        # Prompt is fed via stdin — do NOT add -p here
        # Windows: .CMD files need cmd.exe /c to execute
        if claude_path.upper().endswith((".CMD", ".BAT")):
            return ["cmd.exe", "/c"] + args
        return args

    async def disconnect(self) -> None:
        """Disconnect backend and clean up temp files."""
        if CLAUDE_BACKEND == "sdk" and self._client:
            await self._client.disconnect()
            self._client = None
            logger.info("ClaudeSDKClient disconnected")
        # Clean up CLI mode temp file
        if self._system_prompt_file and self._system_prompt_file.exists():
            try:
                self._system_prompt_file.unlink()
                logger.info(f"[CLI] Cleaned up temp file: {self._system_prompt_file}")
            except OSError:
                pass
            self._system_prompt_file = None

    @property
    def model(self) -> str:
        return f"claude-{CLAUDE_BACKEND}"

    @property
    def provider(self) -> str:
        return f"anthropic-{CLAUDE_BACKEND}"

    def chat(
        self,
        *,
        chat_ctx: llm.ChatContext,
        tools: list[llm.Tool] | None = None,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
        parallel_tool_calls: NotGivenOr[bool] = NOT_GIVEN,
        tool_choice: NotGivenOr[llm.ToolChoice] = NOT_GIVEN,
        extra_kwargs: NotGivenOr[dict[str, Any]] = NOT_GIVEN,
    ) -> llm.LLMStream:
        return ClaudeAgentLLMStream(
            self,
            chat_ctx=chat_ctx,
            tools=tools or [],
            conn_options=conn_options,
        )


class ClaudeAgentLLMStream(llm.LLMStream):
    """Streams text from Claude (SDK or CLI) into LiveKit's LLMStream protocol."""

    def __init__(
        self,
        llm_instance: ClaudeAgentLLM,
        *,
        chat_ctx: llm.ChatContext,
        tools: list[llm.Tool],
        conn_options: APIConnectOptions,
    ) -> None:
        super().__init__(
            llm_instance,
            chat_ctx=chat_ctx,
            tools=tools,
            conn_options=conn_options,
        )
        self._request_id = str(uuid.uuid4())
        self._text_buffer = ""
        self._full_response = ""

    @staticmethod
    def _make_flush() -> FlushSentinel:
        """Create FlushSentinel with attributes for LiveKit metrics compatibility."""
        flush = FlushSentinel()
        flush.id = "flush"  # type: ignore[attr-defined]
        flush.delta = None  # type: ignore[attr-defined]
        flush.usage = None  # type: ignore[attr-defined]
        return flush

    @staticmethod
    def _sanitize_for_tts(text: str) -> str:
        """Strip emojis, markdown, and other TTS-unfriendly characters."""
        # Remove emojis
        text = re.sub(
            r"[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF"
            r"\U0001F1E0-\U0001F1FF\U00002600-\U000026FF\U00002700-\U000027BF"
            r"\U0001F900-\U0001F9FF\U0001FA00-\U0001FAFF\U0000200D\U000020E3]+",
            "", text,
        )
        # Remove parenthesized technical details e.g. (n100), (0.08s)
        text = re.sub(r"\s*\([^)]*\)", "", text)
        # Remove markdown bold/italic
        text = re.sub(r"\*+", "", text)
        # Remove markdown headers
        text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
        # Remove arrow notation (→)
        text = re.sub(r"\s*→\s*", " to ", text)
        return text

    def _extract_user_text(self) -> str:
        """Extract the latest user message from chat context."""
        for msg in reversed(self._chat_ctx.items):
            role = getattr(msg, "role", None)
            if role == "user":
                content = getattr(msg, "content", "")
                if isinstance(content, str):
                    return content
                elif isinstance(content, list):
                    for block in content:
                        if isinstance(block, str) and block.strip():
                            return block.strip()
                        elif hasattr(block, "text") and block.text:
                            return block.text
                break

        # Fallback: system/developer messages (from generate_reply instructions)
        for msg in reversed(self._chat_ctx.items):
            role = getattr(msg, "role", None)
            content = getattr(msg, "content", "")
            if role in ("system", "developer"):
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, str) and block.strip():
                            return block.strip()
                        elif hasattr(block, "text") and block.text:
                            return block.text
                elif isinstance(content, str) and content.strip():
                    return content.strip()
        return ""

    async def _run(self) -> None:
        """Dispatch to SDK or CLI backend."""
        if CLAUDE_BACKEND == "sdk":
            await self._run_sdk()
        else:
            await self._run_cli()

    # ------------------------------------------------------------------
    # SDK backend
    # ------------------------------------------------------------------

    async def _run_sdk(self) -> None:
        """Stream responses via Claude Agent SDK."""
        import time
        client = self._llm._client
        if not client:
            logger.error("ClaudeSDKClient not connected")
            return

        user_text = self._extract_user_text()
        if not user_text:
            logger.warning("No message found in chat context, items: %s",
                          [(getattr(m, 'role', '?'), str(getattr(m, 'content', ''))[:50]) for m in self._chat_ctx.items])
            return

        t_start = time.perf_counter()
        logger.info(f"Claude SDK query: {user_text[:100]}...")

        bridge = self._llm._bridge
        message_started = False
        try:
            await client.query(user_text)
            t_query = time.perf_counter()
            logger.info(f"[TIMING] query() sent: {t_query - t_start:.3f}s")
            first_text = True

            _tool_blocks: dict[int, dict] = {}  # index -> {"id", "name"}

            async for message in client.receive_response():
                msg_type = type(message).__name__
                if msg_type == "StreamEvent":
                    event = message.event
                    event_type = event.get("type")

                    if event_type == "content_block_delta":
                        delta = event.get("delta", {})
                        if delta.get("type") == "text_delta":
                            text = delta.get("text", "")
                            if text:
                                if first_text:
                                    logger.info(f"[TIMING] first text_delta: {time.perf_counter() - t_start:.3f}s")
                                    first_text = False
                                    if bridge and not message_started:
                                        bridge.send_message_start()
                                        message_started = True
                                self._text_buffer += text
                                # Hold buffer while inside parentheses (they may span chunks)
                                if "(" in self._text_buffer and ")" not in self._text_buffer:
                                    continue
                                if self._text_buffer:
                                    clean = self._sanitize_for_tts(self._text_buffer)
                                    self._text_buffer = ""
                                    if clean:
                                        self._full_response += clean
                                        self._event_ch.send_nowait(
                                            llm.ChatChunk(
                                                id=self._request_id,
                                                delta=llm.ChoiceDelta(
                                                    content=clean,
                                                    role="assistant",
                                                ),
                                            )
                                        )
                                        if bridge:
                                            bridge.send_text_delta(clean)

                    elif event_type == "content_block_start":
                        content_block = event.get("content_block", {})
                        if content_block.get("type") == "tool_use":
                            idx = event.get("index", -1)
                            info = {"id": content_block.get("id", ""), "name": content_block.get("name", "")}
                            _tool_blocks[idx] = info
                            # Flush any buffered text to TTS before tool execution
                            if self._text_buffer:
                                clean = self._sanitize_for_tts(self._text_buffer)
                                self._text_buffer = ""
                                if clean:
                                    self._full_response += clean
                                    self._event_ch.send_nowait(
                                        llm.ChatChunk(
                                            id=self._request_id,
                                            delta=llm.ChoiceDelta(
                                                content=clean,
                                                role="assistant",
                                            ),
                                        )
                                    )
                                    if bridge:
                                        bridge.send_text_delta(clean)
                            # Send FlushSentinel so TTS sentence tokenizer
                            # synthesizes buffered text immediately
                            self._event_ch.send_nowait(self._make_flush())
                            if bridge:
                                bridge.broadcast({"type": "tool_status", "name": info["name"], "status": "running"})

                    elif event_type == "content_block_stop":
                        idx = event.get("index", -1)
                        if idx in _tool_blocks:
                            info = _tool_blocks.pop(idx)
                            if bridge:
                                bridge.broadcast({"type": "tool_status", "name": info["name"], "status": "done"})

                elif msg_type == "ResultMessage":
                    logger.info(f"[TIMING] response complete: {time.perf_counter() - t_start:.3f}s")
                    if message.session_id:
                        self._llm._save_session_id(message.session_id)
                    if bridge:
                        bridge.send_message_end()
                        message_started = False

        except asyncio.CancelledError:
            logger.info("LLM stream cancelled (barge-in)")
            await client.interrupt()
            try:
                async for _ in client.receive_response():
                    pass
            except Exception:
                logger.debug("Error draining interrupted response", exc_info=True)
            raise
        except Exception as e:
            logger.error(f"Claude Agent SDK error: {e}")
            raise
        finally:
            if message_started and bridge:
                bridge.send_message_end()

    # ------------------------------------------------------------------
    # CLI backend
    # ------------------------------------------------------------------

    async def _run_cli(self) -> None:
        """Stream responses via claude CLI subprocess."""
        import time

        user_text = self._extract_user_text()
        if not user_text:
            logger.warning("No message found in chat context, items: %s",
                          [(getattr(m, 'role', '?'), str(getattr(m, 'content', ''))[:50]) for m in self._chat_ctx.items])
            return

        t_start = time.perf_counter()
        logger.info(f"Claude CLI query: {user_text[:100]}...")

        bridge = self._llm._bridge
        message_started = False
        proc: asyncio.subprocess.Process | None = None

        try:
            cmd = self._llm._build_cli_cmd()
            env = self._llm._clean_env()
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,  # prompt fed via stdin for UTF-8 safety
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                cwd=self._llm._cwd,
                limit=4 * 1024 * 1024,  # 4MB readline buffer (default 64KB too small for --include-partial-messages)
            )
            # Write prompt to stdin as UTF-8 and close
            if proc.stdin:
                proc.stdin.write(user_text.encode("utf-8"))
                await proc.stdin.drain()
                proc.stdin.close()

            first_text = True
            _tool_blocks: dict[int, dict] = {}

            async for raw in proc.stdout:
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue

                event_type = event.get("type")

                # stream-json wraps API events in {"type":"stream_event","event":{...}}
                # See: https://code.claude.com/docs/en/headless
                if event_type == "stream_event":
                    inner = event.get("event", {})
                    inner_type = inner.get("type")
                    if inner_type == "content_block_delta":
                        delta = inner.get("delta", {})
                        if delta.get("type") == "text_delta":
                            text = delta.get("text", "")
                            if text:
                                if first_text:
                                    logger.info(f"[TIMING] first text_delta: {time.perf_counter() - t_start:.3f}s")
                                    first_text = False
                                    if bridge and not message_started:
                                        bridge.send_message_start()
                                        message_started = True
                                self._text_buffer += text
                                # Hold buffer while inside parentheses (they may span chunks)
                                if "(" in self._text_buffer and ")" not in self._text_buffer:
                                    continue
                                if self._text_buffer:
                                    clean = self._sanitize_for_tts(self._text_buffer)
                                    self._text_buffer = ""
                                    if clean:
                                        self._full_response += clean
                                        self._event_ch.send_nowait(
                                            llm.ChatChunk(
                                                id=self._request_id,
                                                delta=llm.ChoiceDelta(
                                                    content=clean,
                                                    role="assistant",
                                                ),
                                            )
                                        )
                                        if bridge:
                                            bridge.send_text_delta(clean)

                    elif inner_type == "content_block_start":
                        content_block = inner.get("content_block", {})
                        if content_block.get("type") == "tool_use":
                            idx = inner.get("index", -1)
                            info = {"id": content_block.get("id", ""), "name": content_block.get("name", "")}
                            _tool_blocks[idx] = info
                            # Flush any buffered text to TTS before tool execution
                            if self._text_buffer:
                                clean = self._sanitize_for_tts(self._text_buffer)
                                self._text_buffer = ""
                                if clean:
                                    self._full_response += clean
                                    self._event_ch.send_nowait(
                                        llm.ChatChunk(
                                            id=self._request_id,
                                            delta=llm.ChoiceDelta(
                                                content=clean,
                                                role="assistant",
                                            ),
                                        )
                                    )
                                    if bridge:
                                        bridge.send_text_delta(clean)
                            # Send FlushSentinel so TTS sentence tokenizer
                            # synthesizes buffered text immediately
                            self._event_ch.send_nowait(self._make_flush())
                            if bridge:
                                bridge.broadcast({"type": "tool_status", "name": info["name"], "status": "running"})

                    elif inner_type == "content_block_stop":
                        idx = inner.get("index", -1)
                        if idx in _tool_blocks:
                            info = _tool_blocks.pop(idx)
                            if bridge:
                                bridge.broadcast({"type": "tool_status", "name": info["name"], "status": "done"})

                elif event_type == "result":
                    logger.info(f"[TIMING] response complete: {time.perf_counter() - t_start:.3f}s")
                    new_session_id = event.get("session_id")
                    if new_session_id:
                        self._llm._save_session_id(new_session_id)
                    if bridge:
                        bridge.send_message_end()
                        message_started = False

            await proc.wait()
            if proc.returncode != 0:
                stderr = await proc.stderr.read()
                raise RuntimeError(
                    f"claude CLI exited with {proc.returncode}: {stderr.decode()[:200]}"
                )

        except asyncio.CancelledError:
            logger.info("LLM stream cancelled (barge-in)")
            if proc and proc.returncode is None:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=3.0)
                except asyncio.TimeoutError:
                    proc.kill()
            raise
        except Exception as e:
            logger.error(f"Claude CLI error: {e}")
            raise
        finally:
            if message_started and bridge:
                bridge.send_message_end()