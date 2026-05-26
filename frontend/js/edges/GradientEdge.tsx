/**
 * GradientEdge.tsx
 *
 * Custom React Flow edge that renders a left-to-right linear gradient
 * between the source node's category color and the target node's category
 * color (matching the 4px left-accent bars on the blocks).
 *
 * Wired via `edgeTypes = { rateEdge: GradientEdge }` in app.tsx. The
 * `rateEdge` type name is already set on every edge by `defaultEdgeOptions`
 * and by saved `.rcflow` files, so no migration is needed.
 *
 * Visual-only change: bezier path, default stroke width, no animation, no
 * markers added beyond React Flow's defaults.
 */

import React from 'react';
import { BaseEdge, getBezierPath, useNodesData } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';

/**
 * Category -> CSS variable color. Keys match the category class names that
 * `CanvasNode` puts on `.grc-block` (source / processing / sink / gui /
 * utility / hdl). Unknown / missing category falls back to a light neutral
 * so the gradient end is still visible.
 */
const CATEGORY_COLORS: Record<string, string> = {
  source: 'var(--block-source)',
  processing: 'var(--block-processing)',
  sink: 'var(--block-sink)',
  gui: 'var(--block-gui)',
  utility: 'var(--block-utility)',
  hdl: 'var(--block-hdl-start)',
};
const FALLBACK_COLOR = 'rgba(255, 255, 255, 0.4)';

function colorFor(node: { data?: { category?: string } } | null | undefined): string {
  const cat = node?.data?.category;
  if (cat && CATEGORY_COLORS[cat]) return CATEGORY_COLORS[cat];
  return FALLBACK_COLOR;
}

export function GradientEdge(props: EdgeProps): React.ReactElement {
  const {
    id,
    source,
    target,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    markerEnd,
    markerStart,
    style,
    selected,
  } = props;

  // Pull the source and target node payloads from the store so we can read
  // their `data.category`. `useNodesData` accepts an array of ids and
  // returns matching node data objects in the same order.
  const nodes = useNodesData([source, target]);
  const sourceColor = colorFor(nodes?.[0] as any);
  const targetColor = colorFor(nodes?.[1] as any);

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  // Unique gradient id per edge so multiple gradients don't collide in the
  // shared SVG defs scope.
  const gradId = `hcgrad-${id}`;

  // Bump stroke a touch when selected so the colored line stays visible
  // against React Flow's default selected outline.
  const baseWidth = (style as any)?.strokeWidth ?? 2;
  const strokeWidth = selected ? Math.max(Number(baseWidth) + 1, 3) : baseWidth;

  return (
    <>
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="0%" gradientUnits="objectBoundingBox">
          <stop offset="0%" stopColor={sourceColor} />
          <stop offset="100%" stopColor={targetColor} />
        </linearGradient>
      </defs>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        markerStart={markerStart}
        style={{ ...style, stroke: `url(#${gradId})`, strokeWidth }}
      />
    </>
  );
}

export default GradientEdge;
