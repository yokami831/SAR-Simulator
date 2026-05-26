# RINA経由テストプラン

RINAにチャットで操作を依頼し、Claude Code側でAPIで状態を検証する統合テスト。
RINA（voice-agent）がSKILL.mdに従い正しくAPI操作できるかの確認が主目的。

## 共通定義

```bash
API = python .claude/skills/hiyocanvas/scripts/canvas_api.py
PYTHON = .venv/Scripts/python.exe
BRIDGE = .claude/skills/hiyocanvas-bridge/scripts
```

## 実行者

- **操作**: Claude Code が `send_chat` でRINAに依頼
- **検証（ダブルチェック）**:
  1. **RINA検証**: RINAに「結果を確認してください」と依頼し、RINAが自分でget_elements等を実行して報告
  2. **Claude Code検証**: Claude Code（またはサブエージェント）が独立してAPIで状態を検証
  3. 両者の結果が一致すればPASS、不一致があればFAILとして詳細を記録
- **ユーザー**: 実行開始を指示するだけ。結果レポートを受け取る

## テスト実行手順（各TCごと）

1. `send_chat` でRINAに操作を依頼（tmp_chat.json経由）
2. 5秒待機 → `get_chat` で応答確認（未完了なら5秒ずつ再試行）
3. `send_chat` でRINAに結果確認を依頼（「今の状態を確認して報告してください」）
4. Claude Code側でもAPI（get_elements, get_element等）で独立検証
5. RINA報告 vs Claude Code検証を突き合わせ → PASS/FAIL判定
6. 結果を `references/rina-test-report-YYYY-MM-DD.md` に記録

## 試験実行ポリシー

- RINAの応答テキストも記録する（どういう手順で操作したかの確認）
- RINAがエラー報告した場合はそのまま記録し、根本原因を調査
- 小さなエラーで中断しない。FAIL記録して次へ
- 各セクション完了時にユーザーに中間報告
- **各セクション終了時にRINAにフィードバックを求める**: 「ここまでの操作で改善できるところや気づいた点があればコメントしてください」と依頼。RINAの改善提案はレポートに記録し、SKILL.mdの改善に活用する
- このテストの目的は動作確認だけでなく **SKILL/APIの改善点の発見**。ユーザーがRINAに依頼してスムーズに作業できることが最重要

---

## 1. マインドマップ操作

### RT-01: マインドマップ作成

**Send**: 「新しいマインドマップを開いて、「プログラミング言語」をテーマに作ってください。Python、JavaScript、Goの3つの分岐を作り、それぞれに2つずつサブトピックを追加してください。」

**Verify**:
1. `get_tabs` → mindmapタブが作成されアクティブ
2. `tab_action get_elements` → ルート「プログラミング言語」、3分岐、各2子ノード（計9ノード）
3. 各分岐のtopicが指示通り（Python, JavaScript, Go）

### RT-02: マインドマップ編集（追加+変更）

**Send**: 「Pythonに「データサイエンス」を3つ目のサブトピックとして追加し、Goの名前を「Golang」に変更してください。」

**Verify**:
1. `tab_action get_elements` → Python配下が3ノードに増加
2. Python配下に「データサイエンス」が存在
3. 「Go」が「Golang」に変更されている

### RT-03: マインドマップ削除

**Send**: 「JavaScriptのサブトピックを1つ削除してください。」

**Verify**:
1. `tab_action get_element` (JavaScript) → childCountが1に減少
2. 他の分岐（Python, Golang）は影響を受けていない

---

### RT-03F: マインドマップ セクションフィードバック

**Send**: 「ここまでマインドマップの作成、編集、削除をやってもらいましたが、操作の中で改善できるところや気づいた点があればコメントしてください。APIの使い勝手、エラーメッセージ、SKILL.mdの記述など何でも構いません。」

**Record**: RINAの改善提案をレポートに記録

---

## 2. Excalidraw作成

### RT-10: 複雑な図の作成

**Send**: 「Excalidrawで新しいタブを開いて、手書き風(roughness:1)でシステム構成図を描いてください。上から順に「User」「Web Server」「App Server」「Database」の4つのボックスを縦に並べ、それぞれ矢印でつないでください。User=灰色、Web Server=青、App Server=緑、Database=オレンジで色分けしてください。」

**Verify**:
1. `get_tabs` → excalidrawタブが作成されアクティブ
2. `tab_action get_elements` → rectangle 4個 + arrow 3個
3. 各rectangleのlabelが指示通り（User, Web Server, App Server, Database）
4. 色分け: strokeColorまたはbackgroundColorがそれぞれ異なる
5. `tab_action get_element` (任意の1つ) → roughness: 1

### RT-11: Excalidraw要素の編集

**Send**: 「Web Serverのボックスを「Nginx (Web Server)」に変更し、DatabaseのボックスをダイヤモンドDiamond形に変更してください。」

**Verify**:
1. `tab_action get_elements` → 「Nginx (Web Server)」のlabelを持つrectangleが存在
2. Databaseがtype: diamondに変更されている
3. 他の要素（User, App Server）は変更されていない

