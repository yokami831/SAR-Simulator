/**
 * chat.tsx — Chat UI for HiyoCanvas (voice-agent bridge)
 *
 * Global singleton ChatInstance connected to voice-agent (port 18733).
 * Handles both text input and voice (STT/TTS) through a single SDK session.
 * Lifecycle: init() → detach()/attach() → dispose()
 */
import { createElement as h, useState, useEffect, useRef, useCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { VOICE_WS_RECONNECT_ERROR, VOICE_WS_RECONNECT_CLOSE } from './constants.js';

// Configure marked for safe rendering
marked.setOptions({ breaks: true, gfm: true });

let _voiceWsUrl: string | null = null;

async function fetchVoiceWsUrl(): Promise<string | null> {
    if (_voiceWsUrl) return _voiceWsUrl;
    try {
        const resp = await fetch('/api/config');
        if (!resp.ok) return null;
        const config = await resp.json();
        _voiceWsUrl = config.voice_ws || null;
        return _voiceWsUrl;
    } catch {
        return null;
    }
}

// --- Types ---

interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    source?: 'input';  // 'input' = typed by user (for duplicate detection)
    toolUses?: { name: string; status: 'running' | 'done' }[];
    isStreaming?: boolean;
}

// --- ChatInstance class ---

export class ChatInstance {
    tabId: string;
    workspacePath: string | null;
    messages: ChatMessage[] = [];
    isStreaming = false;
    voiceWs: WebSocket | null = null;
    voiceActive = false;
    voiceConnected = false;
    userSpeaking = false;
    private disposed = false;
    private reactRoot: Root | null = null;
    private renderCallback: (() => void) | null = null;
    private voiceReconnectTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(tabId: string, workspacePath?: string | null) {
        this.tabId = tabId;
        this.workspacePath = workspacePath || null;
    }

    /** Create React root in container and connect WebSocket */
    init(container: HTMLElement): void {
        if (this.reactRoot) return;
        container.innerHTML = '';
        this.reactRoot = createRoot(container);
        this.renderChat();
        this.connectVoiceWebSocket();
    }

    /** Unmount React from DOM but keep WS + messages */
    detach(): void {
        if (this.reactRoot) {
            this.reactRoot.unmount();
            this.reactRoot = null;
        }
        this.renderCallback = null;
    }

    /** Re-mount React into a new container, re-render with existing messages */
    attach(container: HTMLElement): void {
        container.innerHTML = '';
        this.reactRoot = createRoot(container);
        this.renderChat();
    }

    /** Full cleanup: close WS, unmount React */
    dispose(): void {
        this.disposed = true;
        if (this.voiceReconnectTimer) {
            clearTimeout(this.voiceReconnectTimer);
            this.voiceReconnectTimer = null;
        }
        if (this.voiceWs) {
            this.voiceWs.onclose = null;
            this.voiceWs.close();
            this.voiceWs = null;
        }
        if (this.reactRoot) {
            this.reactRoot.unmount();
            this.reactRoot = null;
        }
        this.renderCallback = null;
    }

