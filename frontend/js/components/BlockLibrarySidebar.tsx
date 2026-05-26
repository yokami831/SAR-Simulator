/**
 * BlockLibrarySidebar.tsx — React component for the block library sidebar
 *
 * Replaces the DOM-based sidebar rendering.
 * Renders directly inside #content-area with position: absolute,
 * same pattern as NotesSidebar and MindMap NodeStylePanel.
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { categoryColors } from '../backend.js';
import {
  categoryToCssClass, buildBlockData, parseCategoryTree, fetchBlockData,
  type BlockDef, type BlockLibraryData, type BlockData,
} from '../blockLibraryData.js';

// ===== SVG Icons per category =====
const CATEGORY_ICONS: Record<string, string> = {
  source: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h4l3-9 4 18 3-9h4"/></svg>',
  sink: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="7 13 10 16 17 9"/></svg>',
  gui: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>',
  hdl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="1"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="1" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="23"/><line x1="1" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="23" y2="12"/></svg>',
  processing: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
};

// ===== Sub-components =====

function BlockItem({ block, catPath, onAddBlock }: {
  block: BlockDef;
  catPath: string;
  onAddBlock: (data: BlockData) => void;
}) {
  const cssClass = categoryToCssClass(catPath);
  const color = categoryColors[cssClass] || '#888';
  const icon = CATEGORY_ICONS[cssClass] || CATEGORY_ICONS.processing;

  const handleDragStart = useCallback((e: React.DragEvent) => {
    const dragData = buildBlockData(block, catPath);
    e.dataTransfer.setData('application/blocktype', JSON.stringify(dragData));
    e.dataTransfer.effectAllowed = 'move';
  }, [block, catPath]);

  const handleDblClick = useCallback(() => {
    onAddBlock(buildBlockData(block, catPath));
  }, [block, catPath, onAddBlock]);

  return (
    <div
      className="block-item"
      draggable
      title={block.id}
      data-role="sidebar-block"
      data-block-id={block.id}
      onDragStart={handleDragStart}
      onDoubleClick={handleDblClick}
    >
      <span className="block-icon" style={{ color }} dangerouslySetInnerHTML={{ __html: icon }} />
      {block.label}
    </div>
  );
}

function CollapsibleSection({ label, count, defaultOpen, indentClass, children, catName }: {
  label: string;
  count: number;
  defaultOpen: boolean;
  indentClass?: string;
  children: React.ReactNode;
  catName?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  // Auto-expand when defaultOpen changes (e.g. filter activates)
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);

  return (
    <>
      <div
        className={`block-category-header${indentClass || ''}${open ? ' open' : ''}`}
        onClick={() => setOpen(!open)}
        data-role="sidebar-category"
        data-category={catName || label}
      >
        <span className="arrow">&#9654;</span> {label} <span className="cat-count">{count}</span>
      </div>
      <div className={`block-category-items${open ? ' open' : ''}`}>
        {children}
      </div>
    </>
  );
}

// ===== Main Component =====

interface BlockLibrarySidebarProps {
  visible: boolean;
  onToggle: () => void;
  onAddBlock: (blockData: BlockData) => void;
  blocks: BlockLibraryData | null;
}

export function BlockLibrarySidebar({ visible, onToggle, onAddBlock, blocks }: BlockLibrarySidebarProps) {
  const [filter, setFilter] = useState('');
  const [width, setWidth] = useState(200);
  const sidebarRef = useRef<HTMLDivElement>(null);

  const tree = useMemo(() =>
    blocks ? parseCategoryTree(blocks, filter) : [],
    [blocks, filter]
  );

  const totalBlockCount = useMemo(() =>
    tree.reduce((sum, g) =>
      sum + g.directBlocks.length + g.subCategories.reduce((s: number, sc: any) => s + sc.blocks.length, 0), 0),
    [tree]
  );

  // Resize handle
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarRef.current?.offsetWidth || 200;
    if (sidebarRef.current) sidebarRef.current.style.transition = 'none';

    const onMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const newW = Math.max(120, Math.min(400, startWidth + delta));
      setWidth(newW);
    };
    const onMouseUp = () => {
      if (sidebarRef.current) sidebarRef.current.style.transition = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  const hasFilter = filter.trim().length > 0;

  const sidebar = (
    <div
      id="sidebar"
      ref={sidebarRef}
      className={visible ? '' : 'sidebar-hidden'}
      style={{ width: visible ? width : undefined }}
    >
      {/* Edge tab: visible when sidebar is hidden */}
      <div
        id="sidebar-edge-tab"
        title="Toggle Block Library (Ctrl+B)"
        onClick={onToggle}
      >
        <span className="tab-arrow">{visible ? '◀' : '▶'}</span>Blocks
      </div>

      {/* Header */}
      <h2>
        BLOCK LIBRARY
        <button className="panel-close-btn" title="Close" onClick={onToggle}>&times;</button>
      </h2>

      {/* Search */}
      <div id="block-search">
        <input
          type="text"
          id="search-input"
          placeholder="Search blocks..."
          data-role="block-search"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
      </div>

      {/* Block list */}
      <div id="block-library">
        {/* Flat mode: when few blocks and no filter */}
        {totalBlockCount <= 10 && !hasFilter ? (
          tree.map(group => (
            <React.Fragment key={group.groupName}>
              {group.directBlocks.map((block: BlockDef) => (
                <BlockItem key={block.id} block={block} catPath={group.groupName} onAddBlock={onAddBlock} />
              ))}
              {group.subCategories.map((sub: any) =>
                sub.blocks.map((block: BlockDef) => (
                  <BlockItem key={block.id} block={block} catPath={sub.catPath} onAddBlock={onAddBlock} />
                ))
              )}
            </React.Fragment>
          ))
        ) : (
          tree.map(group => {
            const groupTotal = group.directBlocks.length +
              group.subCategories.reduce((s: number, sc: any) => s + sc.blocks.length, 0);
            return (
              <div className="block-category" key={group.groupName}>
                <CollapsibleSection
                  label={group.groupName}
                  count={groupTotal}
                  defaultOpen={hasFilter}
                  catName={group.groupName}
                >
                  {group.directBlocks.map((block: BlockDef) => (
                    <BlockItem key={block.id} block={block} catPath={group.groupName} onAddBlock={onAddBlock} />
                  ))}
                  {group.subCategories.map((sub: any) => (
                    <CollapsibleSection
                      key={sub.catPath}
                      label={sub.label}
                      count={sub.blocks.length}
                      defaultOpen={hasFilter}
                      indentClass=" sub"
                      catName={`${group.groupName}/${sub.label}`}
                    >
                      {sub.blocks.map((block: BlockDef) => (
                        <BlockItem key={block.id} block={block} catPath={sub.catPath} onAddBlock={onAddBlock} />
                      ))}
                    </CollapsibleSection>
                  ))}
                </CollapsibleSection>
              </div>
            );
          })
        )}
      </div>

      {/* Resize handle */}
      <div id="sidebar-resize-handle" onMouseDown={handleResizeStart} />
    </div>
  );

  return sidebar;
}