### RT-12: Excalidraw要素の追加

**Send**: 「App ServerとDatabaseの間に「Cache (Redis)」というボックスを赤色で追加し、App Server→Cache→Databaseの順に矢印でつなぎ直してください。」

**Verify**:
1. `tab_action get_elements` → 要素数が増加（Cache追加 + 矢印の変更）
2. 「Cache (Redis)」のlabelを持つ要素が存在
3. 矢印の接続が論理的に正しい（App Server→Cache→Database）

### RT-13: Excalidraw要素の削除

**Send**: 「Userのボックスとそこからの矢印を削除してください。」

**Verify**:
1. `tab_action get_elements` → Userが消えている
2. User関連の矢印も消えている
3. 他の要素（Nginx, App Server, Cache, Database）は残っている

---

### RT-13F: Excalidraw セクションフィードバック

**Send**: 「ここまでExcalidrawの作成、編集、追加、削除をやってもらいましたが、操作の中で改善できるところや気づいた点があればコメントしてください。」

**Record**: RINAの改善提案をレポートに記録

---

## 3. フロー操作

### RT-20: フロー作成と実行

**Send**: 「新しいフロータブを開いて、2つのPythonブロックを作ってください。1つ目は「Data Generator」で x=42, print(x) を実行。2つ目は「Calculator」で y=x*2, print(y) を実行。2つを接続して実行してください。」

**Verify**:
1. `get_tabs` → flowタブが作成されアクティブ
2. `get_elements` → 2ノード + 1エッジ
3. `get_execution_status` → 両ノードOK
4. `get_execution_result` (Calculator) → 出力に「84」

### RT-21: フロー編集

**Send**: 「Calculatorのコードを y=x*3, print(y) に変更して、再度実行してください。」

**Verify**:
1. `get_element` (Calculator) → codeに `y = x * 3` が含まれる
2. `get_execution_result` (Calculator) → 出力に「126」

### RT-22: ノードの無効化

**Send**: 「Data Generatorを無効化して実行してください。」

**Verify**:
1. `get_element` (Data Generator) → enabled: false
2. `get_execution_status` → Data GeneratorがSKIPPED

**Send**: 「Data Generatorを有効に戻してください。」

**Verify**: `get_element` → enabled: true

---

### RT-22F: フロー セクションフィードバック

**Send**: 「ここまでフローの作成、実行、編集、無効化をやってもらいましたが、操作の中で改善できるところや気づいた点があればコメントしてください。」

**Record**: RINAの改善提案をレポートに記録

---

## 4. タブ間操作

### RT-30: 複数タブの切り替え

**Pre**: RT-01〜RT-20で3つのタブ（mindmap, excalidraw, flow）が存在

**Send**: 「マインドマップのタブに切り替えて、現在の内容を教えてください。」

**Verify**:
1. `get_tabs` → マインドマップタブがアクティブ
2. RINAの応答にRT-01〜RT-03の操作結果が反映された内容が含まれる

**Send**: 「Excalidrawのタブに戻してください。」

**Verify**: `get_tabs` → excalidrawタブがアクティブ

---

## 5. エラーハンドリング

### RT-40: 存在しない要素の操作

**Send**: 「Excalidrawで要素ID「nonexistent-123」を削除してください。」

**Verify**:
1. RINAがエラーを報告する（「見つかりませんでした」等）
2. `tab_action get_elements` → 要素数が変わっていない

### RT-41: 不正な操作

**Send**: 「マインドマップのルートノードを削除してください。」

**Verify**:
1. RINAがエラーを報告する（「ルートは削除できません」等）
2. `tab_action get_elements` → データが保持されている

---

## 6. RINAの自律判断

### RT-50: 曖昧な指示への対応

**Send**: 「今開いているタブの内容をもう少し良くしてください。」

**Verify**:
1. RINAが現在のタブの状態を確認（get_elements等）
2. 何らかの改善提案または実行を行う
3. 操作後の状態が壊れていない（get_elementsで確認）

---

### RT-50F: 全体フィードバック

**Send**: 「全てのテストが終わりました。マインドマップ、Excalidraw、フロー、タブ切り替え、エラーハンドリングを一通り試しましたが、全体を通して改善すべき点、ユーザーがスムーズに使うためにSKILL.mdやAPIに足りないもの、あると便利な機能などを総括してコメントしてください。」

**Record**: RINAの総括コメントをレポートに記録。SKILL.md改善タスクとして整理

---

## テスト実行順序

1. **マインドマップ**: RT-01 → RT-03 → RT-03F（フィードバック）
2. **Excalidraw**: RT-10 → RT-13 → RT-13F（フィードバック）
3. **フロー**: RT-20 → RT-22 → RT-22F（フィードバック）
4. **タブ間操作**: RT-30
5. **エラーハンドリング**: RT-40 → RT-41
6. **自律判断**: RT-50 → RT-50F（全体総括フィードバック）

## 後処理

1. 全テスト用タブを閉じる
2. `$PYTHON $BRIDGE/ctl.py stop` でHiyoCanvas終了
