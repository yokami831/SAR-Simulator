/**
 * blockLibraryData.ts - Block library data functions and state
 *
 * Pure data functions, types, and module state for the block library.
 * No DOM manipulation - sidebar UI is in components/BlockLibrarySidebar.tsx.
 */

import { categoryColors } from './backend.js';
import { NODE_DEFAULT_WIDTH, NODE_CODE_WIDTH } from './utils.js';
import type { Node } from '@xyflow/react';

// ===== Types =====

interface BlockParam {
  id: string
  label?: string
  dtype?: string
  default?: string
  hidden?: boolean
  category?: string
  options?: Array<{ label: string; value: string }>
  hide?: string
}

interface BlockPort {
  id?: string
  dtype?: string
  label?: string
  vlen?: number
  optional?: boolean
}

interface GuiWidgetDef {
  type: string
  dtype: string
}

interface BlockDef {
  id: string
  label: string
  category?: string
  flags?: string[]
  parameters: BlockParam[]
  inputs: BlockPort[]
  outputs: BlockPort[]
  gui_widget?: GuiWidgetDef
}

interface CategoryData {
  label: string
  blocks: BlockDef[]
}

interface BlockLibraryData {
  categories: Record<string, CategoryData>
}

interface BlockData {
  type: string
  label: string
  category: string
  inputs: Array<{ id: string; label: string; portType: string }>
  outputs: Array<{ id: string; label: string; portType: string }>
  params: string
  defaultParameters: Record<string, string>
  gui_widget?: GuiWidgetDef
}

// ===== Module State =====

let blockCache: BlockLibraryData | null = null;

let blockIndex: Map<string, { block: BlockDef; catPath: string }> | null = null;

type SetNodes = React.Dispatch<React.SetStateAction<Node[]>>;
let _setNodesRef: SetNodes | null = null;

let _addBlockToCanvasCallback: ((blockData: BlockData) => void) | null = null;

/** Counter for generating unique node IDs.
 *  Starts at 100 to avoid collisions with demo/initial nodes (n1, n2, n3). */
let nodeIdCounter = 100;

// ===== Exported Accessors =====

/**
 * Set the React Flow setNodes reference.
 * Called by the App component after mounting to allow
 * block library and components to update node state.
 */
export function setNodesRef(ref: SetNodes): void { _setNodesRef = ref; }

export function getSetNodesRef(): SetNodes | null { return _setNodesRef; }

export function setAddBlockCallback(fn: (blockData: BlockData) => void): void { _addBlockToCanvasCallback = fn; }

export function getAddBlockCallback(): ((blockData: BlockData) => void) | null { return _addBlockToCanvasCallback; }

/**
 * Look up a block definition by its GRC block type ID.
 * Searches through all categories in the cached block data.
 * Returns the raw block definition object (id, label, parameters, inputs, outputs).
 */
export function getBlockDef(blockType: string): BlockDef | null {
  if (!blockIndex) return null;
  return blockIndex.get(blockType)?.block ?? null;
}

/**
 * Look up a block and return processed data ready for node creation.
 * Returns the same format as buildBlockData (type, label, category, inputs, outputs, defaultParameters).
 * Returns null if block type not found.
 */
export function getBlockDataForNode(blockType: string): BlockData | null {
  if (!blockIndex) return null;
  const entry = blockIndex.get(blockType);
  return entry ? buildBlockData(entry.block, entry.catPath) : null;
}

/** Get the full cached block library data */
export function getBlockCache(): BlockLibraryData | null { return blockCache; }

export function getNextNodeId(): string { return `n${nodeIdCounter++}`; }

export function resetNodeIdCounter(value: number): void { nodeIdCounter = value; }

// ===== Category Classification =====

