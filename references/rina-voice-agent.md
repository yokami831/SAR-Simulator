# RINA Voice Agent

## Overview

RINA は HiyoCanvas のリアルタイム音声AIアシスタント。LiveKit + Claude Agent SDK で構成。音声入力/テキスト入力の両方に対応し、HiyoCanvas のキャンバスを操作できる。

## Architecture

```
RINA Voice Agent (port 18733 — デフォルト。シフトする場合あり、`.hiyocanvas-runtime.json` の `voice_port` 参照)
  ├── LiveKit Audio I/O
  │     ├── STT: Deepgram
  │     ├── TTS: Groq
  │     └── VAD: Silero
  ├── ClaudeAgentLLM (Claude SDK Client)
  │     └── Tools: Bash, Read, Grep, Glob 等 (Claude Code と同等)
  └── WebSocket Bridge
        └── chat UI とのテキスト通信
```

## ファイル構成

| File | Purpose |
|------|---------|
| voice-agent/agent.py | メインエージェントエントリポイント |
| voice-agent/bridge.py | WebSocket ブリッジ (chat UI ↔ agent) |
| voice-agent/claude_llm_plugin.py | Claude SDK 統合 |

## 通信方式

### 音声入力
User speaks → Deepgram STT → Claude LLM → tool_use (canvas操作) → TTS response

### テキスト入力
Chat UI → WebSocket bridge → Claude LLM → tool_use → WebSocket → Chat UI

### キャンバス操作
RINA は canvas_api.py を bash ツール経由で呼び出し、HiyoCanvas を操作可能。

## バックエンド選択

| Mode | 設定 | 特徴 |
|------|------|------|
| CLI | `CLAUDE_BACKEND="cli"` | Claude CLI サブプロセス（デフォルト、APIキー不要） |
| SDK | `CLAUDE_BACKEND="sdk"` | Claude Agent SDK（永続接続、~1.1s高速） |

## CDP 経由の操作

RINA との対話は CDP (Chrome DevTools Protocol) 経由でも可能:

```powershell
# メッセージ送信
'{"text":"Hello RINA!"}' | python canvas_api.py send_chat

# メッセージ取得
'{"count":5}' | python canvas_api.py get_chat
```

内部実装: DOMのチャットテキストエリアに値を設定し、送信ボタンをクリック。

## 起動

Electron main process が FastAPI 起動後に自動的に voice-agent を起動。`agent.py` が存在しない場合はスキップ。

## 設定

| 設定 | 値 |
|------|------|
| ポート | 18733 (VOICE_AGENT_PORT) — デフォルト。使用中ならシフト、`.hiyocanvas-runtime.json` の `voice_port` 参照 |
| 設定場所 | backend/config.py |

## 注意事項

- agent.py がない環境では自動スキップ（エラーにならない）
- チャットパネルの表示/非表示は `app-state.json` の `chatEnabled` で制御
