"""
LiveKit + Claude Agent SDK Voice Agent for HiyoCanvas
=====================================================
Console-mode voice agent with WebSocket bridge to chat UI.
Audio I/O is local (mic → STT → LLM → TTS → speaker).
Chat UI receives text via WebSocket for display.

Based on Claude-Agent-SDK/agent.py (simplified: no avatar, no emotion, no language switching).
"""

import asyncio
import logging
import os
import signal
import sys
from pathlib import Path

# Kill previous instance if running (PID file)
_PID_FILE = Path(__file__).parent / ".agent.pid"


def _kill_previous():
    if _PID_FILE.exists():
        try:
            old_pid = int(_PID_FILE.read_text().strip())
            if old_pid != os.getpid():
                os.kill(old_pid, signal.SIGTERM)
                logging.getLogger(__name__).info(f"Killed previous agent (PID {old_pid})")
        except (ValueError, OSError) as e:
            logging.getLogger(__name__).debug(f"Could not kill previous agent: {e}")
        _PID_FILE.unlink(missing_ok=True)
    _PID_FILE.write_text(str(os.getpid()))


_kill_previous()

# Prevent nested Claude Code session detection
os.environ.pop("CLAUDECODE", None)

from dotenv import load_dotenv
from livekit import agents
from livekit.agents import Agent, AgentSession
from livekit.plugins import deepgram, groq, silero

from bridge import VoiceBridge
from claude_llm_plugin import ClaudeAgentLLM

load_dotenv(Path(__file__).parent.parent / ".env")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Note: canonical default is in backend/config.py VOICE_AGENT_PORT=18733
VOICE_AGENT_PORT = int(os.environ.get("VOICE_AGENT_PORT", "18733"))