// Patterns for classifying blocks into visual categories
const CATEGORY_PATTERNS = [
  { patterns: ['source', 'waveform'], cssClass: 'source' },
  { patterns: ['sink'], cssClass: 'sink' },
  { patterns: ['gui', 'graphical', 'qtgui', 'instrument'], cssClass: 'gui' },
  { patterns: ['utility', 'comment'], cssClass: 'utility' },
  { patterns: ['hdl', 'fpga', 'amaranth', 'verilog'], cssClass: 'hdl' },
];

/**
 * Map a GRC category path (e.g. "[Core]/Waveform Generators") to a CSS class.
 * Falls back to 'processing' if no pattern matches.
 */
export function categoryToCssClass(catPath: string): string {
  const lower = catPath.toLowerCase();
  for (const { patterns, cssClass } of CATEGORY_PATTERNS) {
    if (patterns.some(p => lower.includes(p))) return cssClass;
  }
  return 'processing';
}

// ===== Default Parameters =====

/**
 * Build a default parameters object from /api/blocks parameter definitions.
 * Filters out hidden params and uses their default values.
 */
export function buildDefaultParams(paramDefs: BlockParam[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const p of paramDefs) {
    if (p.hidden) continue;
    if (p.default !== undefined && p.default !== '') {
      params[p.id] = String(p.default);
    }
  }
  return params;
}

// ===== Node Sizing =====

/**
 * Determine initial node width based on block type.
 * Viz sinks need extra width for canvas, variables are compact.
 * Other blocks adjust based on tab count.
 */
export function getInitialWidth(blockType: string): number {
  // Code blocks get wider for the textarea
  const def = getBlockDef(blockType);
  if (def?.parameters?.some(p => p.dtype === 'code')) return NODE_CODE_WIDTH;

  return NODE_DEFAULT_WIDTH;
}

// ===== Node Creation =====

/**
 * Create a React Flow node object from a block definition.
 * Centralizes node creation logic used by drag-and-drop, sidebar add,
 * WebSocket commands, and file loading.
 *
 * @param {Object} opts
 * @param {string} opts.id - Node ID
 * @param {Object} opts.position - { x, y }
 * @param {Object} opts.blockDef - Block data from buildBlockData()
 * @param {Object} [opts.paramOverrides] - Parameter values to merge over defaults
 * @param {number} [opts.width] - Explicit width (from saved file)
 * @param {number} [opts.height] - Explicit height (from saved file)
 */
export function createNode({ id, position, blockDef, paramOverrides, width, height }: {
  id: string
  position: { x: number; y: number }
  blockDef: BlockData
  paramOverrides?: Record<string, string>
  width?: number
  height?: number
}): Node {
  const mergedParams = paramOverrides
    ? { ...(blockDef.defaultParameters || {}), ...paramOverrides }
    : (blockDef.defaultParameters || {});

  return {
    id,
    type: 'canvasNode',
    position,
    style: {
      width: width || getInitialWidth(blockDef.type),
      ...(height ? { minHeight: height } : {}),
    },
    ...(height ? { height } : {}),
    data: {
      label: blockDef.label,
      category: blockDef.category,
      blockType: blockDef.type,
      inputs: blockDef.inputs?.length ? blockDef.inputs : (blockDef.gui_widget ? [{ id: 'in_0', label: '', portType: 'any' }] : []),
      outputs: blockDef.outputs?.length ? blockDef.outputs : (blockDef.gui_widget ? [{ id: 'out_0', label: '', portType: 'any' }] : []),
      params: blockDef.params || '',
      defaultParameters: mergedParams,
      ...(blockDef.gui_widget ? { gui_widget: blockDef.gui_widget } : {}),
    },
  };
}

// ===== Category Tree Parsing =====

/**
 * Parse flat category data from /api/blocks into a hierarchical tree.
 *
 * Input format:  { "[Core]/Waveform Generators": { label, blocks }, ... }
 * Output format: sorted array of { groupName, subCategories: [{ catPath, label, blocks }], directBlocks: [] }
 *
 * Category paths like "[Core]/Waveform Generators" split into:
 *   groupName = "Core", subCategory = "Waveform Generators"
 * Paths without "/" (e.g., "ADS-B") become groups with directBlocks only.
 */
