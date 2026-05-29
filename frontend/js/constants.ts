/**
 * constants.ts — Centralized constants for timing, colors, and UI configuration
 *
 * Node layout constants (widths, heights, gaps) are in utils.ts.
 * This file covers everything else: animation durations, delays, colors, etc.
 */

// ===== Animation Durations (ms) =====

export const ANIM_PAN_DURATION = 300;       // setCenter カメラ移動アニメーション
export const ANIM_FIT_VIEW_DURATION = 400;  // fitView 全体表示アニメーション
export const ANIM_ZOOM_DURATION = 300;      // zoomTo ズームアニメーション

// ===== UI Delays (ms) =====

export const DELAY_FIT_VIEW = 50;           // レイアウト変更後、fitView実行前の待ち時間
export const DELAY_RESIZE_EVENT = 320;      // パネル開閉後のCSS transition完了を待つ時間
export const DELAY_RESOLVE_OVERLAPS = 200;  // ノード寸法変更後の重なり解消デバウンス
export const DELAY_FIT_VIEW_LOAD = 300;     // ファイル読み込み後のfitView実行待ち

// ===== WebSocket Reconnection (ms) =====

export const WS_RECONNECT_BASE = 1000;          // データWSバックオフ基準値（1秒）
export const WS_RECONNECT_MAX = 10000;           // データWSバックオフ上限（10秒）
export const VOICE_WS_RECONNECT_ERROR = 10000;   // 音声WSエラー時の再接続待ち（10秒）
export const VOICE_WS_RECONNECT_CLOSE = 5000;    // 音声WS正常切断時の再接続待ち（5秒）

// ===== Category Colors =====
// ブロックカテゴリごとのヘッダー/アイコン色

export const CATEGORY_COLORS: Record<string, string> = {
  source: '#4caf50',      // ソース（データ生成）— 緑
  processing: '#2196f3',  // 処理（変換・加工）— 青
  sink: '#f44336',        // シンク（出力・表示）— 赤
  gui: '#9c27b0',         // GUI（ユーザー操作）— 紫
  hdl: '#ff8c00',         // HDL（ハードウェア記述）— オレンジ
};

// ===== Canvas Colors =====
// メインキャンバスとMiniMapの背景色

export const CANVAS_BG = '#1a1a1a';             // キャンバス全体の背景色
export const CANVAS_GRID_COLOR = '#444';         // グリッド線の色
export const MINIMAP_BG = '#1e1e1e';             // MiniMapの背景色
export const MINIMAP_NODE_COLOR = '#555';         // MiniMap上のノード色
export const MINIMAP_MASK = 'rgba(0,0,0,0.6)';   // MiniMapのビューポート外マスク

// ===== Subgraph Colors =====
// サブグラフ（ノードグループ）の配色

export const SUBGRAPH_BG = '#1e1e2e';       // 折り畳みサブグラフの背景色
export const SUBGRAPH_ACCENT = '#9c27b0';   // サブグラフのヘッダー・ボーダー・ハンドル色（紫）

// ===== Node UI Colors =====

export const NODE_RESIZER_COLOR = '#8bc34a';     // ノード選択時のリサイズハンドル色（黄緑）

// ===== Code Editor Theme (PythonEditor / CodeMirror) =====

export const EDITOR_BG = 'rgba(0,0,0,0.15)';               // エディタ本体の背景色（透過グレー、結果表示と差別化）
export const EDITOR_TEXT = '#e0e0e0';                      // コードテキストの色
export const EDITOR_GUTTER_BG = 'rgba(0,0,0,0.25)';        // 行番号エリアの背景色（透過）
export const EDITOR_GUTTER_TEXT = '#555';                   // 行番号の文字色
export const EDITOR_GUTTER_BORDER = '#333';                 // 行番号エリアの右ボーダー色
export const EDITOR_ACTIVE_LINE = 'rgba(255,255,255,0.05)'; // アクティブ行のハイライト背景
export const EDITOR_CURSOR = '#fff';                        // カーソルの色
export const EDITOR_FONT_SIZE = '11px';                     // コードエディタのフォントサイズ

// ===== Execution Result =====

export const EXEC_RESULT_BG = '#1a1a2e';                    // 実行結果エリアの背景色（濃い紫系）
export const EXEC_RESULT_FONT_SIZE = '13px';                // 実行結果のフォントサイズ（コードより大きく目立たせる）

// ===== Tooltip Colors =====
// ブロック実行結果のステータス表示色

export const TOOLTIP_INFO_BG = 'rgba(38,198,218,0.95)';      // 情報メッセージの背景（シアン）
export const TOOLTIP_INFO_BORDER = '#00bcd4';                  // 情報メッセージのボーダー
export const TOOLTIP_WARNING_BG = 'rgba(255,152,0,0.95)';     // 警告メッセージの背景（オレンジ）
export const TOOLTIP_WARNING_BORDER = '#ff9800';               // 警告メッセージのボーダー
export const TOOLTIP_TEACHING_BG = 'rgba(102,187,106,0.95)';  // 教示メッセージの背景（緑）
export const TOOLTIP_TEACHING_BORDER = '#4caf50';              // 教示メッセージのボーダー

// ===== Error Colors =====

export const ERROR_TEXT_COLOR = '#ff6b6b';   // モーダルダイアログのエラーメッセージ文字色

// ===== Buffer Limits =====

export const MAX_CONSOLE_LOGS = 500;          // コンソールログバッファの最大件数

// ===== Z-Index Layers =====
// 重なり順を一元管理（ズレるとオーバーレイ/メニューが隠れる）

export const Z_CONTEXT_MENU = 1000;    // 右クリックコンテキストメニュー
export const Z_MODAL_OVERLAY = 9999;   // フルスクリーンモーダルの背景オーバーレイ
export const Z_MODAL_BUTTON = 10000;   // モーダル上のボタン（閉じる/トグル等、オーバーレイより前面）
