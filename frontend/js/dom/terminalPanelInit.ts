/**
 * Terminal (AI Chat) panel initialization — vanilla JS DOM manipulation.
 *
 * Handles toggle visibility, feature flag check, and chat initialization.
 */

import { initGlobalChat } from '../chat.js';
import { DELAY_RESIZE_EVENT } from '../constants.js';

export function initTerminalPanel(): void {
  const terminalPanel = document.getElementById('terminal-panel');
  const terminalEdgeTab = document.getElementById('terminal-edge-tab');
  const terminalCloseBtn = document.getElementById('terminal-close-btn');

  function isTerminalVisible() {
    return terminalPanel && !terminalPanel.classList.contains('terminal-panel-hidden');
  }

  function toggleTerminalPanel() {
    const visible = isTerminalVisible();

    if (!visible) {
      terminalPanel!.classList.remove('terminal-panel-hidden');
      const arrow = terminalEdgeTab?.querySelector('.tab-arrow');
      if (arrow) arrow.textContent = '▶';

      const container = document.getElementById('terminal-container');
      if (container) {
        initGlobalChat(container);
      }
    } else {
      terminalPanel!.classList.add('terminal-panel-hidden');
      const arrow = terminalEdgeTab?.querySelector('.tab-arrow');
      if (arrow) arrow.textContent = '◀';
    }
    setTimeout(() => window.dispatchEvent(new Event('resize')), DELAY_RESIZE_EVENT);
  }

  if (terminalEdgeTab) terminalEdgeTab.addEventListener('click', toggleTerminalPanel);
  if (terminalCloseBtn) terminalCloseBtn.addEventListener('click', () => {
    if (isTerminalVisible()) toggleTerminalPanel();
  });

  // Check feature flags and app-state before showing chat
  Promise.all([
    fetch('/api/config').then(r => r.json()).catch(() => ({})),
    fetch('/api/app-state').then(r => r.json()).catch(() => ({})),
  ]).then(([config, state]) => {
    if (!config.features?.rina) {
      if (terminalPanel) terminalPanel.style.display = 'none';
      if (terminalEdgeTab) terminalEdgeTab.style.display = 'none';
      return;
    }
    if (state.chatEnabled === false) {
      if (terminalPanel) terminalPanel.style.display = 'none';
      if (terminalEdgeTab) terminalEdgeTab.style.display = 'none';
    } else {
      toggleTerminalPanel();
    }
  }).catch(() => {
    if (terminalPanel) terminalPanel.style.display = 'none';
    if (terminalEdgeTab) terminalEdgeTab.style.display = 'none';
  });
}
