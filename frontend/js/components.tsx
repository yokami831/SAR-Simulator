/**
 * components.tsx - React components for the flow editor
 *
 * Contains all custom React components:
 * - InlineParamRow: Single parameter input row inside a block node
 * - CanvasNode: Block node with ports, tabs, and params
 * - ContextMenu: Right-click context menu for nodes
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Handle, Position, NodeResizer } from '@xyflow/react';
import type { Node } from '@xyflow/react';

import { getBlockDef, getSetNodesRef } from './blockLibraryData.js';
import { NODE_MIN_WIDTH, NODE_COMPACT_HEIGHT, MAX_OUTPUT_DISPLAY_LEN } from './utils.js';
import { NODE_RESIZER_COLOR, TOOLTIP_INFO_BG, TOOLTIP_INFO_BORDER, TOOLTIP_WARNING_BG, TOOLTIP_WARNING_BORDER, TOOLTIP_TEACHING_BG, TOOLTIP_TEACHING_BORDER } from './constants.js';

// Feature flag cache (loaded once from /api/config)
let _fpgaEnabled = false;
fetch('/api/config').then(r => r.json()).then(cfg => {
  _fpgaEnabled = cfg.features?.fpga === true;
}).catch(() => {});
import { rcPrompt } from './modal.js';
import { PythonEditor } from './components/PythonEditor.js';
import { Surface3D } from './components/Surface3D.js';
import SarVisualizer, { SarParamDef } from './components/SarVisualizer.js';
// DOMPurify removed — text/html now rendered in sandboxed iframe

/** Wrap raw HTML in a full document with dark-theme CSS and auto-resize via postMessage. */
function wrapHtmlForIframe(html: string): string {
  return `<!DOCTYPE html>
<html><head><style>
  body { margin: 4px; font-family: -apple-system, sans-serif; font-size: 13px;
         color: #e2e8f0; background: transparent; overflow: hidden; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid rgba(255,255,255,0.1); padding: 4px 8px; text-align: left; }
  th { background: rgba(255,255,255,0.05); font-weight: 600; }
  tr:nth-child(even) { background: rgba(255,255,255,0.02); }
</style></head>
<body>${html}
<script>
  new ResizeObserver(function() {
    window.parent.postMessage({ type: 'iframe-resize', height: document.body.scrollHeight }, '*');
  }).observe(document.body);
</script>
</body></html>`;
}

/** Extract error line number from IPython traceback (1-based, or null). */
function extractErrorLine(error: string): number | null {
  // IPython traceback: "----> 3 some_code" or "line 5"
  const arrowMatch = error.match(/----> (\d+)/);
  if (arrowMatch) return parseInt(arrowMatch[1], 10);
  // Standard Python traceback: "File ..., line 5"
  const lineMatch = error.match(/line (\d+)/);
  if (lineMatch) return parseInt(lineMatch[1], 10);
  return null;
}

/** Editable label — double-click or right-click to rename inline */
function EditableLabel({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing && inputRef.current) inputRef.current.select(); }, [editing]);

  const startEdit = () => { setDraft(value); setEditing(true); };
  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onChange(trimmed);
  };

  if (editing) {
    return (
      <input ref={inputRef} className="grc-label-edit nodrag nopan" value={draft}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); e.stopPropagation(); }}
        onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
        autoComplete="off" />
    );
  }
  return (
    <span className="grc-label-display"
      onDoubleClick={(e) => { e.stopPropagation(); startEdit(); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); startEdit(); }}
      title="Double-click or right-click to rename">{value}</span>
  );
}

// ===== Types =====

interface PortDef {
  id: string;
  label: string;
  portType: string;
}

interface ParamDef {
  id: string;
  label?: string;
  dtype?: string;
  options?: string[];
  option_labels?: string[];
  hidden?: boolean;
  category?: string;
  default?: string;
}

interface GuiWidgetDef {
  type: string;
  dtype: string;
}

interface BlockNodeData {
  label?: string;
  category?: string;
  inputs?: PortDef[];
  outputs?: PortDef[];
  defaultParameters?: Record<string, string>;
  blockType?: string;
  codeCollapsed?: boolean;
  gui_widget?: GuiWidgetDef;
  _requestedTab?: string;
  _tabRequestId?: number;
  [key: string]: unknown;
}

// ===== Global Running Flag =====
// Execution state is now accessed via window.isFlowRunning() (set by app.tsx)

// ===== InlineParamRow Component =====

/**
 * Renders a single parameter input row with label, dtype badge, and input field.
 * Supports both text inputs and dropdown selects for enum types.
 */
function InlineParamRow({ paramDef, value, onChange }: {
  paramDef: ParamDef;
  value: string;
  onChange: (paramId: string, value: string) => void;
}) {
  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    onChange(paramDef.id, e.target.value);
  }, [paramDef.id, onChange]);

  let inputElement: React.ReactNode;
  if (paramDef.options && paramDef.options.length > 0) {
    inputElement = (
      <select
        className="grc-param-input nodrag nopan"
        value={value}
        onChange={handleChange}
        data-role="param-select"
        data-param-id={paramDef.id}
      >
        {paramDef.options.map((opt, i) => (
          <option key={opt} value={opt}>
            {(paramDef.option_labels && paramDef.option_labels[i]) || opt}
          </option>
        ))}
      </select>
    );
  } else {
    inputElement = (
      <input
        type="text"
        className="grc-param-input nodrag nopan"
        value={value}
        onChange={handleChange}
        onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
        onKeyDown={(e: React.KeyboardEvent) => e.stopPropagation()}
        autoComplete="off"
        data-role="param-input"
        data-param-id={paramDef.id}
      />
    );
  }

  return (
    <div className="grc-param-row">
      <div className="grc-param-label" title={paramDef.label}>
        {paramDef.label || paramDef.id}
      </div>
      {paramDef.dtype && <div className="grc-param-dtype">{paramDef.dtype}</div>}
      {inputElement}
    </div>
  );
}

// Auto-resize iframes via postMessage from sandboxed content
window.addEventListener('message', (e: MessageEvent) => {
  if (e.data?.type === 'iframe-resize' && typeof e.data.height === 'number') {
    document.querySelectorAll<HTMLIFrameElement>('iframe.grc-exec-html').forEach(iframe => {
      if (iframe.contentWindow === e.source) {
        iframe.style.height = e.data.height + 'px';
      }
    });
  }
});

