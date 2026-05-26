/**
 * Custom modal dialogs replacing native confirm/prompt/alert.
 * Usage:
 *   import { rcConfirm, rcPrompt, rcAlert } from './modal.js';
 *   if (await rcConfirm('Delete this?')) { ... }
 *   const name = await rcPrompt('Enter name:', 'Default');
 *   await rcAlert('File not selected');
 */

import { ERROR_TEXT_COLOR } from './constants.js';

interface ModalButton<T> {
  label: string
  value: T
  className?: string
}

interface ModalOptions<T> {
  title?: string
  message?: string
  input?: string
  buttons: ModalButton<T>[]
}

function createModal<T>({ title, message, input, buttons }: ModalOptions<T>): Promise<T> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'rc-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'rc-modal';

    if (title) {
      const titleEl = document.createElement('div');
      titleEl.className = 'rc-modal-title';
      titleEl.textContent = title;
      modal.appendChild(titleEl);
    }

    if (message) {
      const msgEl = document.createElement('div');
      msgEl.className = 'rc-modal-message';
      msgEl.textContent = message;
      modal.appendChild(msgEl);
    }

    let inputEl: HTMLInputElement | null = null;
    if (input !== undefined) {
      inputEl = document.createElement('input');
      inputEl.className = 'rc-modal-input';
      inputEl.type = 'text';
      inputEl.value = input || '';
      inputEl.autocomplete = 'off';
      modal.appendChild(inputEl);
    }

    const btnRow = document.createElement('div');
    btnRow.className = 'rc-modal-buttons';

    const cleanup = () => { overlay.remove(); };

    buttons.forEach((btn) => {
      const b = document.createElement('button');
      b.textContent = btn.label;
      if (btn.className) b.className = btn.className;
      b.addEventListener('click', () => {
        cleanup();
        resolve(btn.value === 'input' ? (inputEl?.value ?? '') : btn.value);
      });
      btnRow.appendChild(b);
    });

    modal.appendChild(btnRow);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Focus input or primary button
    if (inputEl) {
      inputEl.focus();
      inputEl.select();
      inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          cleanup();
          resolve(inputEl!.value);
        }
        if (e.key === 'Escape') {
          cleanup();
          resolve(null);
        }
      });
    } else {
      const primaryBtn = btnRow.querySelector('.primary, .danger') || btnRow.lastChild;
      (primaryBtn as HTMLElement)?.focus();
    }

    // Escape key closes with first button's value (Cancel)
    overlay.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !inputEl) {
        cleanup();
        resolve(buttons[0].value);
      }
    });

    // Click overlay background to cancel (first button's value)
    overlay.addEventListener('click', (e: MouseEvent) => {
      if (e.target === overlay) {
        cleanup();
        resolve(input !== undefined ? null : buttons[0].value);
      }
    });
  });
}

interface ConfirmOptions {
  title?: string
  okLabel?: string
  cancelLabel?: string
  danger?: boolean
}

export function rcConfirm(message: string, { title = '', okLabel = 'OK', cancelLabel = 'Cancel', danger = false }: ConfirmOptions = {}): Promise<boolean> {
  return createModal({
    title: title || undefined,
    message,
    buttons: [
      { label: cancelLabel, value: false },
      { label: okLabel, value: true, className: danger ? 'danger' : 'primary' },
    ],
  });
}

export function rcPrompt(message: string, defaultValue: string = '', { title = '' }: { title?: string } = {}): Promise<string | null> {
  return createModal<string | null>({
    title: title || undefined,
    message,
    input: defaultValue,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'OK', value: 'input' as string | null, className: 'primary' },
    ],
  });
}

/** Two-field dialog: title + description. Returns { title, description } or null if cancelled. */
export function rcNewFlow({ title = 'New Workspace', errorMessage = '', initialTitle = '', initialDescription = '', submitLabel = 'Create' }: { title?: string; errorMessage?: string; initialTitle?: string; initialDescription?: string; submitLabel?: string } = {}): Promise<{ title: string; description: string } | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'rc-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'rc-modal';

    const titleEl = document.createElement('div');
    titleEl.className = 'rc-modal-title';
    titleEl.textContent = title;
    modal.appendChild(titleEl);

    // Error message area
    const errorEl = document.createElement('div');
    errorEl.className = 'rc-modal-error';
    errorEl.style.cssText = `color: ${ERROR_TEXT_COLOR}; font-size: 13px; margin-bottom: 8px; display: none;`;
    if (errorMessage) {
      errorEl.textContent = errorMessage;
      errorEl.style.display = 'block';
    }
    modal.appendChild(errorEl);

    // Title input
    const titleLabel = document.createElement('label');
    titleLabel.className = 'rc-modal-label';
    titleLabel.textContent = 'Title (required)';
    modal.appendChild(titleLabel);
    const titleInput = document.createElement('input');
    titleInput.className = 'rc-modal-input';
    titleInput.type = 'text';
    titleInput.placeholder = 'e.g. Signal Analysis';
    titleInput.autocomplete = 'off';
    titleInput.value = initialTitle;
    modal.appendChild(titleInput);

    // Description input
    const descLabel = document.createElement('label');
    descLabel.className = 'rc-modal-label';
    descLabel.textContent = 'Description (optional)';
    modal.appendChild(descLabel);
    const descInput = document.createElement('textarea');
    descInput.className = 'rc-modal-input';
    descInput.rows = 4;
    descInput.placeholder = 'Brief description of this flow...';
    descInput.value = initialDescription;
    descInput.style.resize = 'vertical';
    modal.appendChild(descInput);

    const btnRow = document.createElement('div');
    btnRow.className = 'rc-modal-buttons';

    const cleanup = () => { overlay.remove(); };
    const submit = () => {
      const t = titleInput.value.trim();
      if (!t) { titleInput.focus(); return; }
      cleanup();
      resolve({ title: t, description: descInput.value.trim() });
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => { cleanup(); resolve(null); });
    btnRow.appendChild(cancelBtn);

    const okBtn = document.createElement('button');
    okBtn.textContent = submitLabel;
    okBtn.className = 'primary';
    okBtn.addEventListener('click', submit);
    btnRow.appendChild(okBtn);

    modal.appendChild(btnRow);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    titleInput.focus();
    titleInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      if (e.key === 'Escape') { cleanup(); resolve(null); }
    });
    descInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
      if (e.key === 'Escape') { cleanup(); resolve(null); }
    });
    overlay.addEventListener('click', (e: MouseEvent) => {
      if (e.target === overlay) { cleanup(); resolve(null); }
    });
  });
}

