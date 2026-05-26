/**
 * NoteEditor.tsx — BlockNote editor wrapper for the Notes tab.
 *
 * Renders a Notion-style block editor. Re-created on page switch via key prop.
 * Supports image paste/upload via the uploadFile callback.
 * Supports Ctrl+wheel zoom (transform: scale).
 */

import { useMemo, useState, useRef, useCallback, useEffect, createElement as h } from 'react'
import { BlockNoteEditor, type PartialBlock, type Block } from '@blocknote/core'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'

interface NoteEditorProps {
  initialContent: PartialBlock[] | undefined
  onChange: (content: Block[]) => void
  uploadFile: (file: File) => Promise<string>
}

export function NoteEditor({ initialContent, onChange, uploadFile }: NoteEditorProps) {
  const editor = useMemo(() => {
    return BlockNoteEditor.create({
      initialContent: initialContent && initialContent.length > 0 ? initialContent : undefined,
      uploadFile,
    })
  }, []) // Editor is re-created via key prop on parent, not via deps

  const [zoom, setZoom] = useState(1.0)
  const [showIndicator, setShowIndicator] = useState(false)
  const indicatorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flashIndicator = useCallback(() => {
    setShowIndicator(true)
    if (indicatorTimer.current) clearTimeout(indicatorTimer.current)
    indicatorTimer.current = setTimeout(() => setShowIndicator(false), 1500)
  }, [])

  // Ctrl+wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey) return
    e.preventDefault()
    e.stopPropagation()
    setZoom(prev => {
      const step = e.deltaY > 0 ? -0.1 : 0.1
      const next = Math.round(Math.max(0.5, Math.min(2.0, prev + step)) * 10) / 10
      return next
    })
    flashIndicator()
  }, [flashIndicator])

  // Ctrl+0 to reset zoom
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '0') {
        e.preventDefault()
        setZoom(1.0)
        flashIndicator()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [flashIndicator])

  useEffect(() => {
    return () => {
      if (indicatorTimer.current) clearTimeout(indicatorTimer.current)
    }
  }, [])

  return h('div', { className: 'notes-zoom-container', onWheel: handleWheel },
    h('div', {
      className: 'notes-zoom-inner',
      style: {
        transform: zoom !== 1 ? `scale(${zoom})` : undefined,
        transformOrigin: 'top left',
        width: zoom !== 1 ? `${100 / zoom}%` : undefined,
      },
    },
      h(BlockNoteView, {
        editor,
        theme: 'dark',
        onChange: () => onChange(editor.document),
      }),
    ),
    // Zoom indicator
    h('div', {
      className: `notes-zoom-indicator${showIndicator ? ' visible' : ''}`,
    }, `${Math.round(zoom * 100)}%`),
  )
}