// ===== ErrorDisplay Component =====

const ERROR_COLLAPSED_LINES = 3;

function ErrorDisplay({ error }: { error: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = error.split('\n');
  const needsTruncation = lines.length > ERROR_COLLAPSED_LINES;

  // Extract last meaningful line (usually the exception message)
  const lastLine = lines.filter(l => l.trim()).pop() || '';
  // Show summary (last line) + option to expand
  const displayText = expanded
    ? error.slice(0, MAX_OUTPUT_DISPLAY_LEN)
    : lastLine;

  return (
    <div className="grc-exec-error">
      <div className="grc-exec-error-text">{displayText}</div>
      {needsTruncation && (
        <button
          className="grc-exec-error-toggle"
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
        >
          {expanded ? '▲ collapse' : `▼ full trace (${lines.length} lines)`}
        </button>
      )}
    </div>
  );
}

// ===== GUI Widget Components =====
//
// GUI widget values are stored on the node (via onParamChange → node parameters)
// and assigned to kernel variables only during flow execution (topological order).
// There is no out-of-band immediate-send to the kernel.

function GuiTextInput({ params, onParamChange, compact }: {
  params: Record<string, string>;
  onParamChange: (id: string, val: string) => void;
  compact?: boolean;
}) {
  return (
    <div className="gui-widget-body nodrag nopan nowheel">
      <textarea className="gui-text-input nodrag nopan nowheel" value={params.value || ''}
        onChange={(e) => onParamChange('value', e.target.value)}
        onKeyDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}
        placeholder={params.placeholder || 'Enter text here...'} rows={4} />
      {!compact && params.var_name && <div className="gui-value-row"><span className="gui-value-varname">{params.var_name}</span></div>}
    </div>
  );
}

function GuiSlider({ params, onParamChange, compact }: {
  params: Record<string, string>;
  onParamChange: (id: string, val: string) => void;
  compact?: boolean;
}) {
  // Optional discrete snap targets (CSV, e.g. "1,2,4,8,16"). When present the
  // slider moves freely but every committed value snaps to the nearest entry,
  // and min/max/step derive from the snap set (mirrors the web app SnapSlider).
  const snapValues = (params.snap_values || '')
    .split(',').map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n))
    .sort((a, b) => a - b);
  const hasSnap = snapValues.length >= 2;
  const min = hasSnap ? snapValues[0] : (parseFloat(params.min) || 0);
  const max = hasSnap ? snapValues[snapValues.length - 1] : (parseFloat(params.max) || 100);
  // With snap on, allow fine dragging (step≈range/100) and snap on commit.
  const step = hasSnap ? Math.max((max - min) / 100, 1e-9) : (parseFloat(params.step) || 1);
  const snapTo = (v: number) =>
    hasSnap ? snapValues.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a)) : v;
  const value = snapTo(parseFloat(params.value) || min);

  const handleChange = useCallback((raw: number) => {
    onParamChange('value', String(snapTo(raw)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.snap_values, onParamChange]);

  return (
    <div className="gui-widget-body nodrag nopan nowheel">
      <div className="gui-slider-container">
        {!compact && <div className="gui-slider-labels"><span>{min}</span><span>{max}</span></div>}
        <input type="range" className="gui-slider nodrag nopan" min={min} max={max} step={step} value={value}
          onChange={(e) => handleChange(parseFloat(e.target.value))} />
        {!compact && (
          <div className="gui-value-row">
            {params.var_name && <span className="gui-value-varname">{params.var_name}</span>}
            <input type="number" className="gui-slider-number nodrag nopan" min={min} max={max} step={step} value={value}
              onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) handleChange(v); }}
              onKeyDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} />
          </div>
        )}
      </div>
    </div>
  );
}

function GuiDropdown({ params, onParamChange, compact }: {
  params: Record<string, string>;
  onParamChange: (id: string, val: string) => void;
  compact?: boolean;
}) {
  const options = (params.options_csv || '').split(',').map(s => s.trim()).filter(Boolean);

  return (
    <div className="gui-widget-body nodrag nopan nowheel">
      <select className="gui-dropdown nodrag nopan" value={params.value || ''}
        onChange={(e) => onParamChange('value', e.target.value)}>
        <option value="">-- select --</option>
        {options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
      </select>
      {!compact && params.var_name && <div className="gui-value-row"><span className="gui-value-varname">{params.var_name}</span></div>}
    </div>
  );
}

function GuiToggle({ params, onParamChange, compact }: {
  params: Record<string, string>;
  onParamChange: (id: string, val: string) => void;
  compact?: boolean;
}) {
  const isOn = params.value === 'true' || params.value === 'True';

  const handleToggle = useCallback(() => {
    onParamChange('value', String(!isOn));
  }, [isOn, onParamChange]);

  return (
    <div className="gui-widget-body nodrag nopan nowheel">
      <div className="gui-toggle-container" onClick={handleToggle}>
        <span className="gui-toggle-label-text">{params.label_off || 'OFF'}</span>
        <div className={`gui-toggle-switch ${isOn ? 'on' : 'off'}`}>
          <div className="gui-toggle-knob" />
        </div>
        <span className="gui-toggle-label-text">{params.label_on || 'ON'}</span>
      </div>
      {!compact && params.var_name && <div className="gui-value-row"><span className="gui-value-varname">{params.var_name}</span></div>}
    </div>
  );
}

function GuiFilePicker({ params, onParamChange, compact }: {
  params: Record<string, string>;
  onParamChange: (id: string, val: string) => void;
  compact?: boolean;
}) {
  const handleBrowse = useCallback(async () => {
    try {
      const result = await (window.electronAPI?.showOpenDialog as ((opts: Record<string, unknown>) => Promise<{ canceled: boolean; filePaths: string[] }>) | undefined)?.({
        properties: ['openFile'],
        defaultPath: params.value || undefined,
        filters: params.accept && params.accept !== '*'
          ? [{ name: 'Files', extensions: params.accept.split(/[,;]/).map((s: string) => s.trim().replace(/^\*?\.?/, '')).filter(Boolean) }]
          : [],
      });
      if (result && !result.canceled && result.filePaths?.length > 0) {
        onParamChange('value', result.filePaths[0]);
      }
    } catch (e) {
      console.error('File dialog failed:', e);
    }
  }, [params.value, params.accept, onParamChange]);

  return (
    <div className="gui-widget-body nodrag nopan nowheel">
      <div className="gui-file-picker-container">
        <input type="text" className="gui-file-path nodrag nopan" value={params.value || ''}
          onChange={(e) => onParamChange('value', e.target.value)}
          onKeyDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}
          placeholder="Select a file..." />
        <button className="gui-file-browse-btn nodrag nopan" onClick={handleBrowse}>Browse...</button>
      </div>
      {!compact && params.var_name && <div className="gui-value-row"><span className="gui-value-varname">{params.var_name}</span></div>}
    </div>
  );
}