export function rcConfirmSave(title: string): Promise<'save' | 'discard' | 'cancel'> {
  return createModal<'save' | 'discard' | 'cancel'>({
    title: 'Save changes?',
    message: `"${title}" has unsaved changes.`,
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: "Don't Save", value: 'discard' },
      { label: 'Save', value: 'save', className: 'primary' },
    ],
  });
}

export function rcAlert(message: string, { title = '' }: { title?: string } = {}): Promise<boolean> {
  return createModal({
    title: title || undefined,
    message,
    buttons: [
      { label: 'OK', value: true, className: 'primary' },
    ],
  });
}

/**
 * Style editor modal for decorative nodes (comment, frame).
 *
 * Renders a small form of typed fields (color / enum / text) and resolves
 * with the new values when the user clicks Apply, or null on Cancel.
 * Kept here (DOM-based) rather than as a React component so it can be
 * launched from anywhere via a Promise — same ergonomics as rcPrompt.
 */
export interface StyleField {
  id: string;
  label: string;
  dtype: 'color' | 'enum' | 'text';
  default?: string;
  options?: string[];   // for dtype: 'enum'
}

export function rcStyleEditor(
  fields: StyleField[],
  initial: Record<string, string>,
  { title = 'Edit Style' }: { title?: string } = {},
): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'rc-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'rc-modal rc-style-editor';

    if (title) {
      const titleEl = document.createElement('div');
      titleEl.className = 'rc-modal-title';
      titleEl.textContent = title;
      modal.appendChild(titleEl);
    }

    const inputs: Record<string, HTMLInputElement | HTMLSelectElement> = {};
    const swatches: Record<string, HTMLInputElement> = {};

    fields.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'rc-style-row';
      const lbl = document.createElement('div');
      lbl.className = 'rc-style-label';
      lbl.textContent = f.label;
      row.appendChild(lbl);

      const value = initial[f.id] !== undefined ? initial[f.id] : (f.default || '');

      if (f.dtype === 'color') {
        // swatch + text + "Clear" button. The text input accepts CSS values
        // a native picker can't (rgba(), transparent, named colors). The
        // Clear button is the discoverable way to wipe to transparent, since
        // typing "transparent" isn't obvious to first-time users.
        const wrap = document.createElement('div');
        wrap.className = 'rc-style-color';
        const sw = document.createElement('input');
        sw.type = 'color';
        sw.className = 'rc-style-swatch';
        sw.value = /^#[0-9a-fA-F]{6}$/.test(value.trim()) ? value.trim() : '#000000';
        const txt = document.createElement('input');
        txt.type = 'text';
        txt.className = 'rc-style-input';
        txt.value = value;
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'rc-style-clear';
        clearBtn.textContent = 'Transparent';
        clearBtn.title = 'Clear color (set to transparent)';
        sw.addEventListener('input', () => { txt.value = sw.value; });
        txt.addEventListener('input', () => {
          if (/^#[0-9a-fA-F]{6}$/.test(txt.value.trim())) sw.value = txt.value.trim();
        });
        clearBtn.addEventListener('click', () => { txt.value = 'transparent'; });
        wrap.appendChild(sw);
        wrap.appendChild(txt);
        wrap.appendChild(clearBtn);
        row.appendChild(wrap);
        inputs[f.id] = txt;
        swatches[f.id] = sw;
      } else if (f.dtype === 'enum') {
        const sel = document.createElement('select');
        sel.className = 'rc-style-input';
        (f.options || []).forEach((opt) => {
          const o = document.createElement('option');
          o.value = opt; o.textContent = opt;
          if (opt === value) o.selected = true;
          sel.appendChild(o);
        });
        row.appendChild(sel);
        inputs[f.id] = sel;
      } else {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'rc-style-input';
        inp.value = value;
        row.appendChild(inp);
        inputs[f.id] = inp;
      }

      modal.appendChild(row);
    });

    const cleanup = () => { overlay.remove(); };

    const btnRow = document.createElement('div');
    btnRow.className = 'rc-modal-buttons';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => { cleanup(); resolve(null); });
    const apply = document.createElement('button');
    apply.textContent = 'Apply';
    apply.className = 'primary';
    apply.addEventListener('click', () => {
      const out: Record<string, string> = {};
      for (const f of fields) out[f.id] = inputs[f.id]?.value ?? '';
      cleanup();
      resolve(out);
    });
    btnRow.appendChild(cancel);
    btnRow.appendChild(apply);
    modal.appendChild(btnRow);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { cleanup(); resolve(null); }
    });
  });
}
