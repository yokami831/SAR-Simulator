# Mindmap Tab

## Overview

MindElixir ベースのマインドマップワークスペース。ノードの追加/編集/削除、方向切替、ズーム操作が可能。

## Registration

- **ID**: `mindmap`
- **Label**: Mind Map
- **Icon**: 🧠
- **DataKey**: `mindmapData`
- **File Extension**: `.rcmind`
- **Toolbar**: MindmapToolbar (フローティング)

## UI Components

- **Canvas**: mind-elixir v5
- **Style Panel**: ノード選択時に左オーバーレイ表示（Text/BG/Branch カラー設定）
- **Context Menu**: 独自右クリックメニュー

## Toolbar (MindmapToolbar)

フローティング配置（キャンバス上部中央）:

| Button | Action |
|--------|--------|
| ≡ Menu | Save / Save As |
| Zoom In | 拡大 (scale 1.2) |
| Zoom Out | 縮小 (scale 0.8) |
| Center | 中央に移動 |
| Both Sides | 両側展開 (direction=SIDE) |
| Right | 右展開 (direction=RIGHT) |
| Left | 左展開 (direction=LEFT) |

## Tool Actions (AI操作)

| Action | Description |
|--------|-------------|
| get_elements | マインドマップデータ全体を取得 |
| set_data | データ全体を置換 |
| get_element | 特定ノードを取得 |
| add_element | ノード追加 |
| remove_element | ノード削除 |
| update_element | ノード更新（topic, expanded等） |
| get_selection | 選択中のノードを取得 |

## 特記事項

- **折りたたみ状態の保存**: `ensureExpandedField()` で全ノードに明示的な `expanded` フィールドを付与して保存。MindElixir の `getData()` は展開ノードの `expanded` を省略するため、これがないと再読み込み時に全展開される。
- **自動展開の無効化**: patch-package で `moveNodeIn` 時の強制展開コードを削除済み。
- **スペルチェック**: patch-package で `contentEditable="true"` に変更済み。
- **グローバルインスタンス**: `window.__mindElixirInstance` 経由でツールバーやtool actionsからアクセス。

## 保存データ

```json
{
  "type": "mindmap",
  "mindmapData": {
    "nodeData": {
      "id": "root",
      "topic": "Root Topic",
      "children": [...],
      "expanded": true
    },
    "arrows": [],
    "direction": 2,
    "theme": { ... }
  }
}
```