/** Render the appropriate GUI widget based on gui_widget.type */
function GuiWidgetBody({ guiWidget, params, onParamChange, paramDefs }: {
  guiWidget: GuiWidgetDef; params: Record<string, string>;
  onParamChange: (id: string, val: string) => void;
  paramDefs?: SarParamDef[];
}) {
  switch (guiWidget.type) {
    case 'text_input': return <GuiTextInput params={params} onParamChange={onParamChange} />;
    case 'slider': return <GuiSlider params={params} onParamChange={onParamChange} />;
    case 'dropdown': return <GuiDropdown params={params} onParamChange={onParamChange} />;
    case 'toggle': return <GuiToggle params={params} onParamChange={onParamChange} />;
    case 'file_picker': return <GuiFilePicker params={params} onParamChange={onParamChange} />;
    case 'sar_visualizer':
      return <SarVisualizer params={params} paramDefs={paramDefs ?? []} onParamChange={onParamChange} />;
    case 'form':
      return <GuiFormBody fields={paramDefs ?? []} params={params} onParamChange={onParamChange} />;
    default: return <div>Unknown widget: {guiWidget.type}</div>;
  }
}

// ===== Composite GUI form (gui_form) =====
//
// A gui_form block holds many widget fields in a single block. Each entry in
// blockDef.parameters has the same shape as a regular widget block's params,
// plus:
//   - widget:       "slider"|"dropdown"|"toggle"|"file_picker"|"text_input"
//   - var_name:     kernel variable to assign
//   - visible_when: optional condition (see _evalVisibleWhen below)
//
// The on-canvas value of each field is stored under params[field.id] (same
// pattern as ordinary blocks). visible_when is a tiny "field == 'literal'"
// grammar mirrored in backend/code_utils.py:_eval_visible_when so the
// frontend hides what the backend skips.

/** Evaluate a simple visible_when expression. Mirrors backend logic. */
function _evalVisibleWhen(expr: string | undefined, values: Record<string, string>): boolean {
  if (!expr) return true;
  const s = expr.trim();
  for (const op of ['==', '!=']) {
    const idx = s.indexOf(op);
    if (idx >= 0) {
      const left = s.slice(0, idx).trim();
      let right = s.slice(idx + op.length).trim();
      if (right.length >= 2 && (right.startsWith("'") || right.startsWith('"')) && right[0] === right[right.length - 1]) {
        right = right.slice(1, -1);
      }
      const actual = String(values[left] ?? '');
      return op === '==' ? actual === right : actual !== right;
    }
  }
  return true; // unknown grammar -> fail-open
}

interface FormFieldDef {
  id: string;
  label?: string;
  widget?: string;            // slider/dropdown/toggle/file_picker/text_input
  var_name?: string;
  visible_when?: string;
  default?: string;
  dtype?: string;
  hidden?: boolean;
  // widget-specific keys (forwarded as params to the child widget)
  min?: string; max?: string; step?: string;
  options_csv?: string; snap_values?: string;
  label_on?: string; label_off?: string;
  accept?: string; placeholder?: string;
}

/** Render a gui_form: stacked widgets, each tied to one field id. */
function GuiFormBody({ fields, params, onParamChange }: {
  fields: SarParamDef[];   // accepts the broader param-def type used elsewhere
  params: Record<string, string>;
  onParamChange: (id: string, val: string) => void;
}) {
  // Build a values map for visible_when evaluation. Includes both field-id
  // and var_name keys so authors can reference either form in expressions.
  const currentValues: Record<string, string> = {};
  for (const f of fields) {
    const id = (f as FormFieldDef).id;
    const def = (f as FormFieldDef).default;
    currentValues[id] = params[id] !== undefined ? params[id] : (def ?? '');
  }
  for (const f of fields) {
    const v = (f as FormFieldDef).var_name;
    if (v && currentValues[v] === undefined) {
      currentValues[v] = currentValues[(f as FormFieldDef).id] ?? '';
    }
  }

  return (
    <div className="gui-form-body nodrag nopan nowheel">
      {fields.map((rawField) => {
        const field = rawField as unknown as FormFieldDef;
        if (field.hidden) return null;
        if (!_evalVisibleWhen(field.visible_when, currentValues)) return null;
        const widget = field.widget || 'text_input';

        // Per-field params: child widget reads { value, var_name, ... } as if
        // it were a standalone widget. We materialize defaults so a freshly
        // dropped block shows useful initial widget state.
        const fieldParams: Record<string, string> = {
          value: currentValues[field.id] ?? '',
          var_name: field.var_name ?? '',
          min: field.min ?? '', max: field.max ?? '', step: field.step ?? '',
          options_csv: field.options_csv ?? '',
          snap_values: field.snap_values ?? '',
          label_on: field.label_on ?? '', label_off: field.label_off ?? '',
          accept: field.accept ?? '', placeholder: field.placeholder ?? '',
        };
        // Adapter: child widget writes onParamChange('value', v) → we route
        // that to the field id so per-field values stay distinct in params.
        const onChildChange = (key: string, val: string) => {
          if (key === 'value') onParamChange(field.id, val);
        };

        let inner: React.ReactNode;
        switch (widget) {
          case 'slider':      inner = <GuiSlider     params={fieldParams} onParamChange={onChildChange} compact />; break;
          case 'dropdown':    inner = <GuiDropdown   params={fieldParams} onParamChange={onChildChange} compact />; break;
          case 'toggle':      inner = <GuiToggle     params={fieldParams} onParamChange={onChildChange} compact />; break;
          case 'file_picker': inner = <GuiFilePicker params={fieldParams} onParamChange={onChildChange} compact />; break;
          case 'text_input':  inner = <GuiTextInput  params={fieldParams} onParamChange={onChildChange} compact />; break;
          default: inner = <div>Unknown widget: {widget}</div>;
        }

        // Compact 2-row layout (SAR Visualizer style): label on the left of
        // row 1, current value (read-only display, or a number input for
        // sliders so precise values are still editable) on the right.
        // Row 2 is the control itself with var_name/min-max/number-input
        // stripped (via compact prop on inner widget).
        const valStr = currentValues[field.id] ?? '';
        let valueDisplay: React.ReactNode = null;
        if (widget === 'slider') {
          const minN = parseFloat(field.min ?? '') || 0;
          const maxN = parseFloat(field.max ?? '') || 100;
          const stepN = parseFloat(field.step ?? '') || 1;
          valueDisplay = (
            <input type="number" className="gui-slider-number nodrag nopan" min={minN} max={maxN} step={stepN}
              value={valStr}
              onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) onParamChange(field.id, String(v)); }}
              onKeyDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} />
          );
        } else if (widget !== 'toggle' && widget !== 'file_picker' && widget !== 'text_input') {
          valueDisplay = <span className="gui-form-field-value">{valStr}</span>;
        }

        return (
          <div key={field.id} className="gui-form-field">
            {(field.label || valueDisplay) && (
              <div className="gui-form-field-label-row">
                <span className="gui-form-field-label">{field.label}</span>
                {valueDisplay}
              </div>
            )}
            {inner}
          </div>
        );
      })}
    </div>
  );
}

