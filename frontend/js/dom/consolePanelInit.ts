/**
 * Console panel initialization — vanilla JS DOM manipulation.
 *
 * Handles toggle, clear, resize for console panel and terminal panel resize.
 */

import { clearConsoleLogs } from '../backend.js';
import { DELAY_RESIZE_EVENT } from '../constants.js';

export function initConsolePanel(): void {
  const consolePanel = document.getElementById('console-panel');
  const consoleHeader = document.getElementById('console-header');
  const consoleClearBtn = document.getElementById('console-clear-btn');
  const consoleEdgeTab = document.getElementById('console-edge-tab');
  const resizeHandle = document.getElementById('console-resize-handle');

  function toggleConsoleHidden() {
    if (!consolePanel) return;
    const isHidden = consolePanel.classList.contains('console-hidden');
    if (isHidden) {
      consolePanel.classList.remove('console-hidden');
      consolePanel.classList.remove('console-collapsed');
      const arrow = consoleEdgeTab?.querySelector('.tab-arrow');
      if (arrow) arrow.textContent = '▼';
    } else {
      consolePanel!.classList.add('console-hidden');
      consolePanel!.classList.remove('console-collapsed');
      const arrow = consoleEdgeTab?.querySelector('.tab-arrow');
      if (arrow) arrow.textContent = '▲';
    }
    setTimeout(() => window.dispatchEvent(new Event('resize')), DELAY_RESIZE_EVENT);
  }

  if (consoleEdgeTab) consoleEdgeTab.addEventListener('click', toggleConsoleHidden);
  if (consoleHeader) consoleHeader.addEventListener('click', (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    toggleConsoleHidden();
  });

  const consoleCloseBtn = document.getElementById('console-close-btn');
  if (consoleCloseBtn) consoleCloseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!consolePanel!.classList.contains('console-hidden')) toggleConsoleHidden();
  });

  if (consoleClearBtn) consoleClearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    clearConsoleLogs();
  });

  // Resize handle: drag to resize console panel height
  if (resizeHandle) {
    let startY: number, startHeight: number;
    resizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      startY = e.clientY;
      startHeight = consolePanel!.offsetHeight;
      const onMouseMove = (ev: MouseEvent) => {
        const delta = startY - ev.clientY;
        const newH = Math.max(60, Math.min(window.innerHeight * 0.5, startHeight + delta));
        consolePanel!.style.height = newH + 'px';
      };
      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        window.dispatchEvent(new Event('resize'));
      };
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  // Terminal panel resize handle: drag to resize right panel width
  const terminalResizeHandle = document.getElementById('terminal-resize-handle');
  const terminalPanel = document.getElementById('terminal-panel');
  if (terminalResizeHandle && terminalPanel) {
    let startX: number, startWidth: number;
    terminalResizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = terminalPanel.offsetWidth;
      terminalPanel.style.transition = 'none';
      const onMouseMove = (ev: MouseEvent) => {
        const delta = startX - ev.clientX;
        const newW = Math.max(280, Math.min(600, startWidth + delta));
        terminalPanel.style.width = newW + 'px';
      };
      const onMouseUp = () => {
        terminalPanel.style.transition = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }
}
