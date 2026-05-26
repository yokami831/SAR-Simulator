# Files Tab

## Overview

SVAR FileManager ベースのファイルエクスプローラー。複数ルートフォルダ対応、ファイルオープン履歴、戻る/進むナビゲーション。

## Registration

- **ID**: `files`
- **Label**: Files
- **Icon**: 📁
- **DataKey**: `filesData`
- **File Extension**: `.rcfiles`
- **Toolbar**: null

## UI Components

- **FileManager**: @svar-ui/react-filemanager v2.5.0 (WillowDark テーマ)
- **Navigation Bar**: React レンダリング（← → ボタン）、SVAR の上に配置
- **History Panel**: 右サイドバー（リサイズ可能）
- **Tree Sidebar**: SVAR 内蔵（ドラッグリサイズ対応、DOM注入ハンドル）

## レイアウト

```
[← → | パンくず]                   ← React nav bar
[Add New | Tree | File List]        ← SVAR FileManager (table mode)
                          [History] ← 右サイドパネル
```

SVAR の上部ツールバー（Files | Search | ビュー切替）は CSS で非表示。

## マルチルートフォルダ

- `filesData.rootFolders: [{name, path}]` で複数フォルダを管理
- SVAR ツリーのルート "/" 直下に各フォルダが並ぶ
- SVAR の "Add New" メニューに「Add Root Folder...」を追加（menuOptions + handler）
- ルートフォルダ名にパンくずで絶対パスを括弧表示
- 異なるルート間のファイル移動/コピーはブロック
- ルートフォルダ自体のリネーム/削除もブロック
- 旧形式 `rootFolder` (単一) からの自動マイグレーション

## パス変換

SVAR は `/` ルートのスラッシュ区切り ID を使用。Windows 絶対パスとの変換:
- `toSvarId(rootFolders, absPath)` → `/<rootName>/<relative>`
- `toAbsPath(rootFolders, svarId)` → `D:\path\to\file`
- `rootPathForSvarId(rootFolders, svarId)` → IPC バリデーション用ルートパス

## ナビゲーション

- **戻る/進む**: `navHistory` ref で履歴管理、`set-path` イベントで記録
- **マウスボタン**: button 3 (戻る) / button 4 (進む) 対応
- **ツリー連動**: `set-path` 時に `open-tree-folder` で親フォルダを自動展開
- **孫プリロード**: フォルダ展開時 (`request-data`) と移動時 (`set-path`) に子フォルダの1階層下もプリロード（ツリー矢印表示のため）

## ファイルオープン履歴

- 最大200件、FIFO、パスで重複排除
- フィルタ: All / Excel / Word / PDF / Image
- 各エントリに × 削除ボタン（常時表示）
- ダブルクリックで再オープン

## ファイル操作 (Electron IPC)

全操作は Electron main process の IPC ハンドラ経由。`isWithinRoot()` でパストラバーサル防止。

| Operation | IPC Channel | 実装 |
|-----------|-------------|------|
| ディレクトリ一覧 | fs-list-dir | fs.promises.readdir + stat |
| フォルダ作成 | fs-create-folder | fs.promises.mkdir |
| リネーム | fs-rename-item | fs.promises.rename |
| コピー | fs-copy-items | fs.promises.cp (recursive) |
| 移動 | fs-move-items | fs.promises.rename |
| 削除 | fs-trash-items | shell.trashItem() (ゴミ箱) |
| ファイルを開く | fs-open-file | shell.openPath() |

## Tool Actions (AI操作)

| Action | Description |
|--------|-------------|
| get_elements | カレントディレクトリ内容 or 履歴 |
| open_file | ファイルをシステムアプリで開く |
| list_history | オープン履歴取得 |
| navigate | 指定パスに移動 |
| set_data | filesData 全体更新 |

## 保存データ

```json
{
  "type": "files",
  "filesData": {
    "rootFolders": [
      { "name": "ProjectA", "path": "D:\\Work\\ProjectA" }
    ],
    "history": [
      { "path": "D:\\Work\\file.txt", "name": "file.txt", "ext": "txt", "openedAt": "ISO" }
    ]
  }
}
```