// ===== Image Display Components =====
//
// Renders one or more image/png|jpeg display outputs from a node execution.
// A single image shows directly; multiple images get a toggle button group
// (Full/Crop for 2, numbered for 3+). Every image has an Expand button that
// opens a fullscreen modal (with the same toggle when there are multiple).
// Toggle/Expand button styling matches Surface3D.tsx (ToggleButtons / Expand).

interface DisplayItem { mime_type: string; data: string }

/** Labels for the toggle group: Full/Crop for 2 images, 1/2/3... for 3+. */
function imageToggleLabels(count: number): string[] {
  if (count === 2) return ['Full', 'Crop'];
  return Array.from({ length: count }, (_, i) => String(i + 1));
}

const imgToggleActiveStyle: React.CSSProperties = {
  background: '#1b2740', border: '1px solid #2a3142',
  color: '#cfd6e6', font: '11px sans-serif', padding: '3px 10px', cursor: 'pointer',
};
const imgToggleInactiveStyle: React.CSSProperties = {
  background: 'rgba(14,20,34,0.85)', border: '1px solid #2a3142',
  color: '#cfd6e6', font: '11px sans-serif', padding: '3px 10px', cursor: 'pointer',
};

/** Toggle button group for selecting one of several images. */
function ImageToggleButtons({ labels, active, onSelect, style }: {
  labels: string[];
  active: number;
  onSelect: (i: number) => void;
  style?: React.CSSProperties;
}) {
  return (
    <div className="nodrag nopan" style={{ display: 'flex', gap: 0, ...style }}>
      {labels.map((lbl, i) => {
        const isFirst = i === 0;
        const isLast = i === labels.length - 1;
        const radius = isFirst ? '4px 0 0 4px' : isLast ? '0 4px 4px 0' : '0';
        return (
          <button
            key={i}
            style={{
              ...(i === active ? imgToggleActiveStyle : imgToggleInactiveStyle),
              borderRight: isLast ? '1px solid #2a3142' : 'none',
              borderRadius: labels.length === 1 ? '4px' : radius,
            }}
            onClick={(e) => { e.stopPropagation(); onSelect(i); }}
          >{lbl}</button>
        );
      })}
    </div>
  );
}

/** Expand button (matches Surface3D.tsx Expand button styling). */
function ImageExpandButton({ onClick, style }: { onClick: () => void; style?: React.CSSProperties }) {
  return (
    <button
      className="nodrag nopan"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title="Open in expanded view"
      style={{
        background: 'rgba(14,20,34,0.85)', border: '1px solid #2a3142',
        borderRadius: 4, color: '#cfd6e6', font: '11px sans-serif',
        padding: '3px 8px', cursor: 'pointer', ...style,
      }}
    >
      {'⤢'} Expand
    </button>
  );
}

/** Fullscreen modal showing an image large, with toggle when multiple. */
function ImageExpandModal({ images, initialIndex, onClose }: {
  images: DisplayItem[];
  initialIndex: number;
  onClose: () => void;
}) {
  const [active, setActive] = useState(initialIndex);
  const img = images[active];
  const labels = imageToggleLabels(images.length);
  const isMulti = images.length > 1;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
    >
      {isMulti && (
        <ImageToggleButtons
          labels={labels}
          active={active}
          onSelect={setActive}
          style={{ position: 'fixed', top: 12, left: 12, zIndex: 10000 }}
        />
      )}
      <img
        src={`data:${img.mime_type};base64,${img.data}`}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '92vw', maxHeight: '88vh', objectFit: 'contain', display: 'block' }}
      />
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        style={{
          position: 'fixed', top: 12, right: 12, zIndex: 10000,
          background: 'rgba(14,20,34,0.85)', border: '1px solid #2a3142',
          borderRadius: 4, color: '#cfd6e6', font: '11px sans-serif',
          padding: '3px 8px', cursor: 'pointer',
        }}
      >
        Close
      </button>
    </div>
  );
}

/**
 * Renders a group of image/png|jpeg outputs. One image → simple display;
 * multiple → toggle group selecting which one is shown. Both cases get an
 * Expand button that opens ImageExpandModal.
 */
