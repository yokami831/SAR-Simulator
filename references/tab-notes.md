# Notes Tab

## Overview

BlockNote ベースのリッチテキストエディタ。Notion風のブロックエディタで、複数ページ・フォルダ管理に対応。

## Registration

- **ID**: `notes`
- **Label**: Notes
- **Icon**: 📝
- **DataKey**: `notesData`
- **File Extension**: `.rcnotes`
- **Toolbar**: null

## UI Components

- **Editor**: @blocknote/react v0.47.3 (BlockNote)
- **Sidebar**: NotesSidebar (ページ/フォルダリスト、ドラッグ並替、右クリックメニュー)
- **Hamburger Menu**: サイドバーの + Page / + Folder ボタン左に ≡ ボタン

## ハンバーガーメニュー

NotesSidebar 内に配置:
- **Save** (Ctrl+S)
- **Save As...** (Ctrl+Shift+S)

## サイドバー機能

- ページ追加 (+ Page)
- フォルダ追加 (+ Folder)
- ドラッグ＆ドロップで並べ替え
- フォルダ内にページを移動
- 右クリックメニュー: Rename, Delete, Move to Folder
- リサイズハンドル（幅変更可能）

## Tool Actions (AI操作)

| Action | Description |
|--------|-------------|
| get_elements | ページ一覧を取得 |
| get_element | 特定ページの内容を取得 |
| add_element | 新規ページ作成 |
| remove_element | ページ削除 |
| update_element | ページ更新（タイトル/内容） |
| set_data | notesData 全体を置換 |

## 画像アップロード (notes_router.py)

| Endpoint | Description |
|----------|-------------|
| POST /api/notes/upload | 画像アップロード (multipart form) |
| GET /api/notes/assets/{workspace}/{filename} | 画像配信 |

- 対応形式: png, jpg, gif, webp, svg, bmp
- 保存先: `<workspace名>_materials/` フォルダ
- パストラバーサル防止あり

## 特記事項

- **自動タイトル**: 新規ページの最初の見出しブロックが自動的にページタイトルになる
- **ライブ更新パターン**: `_liveUpdater` モジュールレベル ref で tool actions からリアルタイムUI更新

## 保存データ

```json
{
  "type": "notes",
  "notesData": {
    "pages": [
      { "id": "uuid", "title": "Page Title", "createdAt": "...", "updatedAt": "...", "folderId": "..." }
    ],
    "folders": [
      { "id": "uuid", "title": "Folder Name", "collapsed": false }
    ],
    "content": {
      "page-uuid": [ /* BlockNote blocks */ ]
    },
    "activePageId": "page-uuid"
  }
}
```