    /** Append a single message to the chat log (write-only, no UI restore) */
    private async appendToLog(role: string, content: string): Promise<void> {
        try {
            await fetch('/api/chat-log', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role, content }),
            });
        } catch {
            // Ignore log errors
        }
    }

    /** Send user message via voice-agent bridge */
    sendMessage(text: string): void {
        if (!text.trim()) return;
        this.messages.push({ role: 'user', content: text, source: 'input' });
        // Show thinking indicator immediately while waiting for response
        this.messages.push({ role: 'assistant', content: '', isStreaming: true });
        this.isStreaming = true;
        if (this.voiceWs && this.voiceWs.readyState === WebSocket.OPEN) {
            this.voiceWs.send(JSON.stringify({ type: 'text_input', text }));
        }
        this.triggerRender();
        this.appendToLog('user', text);
    }

    /** Abort current response */
    abort(): void {
        if (this.voiceWs && this.voiceWs.readyState === WebSocket.OPEN) {
            this.voiceWs.send(JSON.stringify({ type: 'abort' }));
        }
    }

    /** Toggle voice (mic + TTS) on/off */
    toggleVoice(): void {
        if (!this.voiceWs || this.voiceWs.readyState !== WebSocket.OPEN) return;
        this.voiceActive = !this.voiceActive;
        if (!this.voiceActive) this.userSpeaking = false;
        this.voiceWs.send(JSON.stringify({ type: 'mic_toggle', enabled: this.voiceActive }));
        this.voiceWs.send(JSON.stringify({ type: 'set_voice', enabled: this.voiceActive }));
        this.triggerRender();
    }

    /** Connect WebSocket to voice-agent bridge */
    private async connectVoiceWebSocket(): Promise<void> {
        if (this.disposed) return;
        if (this.voiceReconnectTimer) {
            clearTimeout(this.voiceReconnectTimer);
            this.voiceReconnectTimer = null;
        }

        await fetchVoiceWsUrl();
        if (!_voiceWsUrl) {
            // Voice agent not configured, retry later
            this.voiceReconnectTimer = setTimeout(() => this.connectVoiceWebSocket(), VOICE_WS_RECONNECT_ERROR);
            return;
        }

        this.voiceWs = new WebSocket(_voiceWsUrl);

        this.voiceWs.onopen = () => {
            this.voiceConnected = true;
            // Default: audio OFF
            this.voiceWs!.send(JSON.stringify({ type: 'mic_toggle', enabled: false }));
            this.voiceWs!.send(JSON.stringify({ type: 'set_voice', enabled: false }));
            // Show typing indicator while waiting for greeting
            this.messages.push({ role: 'assistant', content: '', isStreaming: true });
            this.triggerRender();
        };

        this.voiceWs.onmessage = (event: MessageEvent) => {
            try {
                const msg = JSON.parse(event.data);
                this.handleVoiceMessage(msg);
            } catch {
                // ignore non-JSON
            }
        };

        this.voiceWs.onclose = () => {
            if (this.disposed) return;
            this.voiceConnected = false;
            this.voiceActive = false;
            this.triggerRender();
            this.voiceReconnectTimer = setTimeout(() => this.connectVoiceWebSocket(), VOICE_WS_RECONNECT_CLOSE);
        };

        this.voiceWs.onerror = () => {
            // onclose will fire after this
        };
    }

    /** Find the last assistant message (streaming or not) */
    private findLastAssistant(): ChatMessage | undefined {
        for (let i = this.messages.length - 1; i >= 0; i--) {
            if (this.messages[i].role === 'assistant') return this.messages[i];
        }
        return undefined;
    }

    /** Handle messages from voice-agent bridge */
    private handleVoiceMessage(msg: { type: string; text?: string; status?: string }): void {
        switch (msg.type) {
            case 'user_text':
                // STT transcription or text-input echo-back
                if (msg.text) {
                    // Skip if already displayed by sendMessage() (text input)
                    const isDuplicate = this.messages.some(
                        m => m.role === 'user' && m.source === 'input' && m.content === msg.text
                    );
                    if (isDuplicate) break;
                    this.messages.push({ role: 'user', content: msg.text });
                    // Show thinking indicator for voice input
                    this.messages.push({ role: 'assistant', content: '', isStreaming: true });
                    this.isStreaming = true;
                    this.appendToLog('user', msg.text);
                    this.triggerRender();
                }
                break;

            case 'message_start': {
                this.isStreaming = true;
                // Reuse existing streaming bubble (e.g. from greeting wait) if present
                const existing = this.findLastAssistant();
                if (!existing || !existing.isStreaming) {
                    this.messages.push({ role: 'assistant', content: '', isStreaming: true });
                }
                this.triggerRender();
                break;
            }

            case 'text_delta': {
                // Find the last assistant message (may not be the very last if user_text arrived late)
                const assistantMsg = this.findLastAssistant();
                if (assistantMsg) {
                    assistantMsg.content += msg.text || '';
                    this.triggerRender();
                }
                break;
            }

            case 'message_end': {
                const assistantMsg = this.findLastAssistant();
                if (assistantMsg) {
                    assistantMsg.isStreaming = false;
                    this.appendToLog('assistant', assistantMsg.content);
                }
                this.isStreaming = false;
                this.triggerRender();
                break;
            }

            case 'tool_status': {
                // Use the LAST message only if it's an assistant message;
                // otherwise create a new assistant bubble so tool status
                // appears below the user's latest message, not above it.
                const lastMsg = this.messages[this.messages.length - 1];
                let assistantMsg = (lastMsg && lastMsg.role === 'assistant') ? lastMsg : undefined;
                if (!assistantMsg) {
                    this.messages.push({ role: 'assistant', content: '', isStreaming: true });
                    assistantMsg = this.messages[this.messages.length - 1];
                }
                if (!assistantMsg.toolUses) assistantMsg.toolUses = [];
                const toolName = (msg as any).name || 'Tool';
                const status = (msg as any).status || 'running';
                const existing = assistantMsg.toolUses.find(t => t.name === toolName && t.status === 'running');
                if (status === 'done' && existing) {
                    existing.status = 'done';
                } else if (status === 'running') {
                    assistantMsg.toolUses.push({ name: toolName, status: 'running' });
                }
                this.triggerRender();
                break;
            }

            case 'vad_state':
                this.userSpeaking = !!msg.speaking;
                this.triggerRender();
                break;

            case 'voice_status':
                break;
        }
    }

    /** Trigger React re-render */
    private triggerRender(): void {
        if (this.renderCallback) this.renderCallback();
        else this.renderChat();
    }

    /** Render ChatPanel into React root */
    private renderChat(): void {
        if (!this.reactRoot) return;
        this.reactRoot.render(
            h(ChatPanel, {
                instance: this,
                onRegisterUpdate: (cb: () => void) => { this.renderCallback = cb; },
            })
        );
    }

}