function ImageGroup({ images }: { images: DisplayItem[] }) {
  const [active, setActive] = useState(0);
  const [showExpand, setShowExpand] = useState(false);

  if (images.length === 0) return null;
  const safeActive = Math.min(active, images.length - 1);
  const img = images[safeActive];
  const isMulti = images.length > 1;
  const labels = imageToggleLabels(images.length);

  return (
    <>
      <div className="nodrag nopan" style={{ position: 'relative', marginTop: '4px' }}>
        {isMulti && (
          <ImageToggleButtons
            labels={labels}
            active={safeActive}
            onSelect={setActive}
            style={{ position: 'absolute', top: 6, left: 6, zIndex: 2 }}
          />
        )}
        <ImageExpandButton
          onClick={() => setShowExpand(true)}
          style={{ position: 'absolute', top: 6, right: 6, zIndex: 2 }}
        />
        <img
          src={`data:${img.mime_type};base64,${img.data}`}
          style={{ display: 'block', maxWidth: '100%', borderRadius: '2px' }}
        />
      </div>
      {showExpand && (
        <ImageExpandModal
          images={images}
          initialIndex={safeActive}
          onClose={() => setShowExpand(false)}
        />
      )}
    </>
  );
}

// ===== CanvasNode Component =====

export function CanvasNode(props: { id: string; data: BlockNodeData; selected?: boolean }) {
  return <RegularBlockNode {...props} />;
}

