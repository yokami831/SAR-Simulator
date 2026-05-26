/**
 * tabRegistry.ts - Plugin-based tab type registry
 *
 * Each tab type registers its component, UI config, tool actions, and metadata.
 * To add a new tab type:
 *   1. Call registerTabType(id, definition) — registers metadata + plugin fields
 *   2. Call registerTabComponent(id, Component) — registers the React component
 *   Both can be done from the tab's own module (self-registration pattern).
 */

import type { ComponentType } from 'react'
import type { TabTypeDefinition, TabUiConfig, TabContentProps, TabPluginContext, ToolbarProps } from './types.js'

const DEFAULT_UI_CONFIG: Required<TabUiConfig> = {
  showBlockLibrary: true,
  showToolbar: true,
  containerClass: '',
}

export const TAB_TYPES: TabTypeDefinition[] = [
  {
    id: 'flow',
    label: 'Flow',
    icon: '\uD83D\uDD27',
    description: 'Visual flow execution with Jupyter kernel',
    defaultTitle: 'New Flow',
    uiConfig: { showBlockLibrary: true, showToolbar: true },
  },
  // mindmap, excalidraw, notes are registered via registerTabType() from their modules
]

export function getTabType(id: string): TabTypeDefinition | undefined {
  return TAB_TYPES.find(t => t.id === id)
}

/** Register a new tab type or merge overrides into an existing one */
export function registerTabType(id: string, def: Omit<TabTypeDefinition, 'id'>): void {
  const existing = TAB_TYPES.find(t => t.id === id)
  if (existing) {
    Object.assign(existing, def)
  } else {
    TAB_TYPES.push({ id, ...def })
  }
}

/** Register a React component for a tab type (call after import) */
export function registerTabComponent(id: string, component: ComponentType<TabContentProps>): void {
  const entry = TAB_TYPES.find(t => t.id === id)
  if (entry) {
    entry.component = component
  } else {
    console.warn(`registerTabComponent: unknown tab type "${id}"`)
  }
}

/** Register a toolbar component for a tab type */
export function registerToolbarComponent(id: string, toolbar: ComponentType<ToolbarProps> | null): void {
  const entry = TAB_TYPES.find(t => t.id === id)
  if (entry) {
    entry.toolbarComponent = toolbar
  } else {
    console.warn(`registerToolbarComponent: unknown tab type "${id}"`)
  }
}

/** Get resolved UI config for a tab type, with defaults applied */
export function getTabUiConfig(id: string | undefined): Required<TabUiConfig> {
  if (!id) return { showBlockLibrary: false, showToolbar: false, containerClass: '' }
  const entry = TAB_TYPES.find(t => t.id === id)
  return { ...DEFAULT_UI_CONFIG, ...entry?.uiConfig }
}

/**
 * Find a tab type that handles the given tool action.
 * If activeTabTypeId is provided, prefer that tab type when multiple types handle the same action.
 */
export function findTabTypeForAction(action: string, activeTabTypeId?: string): TabTypeDefinition | undefined {
  // Prefer active tab type if it handles this action
  if (activeTabTypeId) {
    const active = TAB_TYPES.find(t => t.id === activeTabTypeId && t.toolActions?.[action])
    if (active) return active
  }
  return TAB_TYPES.find(t => t.toolActions?.[action])
}