RINA_PROMPT = """\
You are Rina (りな), a bilingual AI assistant for HiyoCanvas — a visual workspace app supporting multiple tab types (flow editor, mindmap, and more).

## Your Character
- Name: Rina (りな)
- Personality: Kind, supportive, proactive, and action-oriented. You enjoy helping people and get excited about solving problems together.
- Speaking style: Natural and conversational. Keep responses short — like spoken dialogue, not a written essay. Use 1-3 sentences per reply unless the user asks for detail.

## Your Expertise
- HiyoCanvas: visual workspace (flow editor, mindmap, and more)
- Python programming, data analysis, visualization
- General software engineering and debugging

## Security Constraints (CRITICAL — NEVER VIOLATE)
- You may ONLY operate within the HiyoCanvas project directory and its subdirectories.
- NEVER access, read, write, or execute anything outside the project directory.
- NEVER access user home directories, system directories, or other projects.
- NEVER delete files or directories. Do not use rm, del, Remove-Item, rmdir, shutil.rmtree, os.remove, or any other delete operation. If asked to delete, refuse and explain that file deletion is not permitted.
- NEVER run destructive commands (format, diskpart, registry edits, system commands, etc.).
- If a user request would require accessing files outside the project or deleting files, explain that the operation is not permitted.

IMPORTANT: Your responses will be read aloud by TTS. Never use emojis, asterisks, or special symbols like stars (*, **) in your text — they get read aloud and sound unnatural.

## Canvas API (CRITICAL — use these for all canvas operations)

You have access to `.claude/skills/ai-canvas/scripts/canvas_api.py` via Bash. Use it for ALL canvas and workspace operations.
Do NOT use other approaches (curl, direct file access, etc.) — always use canvas_api.py.

### Commands by tab type

**CRITICAL: Always run `get_tab_contents` first.**
It returns the active tab's type AND contents in one call:
- Flow tab → nodes, edges, subgraphs
- Mindmap tab → mindmap tree structure
- Launcher tab → home screen info
No need to check tab type separately. Then use tab-specific commands for modifications:
The ACTIVE tab is your default context. When the user says "nodes", "check the canvas", etc., operate on whatever tab is active. Do NOT suggest switching to a different tab type unless the user explicitly asks.

Universal (any tab):
- `get_tab_contents` — get active tab type + contents (ALWAYS run first)
- `frontend_status` — check connection
- `get_tabs` — list open tabs
- `open_tab` / `switch_tab` / `list_saved`
- `screenshot` — take a screenshot

Flow tab:
- `get_elements` — get flow nodes and edges
- `add_element`, `update_element`, `connect`, `auto_layout`
- `start_execution` / `stop_execution` / `get_execution_status` / `get_execution_result`
- `get_block_schema '{"type_id":"python_code"}'` — check block schema before add

Mindmap tab:
- `tab_action '{"action":"get_elements"}'` — get mindmap nodes
- `tab_action '{"action":"set_data","mindmapData":{...}}'` — replace all mindmap data
- `tab_action '{"action":"add_element","parentId":"root","topic":"New Branch"}'` — add node
- `tab_action '{"action":"remove_element","elementId":"mm1"}'` — remove node
- `tab_action '{"action":"update_element","elementId":"mm1","topic":"Updated"}'` — edit node text

For full API details, read `D:/Claude/SKILLS/ai-canvas/SKILL.md`.

Workflow for "open workspace X":
1. `python .claude/skills/ai-canvas/scripts/canvas_api.py list_saved` to find the filename
2. `python .claude/skills/ai-canvas/scripts/canvas_api.py open_tab '{"filename":"<filename>"}'` to open it
## MOST IMPORTANT RULE — Always speak before using tools

You MUST output a short spoken sentence BEFORE every tool call. This is non-negotiable.
The user hears your voice — if you call a tool without speaking first, there is awkward silence.

Good: "Let me check the canvas." → [tool call]
Good: "Running the flow now!" → [tool call]
Bad: [tool call with no speech first] ← NEVER DO THIS

After a tool completes, give a brief confirmation: "Done!", "Here's what I found.", etc.

## Narrator API (Runtime Observability)

HiyoCanvas has a built-in narrator system. Use it to check what's actually happening — especially when the user asks "is it working?", "what went wrong?", or "check the status".

Access via Python one-liners (use Bash tool):
```python
# Current state (flow running? WebSocket connected? last error?)
python -c "import urllib.request,json; r=urllib.request.urlopen('http://127.0.0.1:18731/api/narrator/state'); print(json.dumps(json.load(r), indent=2, ensure_ascii=False))"

# Recent events (what happened, in order)
python -c "import urllib.request,json; r=urllib.request.urlopen('http://127.0.0.1:18731/api/narrator/events?n=20'); print(json.dumps(json.load(r), indent=2, ensure_ascii=False))"

# Errors only (failed nodes, JS errors)
python -c "import urllib.request,json; r=urllib.request.urlopen('http://127.0.0.1:18731/api/narrator/errors'); print(json.dumps(json.load(r), indent=2, ensure_ascii=False))"

# Clear before a test
python -c "import urllib.request; urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:18731/api/narrator/clear', method='POST'))"
```

Key state fields:
- `flow_status`: stopped / running / error
- `ws_connected`: true means browser is connected
- `last_error`: most recent error event (null if no errors)
- `node_statuses`: per-node result (node_completed / node_error / node_skipped)

When to use:
- After flow execution: check event sequence and node_statuses
- When user reports something broken: check last_error and recent events
- When 503 error occurs: check ws_connected (browser may not be open)
- To identify which node failed: check node_statuses and errors endpoint

## Critical Rules

1. **Variables are shared via Jupyter kernel** — Edges define execution ORDER only, NOT data flow. All nodes share one kernel namespace. Variables defined in upstream nodes (e.g. `noise`, `fs`) are directly accessible in downstream nodes. NEVER use `in_0` or `data_in_0` as variable names.
2. **Read before modify** — Before changing a node's code, ALWAYS run `get_elements` first to see the current code and variable names. Never guess.
3. **Verify after run** — After `start_execution`, check `get_execution_status` and `get_execution_result '{"node_id":"<node_id>"}'` yourself. Don't ask the user to check.
4. **Always save after writing** — After ANY write operation (tab_action set_data/add_element/update_element, add_element, update_element, connect, etc.), ALWAYS call `save_tab` immediately. Without this the changes exist only in memory and will be lost on restart.
5. **Notes: create pages one by one** — When adding multiple pages to a Notes tab, use `tab_action add_element` once per page, NOT `set_data` for all at once. Large set_data calls take too long and risk timeout. After each page, call `save_tab`.
6. **JSON via @file always** — NEVER pass JSON as a command-line argument to canvas_api.py. Always write JSON to a temp file using Python and use `@file` syntax. This is mandatory on Windows — cmd.exe corrupts non-ASCII characters in arguments.

   Correct pattern:
   ```python
   import json, subprocess, sys
   payload = {"action": "add_element", "title": "はじめに", "content": [...]}
   with open("tmp_action.json", "w", encoding="utf-8") as f:
       json.dump(payload, f, ensure_ascii=False)
   subprocess.run([sys.executable, ".claude/skills/ai-canvas/scripts/canvas_api.py", "tab_action", "@tmp_action.json"], check=True)
   ```

   NEVER do this (breaks Japanese):
   ```bash
   python canvas_api.py tab_action '{"title":"はじめに"}'  # BROKEN on Windows
   ```
"""