function RegularBlockNode({ id, data, selected }: { id: string; data: BlockNodeData; selected?: boolean }) {
  const { label, category, inputs: rawInputs, outputs: rawOutputs, defaultParameters, blockType } = data;
  const inputPorts: PortDef[] = (rawInputs as PortDef[] | undefined) || [];
  const outputPorts: PortDef[] = (rawOutputs as PortDef[] | undefined) || [];
  const executionStatus = data.executionStatus as string | undefined;
  const isExecuting = executionStatus === 'executing';
  const [elapsed, setElapsed] = useState(0);
  // GUI widget nodes default to the operate view (slider/toggle/etc.); the gear
  // toggles to the settings view (var_name/min/max/...). UI-only, never saved.
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    if (!isExecuting) { setElapsed(0); return; }
    // On execution, leave settings and show the control so the live value
    // is visible at a glance.
    setShowSettings(false);
    const start = Date.now();
    const id = setInterval(() => {
      setElapsed((Date.now() - start) / 1000);
    }, 1000);
    return () => clearInterval(id);
  }, [isExecuting]);

  const codeCollapsed = data.codeCollapsed === true;
  // Spec section defaults to collapsed when empty, expanded when it has content,
  // unless the user has explicitly toggled it (data.specCollapsed set).
  const specCollapsed = data.specCollapsed === true;

  const toggleSpecCollapse = useCallback(() => {
    const setNodes = getSetNodesRef();
    if (!setNodes) return;
    setNodes((nds) => nds.map(n => {
      if (n.id !== id) return n;
      const { height: _h, ...restStyle } = (n.style || {}) as Record<string, unknown>;
      const { height: _mh, ...restMeasured } = ((n as Record<string, unknown>).measured || {}) as Record<string, unknown>;
      const { height: _nh, ...restNode } = n as Record<string, unknown>;
      return { ...restNode, data: { ...n.data, specCollapsed: !((n.data as BlockNodeData).specCollapsed === true) }, style: { ...restStyle }, measured: { ...restMeasured } } as unknown as Node;
    }));
  }, [id]);

  // Spec textarea height (drag the divider below it to resize). Persisted in
  // node data so it survives save/reload. Default 80px.
  const specHeight = (data.specHeight as number | undefined) ?? 80;

  const startSpecResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const setNodes = getSetNodesRef();
    if (!setNodes) return;
    const startY = e.clientY;
    const startH = specHeight;
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(32, startH + (ev.clientY - startY));
      setNodes((nds) => nds.map(n =>
        n.id === id ? { ...n, data: { ...n.data, specHeight: next } } : n,
      ));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [id, specHeight]);

  const toggleCodeCollapse = useCallback(() => {
    const setNodes = getSetNodesRef();
    if (!setNodes) return;
    const next = !codeCollapsed;
    // Update data.codeCollapsed and remove explicit height so node auto-sizes
    setNodes((nds) => nds.map(n => {
      if (n.id !== id) return n;
      const { height: _h, ...restStyle } = (n.style || {}) as Record<string, unknown>;
      const { height: _mh, ...restMeasured } = ((n as Record<string, unknown>).measured || {}) as Record<string, unknown>;
      const { height: _nh, ...restNode } = n as Record<string, unknown>;
      return { ...restNode, data: { ...n.data, codeCollapsed: next }, style: { ...restStyle }, measured: { ...restMeasured } } as unknown as Node;
    }));
  }, [id, codeCollapsed]);

  const blockDef = blockType ? getBlockDef(blockType) : null;
  // Shim mode: the .rcflow references a block type that is not registered.
  // We still render the node (so edges + structure stay intact) but mark it
  // visually and disable execution. Ports come from the node's own saved
  // data.inputs/outputs (the registry definition is unavailable).
  const isShim = !!blockType && !blockDef && blockType !== 'python_code' && blockType !== 'comment';
  // gui_widget is a static block attribute — take it from the block definition
  // (survives save/load), falling back to any value stored on the node.
  const guiWidget = (blockDef?.gui_widget ?? data.gui_widget) as GuiWidgetDef | undefined;

  // Separate code / spec params from non-code params
  const allParams: ParamDef[] = [];
  let specParam: ParamDef | null = null;
  const codeParam: ParamDef | null = (() => {
    let found: ParamDef | null = null;
    if (blockDef?.parameters) {
      for (const p of blockDef.parameters) {
        if (p.id === 'id' || p.hidden) continue;
        const paramDef = p as unknown as ParamDef;
        if (p.dtype === 'spec') { specParam = paramDef; }
        else if (p.dtype === 'code') { found = paramDef; }
        else { allParams.push(paramDef); }
      }
    }
    return found;
  })();

  const currentParams: Record<string, string> = defaultParameters || {};

  const onParamChange = useCallback((paramId: string, value: string) => {
    const setNodes = getSetNodesRef();
    if (!setNodes) return;
    setNodes((nds) => nds.map(n => {
      if (n.id !== id) return n;
      return { ...n, data: { ...n.data,
        defaultParameters: { ...(n.data as BlockNodeData).defaultParameters, [paramId]: value }
      }};
    }));
  }, [id]);

  const isEnabled = data.enabled !== false;

  const onEnabledChange = useCallback((checked: boolean) => {
    const setNodes = getSetNodesRef();
    if (!setNodes) return;
    setNodes((nds) => nds.map(n => {
      if (n.id !== id) return n;
      return { ...n, data: { ...n.data, enabled: checked } };
    }));
  }, [id]);

  const blockTypeStr = blockType || '';
  // Documentation-only blocks (comment, group_spec): no execution → hide
  // enable checkbox + run button.
  const isNonExecutable = blockTypeStr === 'comment' || blockTypeStr === 'group_spec';

  return (
    <div
      className={`grc-block ${category || ''}${!isEnabled ? ' disabled' : ''}${executionStatus ? ` exec-${executionStatus}` : ''}${isShim ? ' shim' : ''}`}
      data-role="canvas-node"
      data-node-id={id}
      data-block-type={blockTypeStr}
      title={isShim ? `Missing block definition: ${blockType}. Copy ${blockType}.json into <workspace>/blocks/ and reload.` : undefined}
    >
      <NodeResizer minWidth={NODE_MIN_WIDTH} minHeight={NODE_COMPACT_HEIGHT} isVisible={selected} color={NODE_RESIZER_COLOR} />

      {/* Header with enable checkbox, run button, and execution time */}
      <div className="grc-block-header">
        {!isNonExecutable && (
          <input
            type="checkbox"
            className="grc-block-enable-cb"
            checked={isEnabled}
            onChange={(e) => { e.stopPropagation(); onEnabledChange(e.target.checked); }}
            title={isEnabled ? 'Enabled (click to disable)' : 'Disabled (click to enable)'}
          />
        )}
        {!isNonExecutable && (
          <button
            className="grc-run-node-btn"
            disabled={isExecuting}
            onClick={(e) => {
              e.stopPropagation();
              if (window.isFlowRunning?.()) return;
              fetch('/api/tools/run_node', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ node_id: id }),
              }).catch(() => {});
            }}
            title="Run this block"
          >&#9654;</button>
        )}
        {(data.executionOrder as number | undefined) != null && (
          <span className="grc-exec-order" title="Execution order in the last run">
            {data.executionOrder as number}
          </span>
        )}
        {isShim && (
          <span className="grc-shim-warning" title={`Missing block: ${blockType}`}>⚠ missing: {blockType}</span>
        )}
        <EditableLabel value={currentParams.label || label || ''} onChange={(v) => onParamChange('label', v)} />
        <span className="grc-header-id">{id}</span>
        {isExecuting ? (
          <span className="grc-header-time executing">{elapsed.toFixed(0)}s</span>
        ) : (data.executionTime as number | undefined) != null ? (
          <span className="grc-header-time">{Number(data.executionTime as number).toFixed(2)}s</span>
        ) : null}
        {guiWidget && (
          <button
            className={`grc-gui-settings-btn${showSettings ? ' active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowSettings((s) => !s); }}
            title={showSettings ? 'Show control' : 'Edit settings'}
          >&#9881;</button>
        )}
      </div>

      {/* Input handle (absolute positioned, no label) */}
      {inputPorts.map((port: PortDef) => (
        <Handle key={port.id} type="target" position={Position.Left} id={port.id}
          data-porttype={port.portType} data-role="port" data-port-id={port.id} data-port-direction="input"
          style={{ top: '50%' }} />
      ))}

      {/* GUI Widget — replaces params + code for gui nodes.
          Resolved from the block definition (via blockType), not the node's
          saved data: gui_widget is a static block attribute, so deriving it
          here means it survives save/load without being stored per-node. */}
      {guiWidget && !showSettings ? (
        <GuiWidgetBody guiWidget={guiWidget} params={currentParams} onParamChange={onParamChange}
          paramDefs={(blockDef?.parameters as SarParamDef[] | undefined)} />
      ) : (
      <>
      {/* Non-code parameters */}
      {allParams.length > 0 && (
        <div className="grc-block-params-section nodrag nopan nowheel">
          {allParams.map(pDef => (
            <InlineParamRow key={pDef.id} paramDef={pDef}
              value={currentParams[pDef.id] !== undefined ? currentParams[pDef.id] : (pDef.default || '')}
              onChange={onParamChange} />
          ))}
        </div>
      )}

      {/* Spec section (design/coding spec) — above the code, collapsible */}
      {specParam && (
        <>
        <div className="grc-spec-collapse-toggle nodrag nopan" onClick={toggleSpecCollapse}>
          <span className={`grc-collapse-arrow${specCollapsed ? ' collapsed' : ''}`}>▼</span> Spec
        </div>
        {!specCollapsed && (
          <>
          <textarea
            className="grc-spec-area nodrag nopan nowheel"
            style={{ height: specHeight }}
            value={currentParams[specParam.id] !== undefined ? currentParams[specParam.id] : (specParam.default || '')}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onParamChange(specParam!.id, e.target.value)}
            onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
            onKeyDown={(e: React.KeyboardEvent) => e.stopPropagation()}
            placeholder="Describe what this block does (parameters, behavior)..."
            spellCheck={false}
            data-role="param-input"
            data-param-id={specParam.id}
          />
          <div className="grc-spec-resize nodrag nopan" onMouseDown={startSpecResize} title="Drag to resize spec" />
          </>
        )}
        </>
      )}
      </>
      )}

      {/* Streaming output during execution */}
      {executionStatus === 'executing' && !!data.executionOutput && (
        <div className="grc-exec-result exec-executing nodrag nopan">
          <div className="grc-exec-output">{String(data.executionOutput).trim().slice(0, MAX_OUTPUT_DISPLAY_LEN)}</div>
        </div>
      )}

      {/* Execution result area (above code for visibility) */}
      {executionStatus && executionStatus !== 'executing' && (
        <div className={`grc-exec-result exec-${executionStatus} nodrag nopan`}>
          {/* Rich display data (images, HTML) — shown first.
              All image/png|jpeg outputs are grouped into a single ImageGroup
              (toggle + expand). The group is rendered at the first image's
              position; subsequent images render null so they are not duplicated. */}
          {(() => {
            const displayData = data.displayData as Array<{mime_type: string; data: string}> | undefined;
            if (!displayData) return null;
            const isImg = (m: string) => m === 'image/png' || m === 'image/jpeg';
            const imgs = displayData.filter(d => isImg(d.mime_type));
            const firstImgIndex = displayData.findIndex(d => isImg(d.mime_type));
            return displayData.map((d, i) => {
              if (d.mime_type === 'application/x-hiyocanvas-surface3d')
                return <Surface3D key={i} payloadJson={d.data} />;
              if (isImg(d.mime_type))
                // Render the grouped image UI once (at the first image); skip the rest.
                return i === firstImgIndex ? <ImageGroup key={i} images={imgs} /> : null;
              if (d.mime_type === 'image/svg+xml')
                return <div key={i} style={{maxWidth:'100%', marginTop:'4px'}} dangerouslySetInnerHTML={{__html: d.data}} />;
              if (d.mime_type === 'text/html')
                return <iframe key={i} className="grc-exec-html"
                  sandbox="allow-scripts allow-same-origin allow-popups"
                  srcDoc={wrapHtmlForIframe(d.data)} />;
              return null;
            });
          })() as React.ReactNode}
          {/* Result value (last expression) — hide when rich display_data exists */}
          {(data.resultValue && !(data.displayData as Array<unknown> | undefined)?.length && (
            <div className="grc-exec-result-value">Out: {String(data.resultValue).slice(0, MAX_OUTPUT_DISPLAY_LEN)}</div>
          )) as React.ReactNode}
          {/* Print output — shown below rich display */}
          {executionStatus === 'completed' && !!data.executionOutput && (
            <div className="grc-exec-output">{String(data.executionOutput).trim().slice(0, MAX_OUTPUT_DISPLAY_LEN)}</div>
          )}
          {executionStatus === 'error' && !!data.executionError && (
            <ErrorDisplay error={String(data.executionError).trim()} />
          )}
          {/* VCD waveform file buttons (FPGA feature only) */}
          {_fpgaEnabled && (data.vcdFiles as string[] | undefined)?.map((f, i) => (
            <button key={i} className="vcd-open-btn" onClick={(e) => {
              e.stopPropagation();
              fetch('/api/vcd/open', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file: f }),
              })
                .then(r => r.json())
                .then(res => { if (!res.success) alert(res.message); })
                .catch(() => alert('Failed to open Surfer'));
            }}>
              {'\uD83D\uDCCA'} {f} — Open in Surfer
            </button>
          ))}
        </div>
      )}

      {/* Code area with collapse toggle (hidden for GUI widget nodes) */}
      {codeParam && !guiWidget && (
        <>
        <div className="grc-code-collapse-toggle nodrag nopan" onClick={toggleCodeCollapse}>
          <span className={`grc-collapse-arrow${codeCollapsed ? ' collapsed' : ''}`}>▼</span> Code
        </div>
        {!codeCollapsed && (
          inputPorts.length > 0 || outputPorts.length > 0 ? (
            <PythonEditor
              value={currentParams[codeParam.id] !== undefined ? currentParams[codeParam.id] : (codeParam.default || '')}
              onChange={(val: string) => onParamChange(codeParam.id, val)}
              errorLine={executionStatus === 'error' && data.executionError ? extractErrorLine(String(data.executionError)) : null}
            />
          ) : (
            <textarea
              className="grc-code-area nodrag nopan nowheel"
              value={currentParams[codeParam.id] !== undefined ? currentParams[codeParam.id] : (codeParam.default || '')}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onParamChange(codeParam.id, e.target.value)}
              onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
              onKeyDown={(e: React.KeyboardEvent) => e.stopPropagation()}
              spellCheck={false}
              data-role="param-input"
              data-param-id={codeParam.id}
            />
          )
        )}
        </>
      )}

      {/* Output handle (absolute positioned, no label) */}
      {outputPorts.map(port => (
        <Handle key={port.id} type="source" position={Position.Right} id={port.id}
          data-porttype={port.portType} data-role="port" data-port-id={port.id} data-port-direction="output"
          style={{ top: '50%' }} />
      ))}
    </div>
  );
}

// ===== ContextMenu Component =====

/** Right-click context menu for nodes with delete option */
export function ContextMenu({ x, y, nodeId, edgeId, selectionCount, onClose, onDelete, onDeleteEdge,
  nodeType, collapsed, nodeLabel, nodeDescription, onToggleCollapse, onUngroup, onRename, onSetDescription, onCreateSubgraph }: {
  x: number;
  y: number;
  nodeId?: string;
  edgeId?: string;
  selectionCount?: number;
  onClose: () => void;
  onDelete: (nodeId: string) => void;
  onDeleteEdge: (edgeId: string) => void;
  nodeType?: string;
  collapsed?: boolean;
  nodeLabel?: string;
  nodeDescription?: string;
  onToggleCollapse?: (nodeId: string) => void;
  onUngroup?: (nodeId: string) => void;
  onRename?: (nodeId: string, name: string) => void;
  onSetDescription?: (nodeId: string, desc: string) => void;
  onCreateSubgraph?: (nodeIds: string[], name: string) => void;
}) {
  useEffect(() => {
    const handler = () => onClose();
    setTimeout(() => window.addEventListener('click', handler), 0);
    return () => window.removeEventListener('click', handler);
  }, [onClose]);

  const isSubgraph = nodeType === 'subgraph';

  return (
    <div className="context-menu" style={{ left: x, top: y }}>
      {/* Group selection (2+ nodes selected, right-click on canvas/selection) */}
      {!nodeId && !edgeId && selectionCount != null && selectionCount >= 2 && (
        <button onClick={async () => {
          onClose();
          const name = await rcPrompt('Group name:', 'Group', { title: 'Create Group' });
          if (name !== null) onCreateSubgraph?.(
            ((window as unknown as Record<string, { getNodes?: () => Array<{ id: string; selected?: boolean }> }>).rfInstance?.getNodes?.() || []).filter((n: { selected?: boolean }) => n.selected).map((n: { id: string }) => n.id), name);
        }}>{`Group ${selectionCount} nodes (Ctrl+G)`}</button>
      )}

      {/* Subgraph-specific items */}
      {nodeId && isSubgraph && (
        <button onClick={() => { onToggleCollapse?.(nodeId); onClose(); }}>
          {collapsed ? 'Expand' : 'Collapse'}
        </button>
      )}
      {nodeId && isSubgraph && (
        <button onClick={async () => {
          onClose();
          const name = await rcPrompt('New name:', nodeLabel || '', { title: 'Rename Group' });
          if (name) onRename?.(nodeId, name);
        }}>Rename</button>
      )}
      {nodeId && isSubgraph && (
        <button onClick={async () => {
          onClose();
          const desc = await rcPrompt('Description:', nodeDescription || '', { title: 'Edit Description' });
          if (desc !== null) onSetDescription?.(nodeId, desc);
        }}>Edit Description</button>
      )}
      {nodeId && isSubgraph && (
        <button onClick={() => { onUngroup?.(nodeId); onClose(); }}>
          Ungroup (Ctrl+Shift+G)
        </button>
      )}
      {nodeId && isSubgraph && <div className="menu-sep" />}

      {/* Common items */}
      {nodeId && (
        <button className="danger" onClick={() => { onDelete(nodeId); onClose(); }}>
          {isSubgraph ? 'Delete Group' : 'Delete Block'}
        </button>
      )}
      {edgeId && (
        <button className="danger" onClick={() => { onDeleteEdge(edgeId); onClose(); }}>
          Delete Connection
        </button>
      )}
      {(nodeId || edgeId || selectionCount) && <div className="menu-sep" />}
      <button onClick={onClose}>Cancel</button>
    </div>
  );
}

// ===== Tooltip Styles =====

const TOOLTIP_STYLES: Record<string, { bg: string; border: string; icon: string; label: string }> = {
  info:     { bg: TOOLTIP_INFO_BG, border: TOOLTIP_INFO_BORDER, icon: '\u2139\uFE0F', label: 'Info' },
  warning:  { bg: TOOLTIP_WARNING_BG, border: TOOLTIP_WARNING_BORDER, icon: '\u26A0\uFE0F', label: 'Warning' },
  teaching: { bg: TOOLTIP_TEACHING_BG, border: TOOLTIP_TEACHING_BORDER, icon: '\uD83C\uDF93', label: 'Teaching' },
};

// ===== HighlightRing Component =====

export function HighlightRing({ nodeId }: { nodeId: string }) {
  const [pos, setPos] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const prevRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  useEffect(() => {
    const update = () => {
      const el = document.querySelector(`[data-node-id="${nodeId}"]`);
      if (el) {
        const r = el.getBoundingClientRect();
        const nx = r.x - 6, ny = r.y - 6, nw = r.width + 12, nh = r.height + 12;
        const p = prevRef.current;
        if (!p || Math.abs(nx - p.x) > 0.5 || Math.abs(ny - p.y) > 0.5 || Math.abs(nw - p.w) > 0.5 || Math.abs(nh - p.h) > 0.5) {
          const next = { x: nx, y: ny, w: nw, h: nh };
          prevRef.current = next;
          setPos(next);
        }
      }
      rafRef.current = requestAnimationFrame(update);
    };
    rafRef.current = requestAnimationFrame(update);
    return () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); };
  }, [nodeId]);

  if (!pos) return null;
  return (
    <div
      className="rc-highlight-ring"
      style={{ left: pos.x, top: pos.y, width: pos.w, height: pos.h }}
    />
  );
}

// ===== Tooltip Component =====

export function Tooltip({ nodeId, text, type, onClose, requireOk, onOk, index }: {
  nodeId: string;
  text: string;
  type?: string;
  onClose: () => void;
  requireOk?: boolean;
  onOk?: () => void;
  index?: number;
}) {
  const style = TOOLTIP_STYLES[type || 'info'] || TOOLTIP_STYLES.info;
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [side, setSide] = useState<'left' | 'right'>('right');
  const rafRef = useRef<number | null>(null);
  const prevRef = useRef<{ x: number; y: number; side: string } | null>(null);
  const yOffset = (index || 0) * 60;

  useEffect(() => {
    const update = () => {
      const el = document.querySelector(`[data-node-id="${nodeId}"]`);
      if (el) {
        const r = el.getBoundingClientRect();
        const midX = r.x + r.width / 2;
        const screenMid = window.innerWidth / 2;
        const newSide: 'left' | 'right' = midX > screenMid ? 'left' : 'right';
        const nx = newSide === 'right' ? r.x + r.width + 20 : r.x - 20;
        const ny = newSide === 'right' ? r.y + r.height * 0.3 + yOffset : r.y + r.height * 0.7 + yOffset;
        const p = prevRef.current;
        if (!p || Math.abs(nx - p.x) > 0.5 || Math.abs(ny - p.y) > 0.5 || p.side !== newSide) {
          prevRef.current = { x: nx, y: ny, side: newSide };
          setSide(newSide);
          setPos({ x: nx, y: ny });
        }
      }
      rafRef.current = requestAnimationFrame(update);
    };
    rafRef.current = requestAnimationFrame(update);
    return () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); };
  }, [nodeId, yOffset]);

  if (!pos) return null;

  const tooltipStyle: React.CSSProperties = {
    left: side === 'right' ? pos.x : undefined,
    right: side === 'left' ? (window.innerWidth - pos.x) : undefined,
    top: pos.y,
    transform: 'translateY(-50%)',
    background: style.bg,
    borderColor: style.border,
  };

  const arrowStyle: React.CSSProperties = side === 'right'
    ? { left: -10, borderRight: `10px solid ${style.border}` }
    : { right: -10, borderLeft: `10px solid ${style.border}` };

  return (
    <div className={`rc-tooltip rc-tooltip-${type || 'info'}`} style={tooltipStyle}>
      <div className="rc-tooltip-arrow" style={arrowStyle} />
      <div className="rc-tooltip-header">
        <span className="rc-tooltip-type">{`${style.icon} ${style.label}`}</span>
        {!requireOk && <button className="rc-tooltip-close" onClick={onClose}>{'\u2715'}</button>}
      </div>
      <div>{text}</div>
      {requireOk && <button className="rc-tooltip-ok" onClick={onOk}>OK</button>}
    </div>
  );
}
