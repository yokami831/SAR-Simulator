# HiyoCanvas Reference Documentation

## 読む順番

1. **[architecture.md](architecture.md)** — まずここから。アプリ全体の構造、プラグインシステム、データフロー、状態管理、設計原則
2. タブ別仕様（必要なものだけ）:
   - **[tab-flow.md](tab-flow.md)** — Flow タブ（ノードエディタ、実行エンジン）
   - **[tab-mindmap.md](tab-mindmap.md)** — Mindmap タブ
   - **[tab-excalidraw.md](tab-excalidraw.md)** — Excalidraw タブ（Drawing）
   - **[tab-notes.md](tab-notes.md)** — Notes タブ（BlockNote エディタ）
   - **[tab-files.md](tab-files.md)** — Files タブ（ファイルエクスプローラー）
   - **[tab-flow-fpga.md](tab-flow-fpga.md)** — Flow FPGA/HDL 拡張
3. **[api_reference.md](api_reference.md)** — REST API 正式リファレンス（全エンドポイント詳細）
4. **[skill-api.md](skill-api.md)** — AI 操作ガイド（Claude Code / 外部ツールからの使い方）
5. **[rina-voice-agent.md](rina-voice-agent.md)** — RINA ボイスエージェント
6. 補助ドキュメント:
   - **[blocks.md](blocks.md)** — ブロック定義フォーマット
   - **[rich_display.md](rich_display.md)** — リッチ HTML/3D 表示テンプレート
   - **[troubleshooting.md](troubleshooting.md)** — トラブルシューティング

## ファイルマップ

```
references/
  INDEX.md              ← このファイル（入口）
  architecture.md       ← 共通アーキテクチャ・設計原則
  tab-flow.md           ← Flow タブ仕様
  tab-mindmap.md        ← Mindmap タブ仕様
  tab-excalidraw.md     ← Excalidraw タブ仕様
  tab-notes.md          ← Notes タブ仕様
  tab-files.md          ← Files タブ仕様
  tab-flow-fpga.md      ← FPGA/HDL 拡張
  api_reference.md      ← REST API 正式リファレンス
  skill-api.md          ← AI 操作ガイド（使い方）
  rina-voice-agent.md   ← RINA ボイスエージェント
  blocks.md             ← ブロック定義フォーマット
  rich_display.md       ← リッチ表示テンプレート
  troubleshooting.md    ← トラブルシューティング
  archive/              ← 旧仕様書（RadioCanvas 時代含む、参考用）
```

## ドキュメントの役割分担

| ドキュメント | 役割 |
|-------------|------|
| architecture.md | **設計思想・全体構造** — プラグインシステム、データフロー、状態管理、設計原則 |
| tab-*.md | **タブ別実装仕様** — 各タブの UI、ツールバー、データ形式、tool actions |
| api_reference.md | **API 正式仕様** — 全エンドポイントの詳細（パラメータ、レスポンス例） |
| skill-api.md | **使い方ガイド** — Claude Code / 外部ツールからの操作手順 |

## リストラクチャリング時の既知課題

以下は現状の設計上の課題。リファクタリング時に検討すべき事項:

1. **Flow タブのプラグイン化**: Flow だけ app.tsx にハードコード。他タブは自己登録パターン
2. **toolActions の API パス不統一**: Flow は `/api/tools/add_element`、他は `tab_action` 経由
3. **グローバル変数への依存**: `window.__hiyoSave`, `window.__excalidrawAPI`, `window.__mindElixirInstance` — Context/EventBus への置換候補
4. **1ファイルに全タブデータ同居**: ワークスペース JSON に複数タブタイプのデータが入る設計
5. **app.tsx の肥大化**: Flow 固有ロジックが大量に残っている