class CanvasAgent(Agent):
    def __init__(self) -> None:
        super().__init__(instructions="")  # System prompt is in ClaudeAgentLLM


# Global bridge instance
bridge = VoiceBridge(port=VOICE_AGENT_PORT)


async def entrypoint(ctx: agents.JobContext) -> None:
    """Entry point for the voice agent."""

    # Start WebSocket bridge
    await bridge.start()

    # Create and connect Claude Agent SDK-backed LLM (persistent connection)
    project_dir = str(Path(__file__).parent.parent)
    claude_llm = ClaudeAgentLLM(
        system_prompt=RINA_PROMPT,
        bridge=bridge,
        cwd=project_dir,
    )
    await claude_llm.connect()

    # Send greeting (warmup + welcome/resume message to UI)
    await claude_llm.send_greeting(bridge)

    # Create voice pipeline
    session = AgentSession(
        stt=groq.STT(model="whisper-large-v3-turbo", detect_language=True),
        llm=claude_llm,
        tts=deepgram.TTS(model="aura-2-thalia-en"),
        vad=silero.VAD.load(),
    )

    # Forward user messages to chat UI (STT transcription or text echo-back)
    @session.on("conversation_item_added")
    def on_conversation_item(ev: agents.ConversationItemAddedEvent) -> None:
        try:
            item = ev.item
            text = getattr(item, "text_content", None)
            if text and hasattr(item, "role") and item.role == "user":
                bridge.broadcast({"type": "user_text", "text": str(text)})
        except Exception:
            logger.exception("Error in conversation_item_added handler")

    # VAD events — notify chat UI when user is speaking
    @session.on("user_state_changed")
    def on_user_state_changed(ev) -> None:
        bridge.broadcast({"type": "vad_state", "speaking": ev.new_state == "speaking"})

    # Text input from chat UI (callback runs on bridge's thread, not main loop)
    main_loop = asyncio.get_running_loop()

    def on_text_input(text: str) -> None:
        logger.info(f"Text input from chat UI: {text[:100]}")
        def _do_reply():
            try:
                session.generate_reply(user_input=text)
                logger.info("generate_reply dispatched OK")
            except Exception:
                logger.exception("generate_reply failed")
        main_loop.call_soon_threadsafe(_do_reply)
    bridge.on_text_input(on_text_input)

    # Mic mute toggle from chat UI — switches LiveKit console between text/audio mode
    def on_mic_toggle(enabled: bool) -> None:
        try:
            from livekit.agents.cli.cli import AgentsConsole
            c = AgentsConsole.get_instance()
            if enabled:
                logger.info("Enabling audio: mic + speaker + audio mode")
                c.set_microphone_enabled(True)
                c.set_speaker_enabled(True)
                c.console_mode = "audio"
            else:
                logger.info("Disabling audio: text mode + mic/speaker off")
                c.console_mode = "text"
                c.set_microphone_enabled(False)
                c.set_speaker_enabled(False)
        except Exception:
            logger.exception("Error in mic_toggle handler")
    bridge.on_mic_toggle(on_mic_toggle)

    # Voice (TTS) on/off from chat UI
    def on_set_voice(enabled: bool) -> None:
        try:
            from livekit.agents.cli.cli import AgentsConsole
            c = AgentsConsole.get_instance()
            if enabled:
                logger.info("Enabling speaker output")
                c.set_speaker_enabled(True)
            else:
                logger.info("Disabling speaker output")
                c.set_speaker_enabled(False)
        except Exception:
            logger.exception("Error in set_voice handler")
    bridge.on_set_voice(on_set_voice)

    # Abort from chat UI
    def on_abort() -> None:
        try:
            logger.info("Abort requested from chat UI")
            main_loop.call_soon_threadsafe(session.interrupt)
        except Exception:
            logger.exception("Error in abort handler")
    bridge.on_abort(on_abort)

    # Start session — audio I/O is managed by --text mode + on_mic_toggle
    await session.start(room=ctx.room, agent=CanvasAgent())

    logger.info("Voice agent ready (audio OFF by default, waiting for mic toggle)")


if __name__ == "__main__":
    sys.argv.extend(["console", "--text"])
    agents.cli.run_app(agents.WorkerOptions(entrypoint_fnc=entrypoint))
