# HiyoCanvas

React Flowベースのビジュアルノードエディタ。Electron + FastAPI + Jupyter Kernelで構成。
ノードにPythonコードを書き、エッジで実行順序を定義してフローを実行できる。

## Features

- **ビジュアルフローエディタ** — React Flowベースのノード/エッジキャンバス
- **Jupyter Kernel実行** — ノードのPythonコードをIPythonカーネルで順次実行
- **リッチ表示** — print出力、matplotlib画像、pandas HTML表をノード上に表示
- **タブ/ワークスペース** — 複数フローをタブで管理、各ワークスペースに自動保存
- **AIターミナル** — タブごとに独立したClaude Codeターミナル
- **CLI API** — `canvas_api.py` で全操作をコマンドラインから実行可能
- **カスタムブロック** — JSONでブロック定義を追加可能

## Requirements

- **Windows 11** (Windows 10でも動作する可能性あり)
- **Python 3.10+**: venv環境を自動構築
- **Node.js** (v18+): Electron用

### Optional (for specific block types)

- **gcc** (MinGW/MSYS2): C言語ブロックのコンパイル・実行に必要。`winget install MSYS2.MSYS2` でインストール後、`C:\msys64\ucrt64\bin` をPATHに追加
- **sdfcad**: SDF 3D Modelingブロックに必要。`pip install sdfcad` で自動インストール済み（requirements.txt に記載）

## Quick Start

```bat
start.bat
```

初回起動時に `.venv` の作成、pip install、npm install、フロントエンドビルドが自動実行されます。
Electronウィンドウが起動し、HiyoCanvasが表示されます。
ウィンドウを閉じると全プロセス（FastAPI等）が自動停止します。

## Architecture

```
src/main.js               ← Electron main process
frontend/                  ← ソースコード（Viteでビルド → dist/）
  js/app.tsx               ← メインApp + タブ管理 + Undo/Redo
  js/components.tsx        ← ノードUI + 実行結果表示
dist/                      ← Viteビルド出力（FastAPIが配信）
backend/                   ← FastAPI + WebSocket + Jupyter Kernel
  server.py                ← API endpoints
  plugins/python_canvas/
    kernel.py              ← IPythonカーネル管理
    flow_executor.py       ← トポロジカルソート + 順次実行
    blocks/                ← ブロック定義（JSON）
.claude/skills/hiyocanvas/scripts/canvas_api.py  ← CLI API wrapper (in SKILL)
```

## Configuration

HiyoCanvasには2種類の設定ファイルがあります。

### ワークスペースフォルダ固有設定: `app-state.json`

ワークスペースフォルダ内（例: `workspaces/app-state.json`）に配置します。
フォルダを切り替えると設定も自動的に切り替わります。
ファイルが存在しない場合はデフォルト値が使われます。手動で作成してください。

```json
{
  "chatEnabled": false
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `chatEnabled` | boolean | `true` | AIチャットパネルの表示。`false` でチャットパネルとエッジタブを非表示にする |

**AIチャットを無効にする手順:**
1. ワークスペースフォルダ（デフォルト: `workspaces/`）内の `app-state.json` を開く（なければ作成）
2. `"chatEnabled": false` を追加
3. アプリを再起動

### アプリ全体設定: `app-config.json`

プロジェクトルートに固定配置。ワークスペースフォルダとは独立した設定です。
通常は自動管理されるため手動編集は不要です。

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `lastWorkspacesDir` | string | `workspaces/` | 最後に使ったワークスペースフォルダのパス。起動時に自動復元される |

## Install (zip配布版)

1. zipを解凍
2. `start.bat` をダブルクリック
3. 初回は自動セットアップ（venv作成、pip install、npm install、フロントエンドビルド）が走ります。数分かかります。
4. 2回目以降は数秒で起動します

### Update (既存環境をアップデートする場合)

新しいzipで上書き解凍し、以下を実行:
```bat
npm install
npm run build
start.bat
```

`npm install` は新しいパッケージが追加された場合に必要です。`npm run build` でフロントエンドをリビルドします。
`npm install` 実行時に `patch-package` が自動でライブラリパッチを適用します（`postinstall` スクリプト）。

## Patches (node_modules の修正)

`patches/` フォルダに `patch-package` で管理されたパッチがあります。`npm install` 時に自動適用されます。

| パッチ | 内容 |
|--------|------|
| `mind-elixir+5.9.2.patch` | (1) ノードを折りたたんだ親にドロップした時の自動展開を無効化 (2) ノード編集時のスペルチェックを有効化 |

## Development

```bat
npm run dev          # Vite dev server (localhost:5173) + HMR
npm run build        # プロダクションビルド → dist/
```

## Claude Code Integration

HiyoCanvas はClaude Codeからスキル経由で操作可能です。詳細は以下を参照：
- `references/api_reference.md` — 全REST APIエンドポイント
- `references/blocks.md` — ブロック定義フォーマット
- `references/troubleshooting.md` — よくある問題と解決策