export function parseCategoryTree(data: BlockLibraryData, filterText: string = '') {
  const filter = filterText.toLowerCase().trim();
  const groups = new Map();

  for (const [catPath, catData] of Object.entries(data.categories)) {
    // Filter blocks by search text
    const filteredBlocks = catData.blocks.filter(b =>
      !filter ||
      b.label.toLowerCase().includes(filter) ||
      b.id.toLowerCase().includes(filter)
    );
    if (filteredBlocks.length === 0) continue;

    // Parse path: strip brackets, split by "/"
    const stripped = catPath.replace(/^\[|\]$/g, '').replace(/\]/g, '');
    const slashIdx = stripped.indexOf('/');
    let groupName, subLabel;

    if (slashIdx >= 0) {
      groupName = stripped.substring(0, slashIdx).trim();
      subLabel = stripped.substring(slashIdx + 1).trim();
    } else {
      groupName = stripped.trim();
      subLabel = null;
    }

    if (!groups.has(groupName)) {
      groups.set(groupName, { groupName, subCategories: [], directBlocks: [] });
    }
    const group = groups.get(groupName);

    if (subLabel) {
      group.subCategories.push({ catPath, label: subLabel, blocks: filteredBlocks });
    } else {
      group.directBlocks.push(...filteredBlocks);
    }
  }

  // Sort groups alphabetically, sub-categories alphabetically within each group
  const sorted = [...groups.values()].sort((a: { groupName: string }, b: { groupName: string }) => a.groupName.localeCompare(b.groupName));
  for (const group of sorted) {
    group.subCategories.sort((a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label));
  }
  return sorted;
}

// ===== Block Data Helpers =====

/**
 * Build drag/add data object from a block definition and its category path.
 * Used by both sidebar drag-and-drop and QuickAdd dialog.
 */
export function buildBlockData(block: BlockDef, catPath: string): BlockData {
  const cssClass = categoryToCssClass(catPath);
  return {
    type: block.id,
    label: block.label.replace(/^QT\s+/i, ''),
    category: cssClass,
    inputs: (block.inputs || []).map((p, i) => ({
      id: p.id || `in_${i}`, label: p.label || p.id || `in_${i}`, portType: p.dtype || 'float',
    })),
    outputs: (block.outputs || []).map((p, i) => ({
      id: p.id || `out_${i}`, label: p.label || p.id || `out_${i}`, portType: p.dtype || 'float',
    })),
    params: '',
    defaultParameters: buildDefaultParams(block.parameters || []),
    ...(block.gui_widget ? { gui_widget: block.gui_widget } : {}),
  };
}

// ===== Data Fetching =====

/**
 * Fetch block definitions from /api/blocks and populate the cache.
 * Returns the cached block library data.
 */
export async function fetchBlockData(): Promise<BlockLibraryData> {
  try {
    const resp = await fetch('/api/blocks');
    if (!resp.ok) {
      console.error('Failed to load block library:', resp.status);
      blockCache = { categories: {} };
      blockIndex = new Map();
      return blockCache;
    }
    const data: BlockLibraryData = await resp.json();
    blockCache = data;
    blockIndex = new Map();
    for (const [catPath, catData] of Object.entries(data.categories)) {
      for (const block of catData.blocks) {
        blockIndex.set(block.id, { block, catPath });
      }
    }
    return blockCache;
  } catch (e) {
    console.error('Failed to load block library:', e);
    blockCache = { categories: {} };
    blockIndex = new Map();
    return blockCache;
  }
}

// ===== Re-export types =====

export type { BlockParam, BlockPort, GuiWidgetDef, BlockDef, CategoryData, BlockLibraryData, BlockData, SetNodes };
