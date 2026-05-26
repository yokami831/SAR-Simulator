# Excalidraw Tab (Drawing)

## Overview

Excalidraw ベースの手書きドローイング。図形、テキスト、矢印等を自由に配置。Mermaid ダイアグラムのインポート機能あり。

## Registration

- **ID**: `excalidraw`
- **Label**: Drawing
- **Icon**: ✏️
- **DataKey**: `excalidrawData`
- **File Extension**: `.rcexcalidraw`
- **Toolbar**: null (Excalidraw 内蔵UIを使用)

## UI Components

- **Canvas**: @excalidraw/excalidraw v0.18.0
- **MainMenu**: Excalidraw 内蔵ハンバーガーメニューに Save/Save As を追加
- **Mermaid Import**: 右上の「Mermaid」ボタンからダイアログ

## ハンバーガーメニュー

Excalidraw の MainMenu コンポーネントで拡張:
- **Save** (Ctrl+S) — `window.__hiyoSave()`
- **Save As...** (Ctrl+Shift+S) — `window.__hiyoSaveAs()`
- Toggle Theme (Excalidraw標準)
- Change Canvas Background (Excalidraw標準)

## Tool Actions (AI操作)

| Action | Description |
|--------|-------------|
| get_elements | 全要素を取得 |
| set_data | データ全体を置換 |
| get_element | 特定要素を取得 |
| add_element | 要素追加 |
| remove_element | 要素削除 |
| update_element | 要素更新 |
| clear | 全要素クリア |
| get_selection | 選択中の要素を取得 |
| import_mermaid | Mermaid構文をインポート |
| import_structure | 構造データをインポート |

## 特記事項

- **ダークテーマ**: `THEME.DARK` 固定
- **無効化された機能**: loadScene, export, saveAsImage, saveToActiveFile, saveFileToDisk
- **グローバルAPI**: `window.__excalidrawAPI` 経由でtool actionsからアクセス
- **右ドラッグパン**: 右クリックドラッグでキャンバス移動（カスタム実装）

## 保存データ

```json
{
  "type": "excalidraw",
  "excalidrawData": {
    "elements": [...]
  }
}
```