// --- React Components ---

function ChatPanel({ instance, onRegisterUpdate }: {
    instance: ChatInstance;
    onRegisterUpdate: (cb: () => void) => void;
}) {
    const [, setTick] = useState(0);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Register re-render callback
    useEffect(() => {
        onRegisterUpdate(() => setTick(t => t + 1));
    }, [onRegisterUpdate]);

    // Auto-scroll to bottom on new messages
    useEffect(() => {
        const el = messagesEndRef.current;
        if (el) {
            const container = el.parentElement;
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        }
    });

    const handleSend = useCallback(() => {
        const text = textareaRef.current?.value?.trim();
        if (!text || instance.isStreaming) return;
        instance.sendMessage(text);
        if (textareaRef.current) textareaRef.current.value = '';
    }, [instance]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    }, [handleSend]);

    const handleAbort = useCallback(() => {
        instance.abort();
    }, [instance]);

    const handleMicToggle = useCallback(() => {
        instance.toggleVoice();
    }, [instance]);

    return h('div', { className: 'chat-container' },
        // Messages area
        h('div', { className: 'chat-messages' },
            instance.messages.map((msg, i) => h(ChatBubble, { key: i, message: msg })),
            h('div', { ref: messagesEndRef }),
        ),
        // Input area
        h('div', { className: 'chat-input-area' },
            h('textarea', {
                ref: textareaRef,
                className: 'chat-textarea',
                placeholder: instance.voiceActive
                    ? 'Voice active — speak or type...'
                    : instance.isStreaming
                        ? 'Waiting for response...'
                        : 'Type a message... (Enter to send)',
                disabled: false,
                rows: 1,
                onKeyDown: handleKeyDown,
                onInput: (e: React.FormEvent<HTMLTextAreaElement>) => {
                    // Auto-grow textarea
                    const el = e.currentTarget;
                    el.style.height = 'auto';
                    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
                },
            }),
            instance.isStreaming
                ? h('button', { className: 'chat-stop-btn', onClick: handleAbort, title: 'Stop' }, '■')
                : h('button', { className: 'chat-send-btn', onClick: handleSend, disabled: instance.isStreaming, title: 'Send' }, '➤'),
            // Mic toggle button (right side)
            instance.voiceConnected && h('button', {
                className: `chat-mic-btn${instance.voiceActive ? ' active' : ''}${instance.userSpeaking ? ' speaking' : ''}`,
                onClick: handleMicToggle,
                title: instance.voiceActive ? 'Disable voice' : 'Enable voice',
            }, instance.voiceActive ? '🔴' : '🎤'),
        ),
    );
}

function friendlyToolName(name: string): string {
    if (name === 'Bash') return 'Running command';
    if (name === 'Read') return 'Reading file';
    if (name === 'Write') return 'Writing file';
    if (name === 'Edit') return 'Editing file';
    if (name === 'Grep') return 'Searching';
    if (name === 'Glob') return 'Finding files';
    return name;
}

function ChatBubble({ message }: { message: ChatMessage }) {
    if (message.role === 'system') {
        return h('div', { className: 'chat-system' }, message.content);
    }

    const isUser = message.role === 'user';

    // Render tool indicators (running + recently done)
    const tools = message.toolUses || [];

    return h('div', { className: `chat-bubble-row ${isUser ? 'user' : 'assistant'}` },
        // Avatar
        h('div', { className: `chat-avatar ${isUser ? 'user-avatar' : 'ai-avatar'}` },
            isUser ? '👤' : '🐱',
        ),
        // Bubble
        h('div', { className: `chat-bubble ${isUser ? 'user' : 'assistant'}` },
            // Tool indicators (above content for assistant)
            !isUser && tools.length > 0 && h('div', { className: 'tool-indicators' },
                tools.map((t, i) =>
                    h('span', { key: i, className: `tool-indicator ${t.status}` },
                        t.status === 'running' ? `⏳ ${friendlyToolName(t.name)}...` : `✓ ${friendlyToolName(t.name)}`
                    )
                ),
            ),
            // Content
            isUser
                ? h('div', { className: 'chat-bubble-text' }, message.content)
                : h('div', {
                    className: 'chat-bubble-text',
                    dangerouslySetInnerHTML: {
                        __html: DOMPurify.sanitize(marked.parse(message.content || '') as string),
                    },
                }),
            // Streaming indicator
            message.isStreaming && !message.content && h('div', { className: 'chat-typing' },
                h('span', null, '●'), h('span', null, '●'), h('span', null, '●'),
            ),
        ),
    );
}

// --- Module-level instance management (global singleton) ---

let globalChat: ChatInstance | null = null;

export function initGlobalChat(container: HTMLElement): ChatInstance {
    if (globalChat) {
        globalChat.attach(container);
    } else {
        globalChat = new ChatInstance('global', null);
        globalChat.init(container);
    }
    return globalChat;
}

export function getActiveChat(): ChatInstance | null {
    return globalChat;
}
