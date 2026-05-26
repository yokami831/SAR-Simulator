# Flow Tab — FPGA/HDL Extension

## Overview

Flow タブの拡張機能。Amaranth HDL でハードウェアモジュールをシミュレーションし、Python 参照実装と比較検証する。HiyoCanvas の Jupyter Kernel 上で動作。

## 関連ドキュメント

- `hdl_simulation.md` — HDL シミュレーション手順（Amaranth FIR フィルタ）
- `fft_design_spec.md` — FFT 設計仕様 + HIL 実験結果
- `gui_widget_nodes_spec.md` — GUI ウィジェットノード仕様（未実装）

## 必要パッケージ

```bash
uv pip install amaranth fxpmath
```

## HDL/DSP カスタムブロック

`backend/plugins/python_canvas/blocks/user/` に配置:
- HDL シミュレーション用ブロック
- 信号処理用ブロック (FFT, FIR等)

## ワークフロー

```
[テスト入力生成] → [Python FIR (float)] → [遅延挿入] → [比較プロット]
       ↓                                                    ↑
[固定小数点変換] → [Amaranth FIR (sim)] ────────────────────┘
```

1. Python で浮動小数点参照実装（理想動作）
2. Amaranth でクロックレベルシミュレーション（実機同等）
3. 遅延挿入で位相合わせ、差分 = 量子化誤差のみを確認

## FFT 実装

SDF (Single-path Delay Feedback) パイプライン方式:
- N=256 HIL テスト PASS
- タイミングクロージャ pending (WNS=-4.7ns)

詳細は `archive/fft_design_spec.md` 参照。

## VCD ビューア (vcd_router.py)

HDL シミュレーション結果の波形表示:

| Endpoint | Description |
|----------|-------------|
| GET /api/vcd/signals?file=path | VCD ファイルの信号一覧 |
| POST /api/vcd/open | Surfer 波形ビューアを起動 |

パストラバーサル防止あり。
