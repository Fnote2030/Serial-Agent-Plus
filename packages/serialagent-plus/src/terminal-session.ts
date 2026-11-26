/**
 * 扩展侧终端会话（每个 Serial Monitor 一个实例）。
 *
 * 原 webview main.js 中的终端行编辑状态机（本地行缓冲、设备行对齐、Tab 补全同步、
 * ↑/↓ 历史同步、redraw 行模拟）上移至此：多视口（侧边栏 tab + 编辑器面板）共享同一份
 * 权威状态，视口只发送按键意图、接收状态快照渲染，避免跨 webview 状态打架。
 * 纯逻辑复用 media/terminal-device-line.js（环境无关 UMD 模块）。
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { reconcileBytes, createRxLineSimulator } = require('../media/terminal-device-line.js') as {
  reconcileBytes: (deviceLine: string | null, line: string, tail: string) => string;
  createRxLineSimulator: () => {
    line: { text: string; cursor: number };
    feed: (raw: string) => string[];
    reset: () => void;
  };
};

/** 视口渲染所需的最小状态快照 */
export interface TerminalState {
  /** 设备实时行（提示符 + 回显/redraw 拼接结果） */
  liveLine: string;
  /** 本地输入行内容与光标 */
  buffer: string;
  caret: number;
  /** 设备编辑缓冲持有的行（null = 为空），视口合并渲染用 */
  deviceLine: string | null;
}

/** 视口发来的按键意图（webview keydown 归一化后的抽象） */
export type TerminalKeyIntent =
  | { type: 'print'; ch: string }
  | { type: 'paste'; text: string }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'move'; delta: -1 | 1 }
  | { type: 'moveTo'; position: 'start' | 'end' }
  | { type: 'enter' }
  | { type: 'tab' }
  | { type: 'history'; direction: 'up' | 'down' }
  | { type: 'ctrlC' }
  | { type: 'escape' }
  | { type: 'passthrough'; bytes: string };

export interface TerminalSessionEvents {
  /** 需要写入串口的字节（调用方负责连接态判断与排队） */
  onTx?: (bytes: string) => void;
  /** 设备输出中提交的完整显示行（视口追加到该监视器的日志桶） */
  onLines?: (lines: string[]) => void;
  /** 状态快照发生变化（视口重渲染） */
  onStateChange?: () => void;
}

const MAX_TERMINAL_HISTORY = 50;
const HISTORY_RESTORE_MS = 200;
const SYNC_DEACTIVATE_MS = 200;
/** 单次粘贴写入的上限（字符）：避免超长剪贴板内容撑爆输入行/串口写入 */
const MAX_PASTE_CHARS = 4096;

export class TerminalSession {
  private _buffer = '';
  private _caret = 0;
  /** 设备编辑缓冲当前持有的行（null = 为空） */
  private _deviceLine: string | null = null;
  private readonly _rxSim = createRxLineSimulator();
  private readonly _rxLine = this._rxSim.line;
  private _tabSync = { active: false, sent: '' };
  private _historySync = false;
  private _terminalHistory: string[] = [];
  private _historyRestore: { buffer: string; caret: number; deviceLine: string | null } | null = null;
  private _historyRestoreTimer: ReturnType<typeof setTimeout> | null = null;
  private _syncTimers: { tab: ReturnType<typeof setTimeout> | null; history: ReturnType<typeof setTimeout> | null } = {
    tab: null,
    history: null,
  };

  constructor(private readonly _events: TerminalSessionEvents = {}) {}

  snapshot(): TerminalState {
    return {
      liveLine: this._rxLine.text,
      buffer: this._buffer,
      caret: this._caret,
      deviceLine: this._deviceLine,
    };
  }

  dispose(): void {
    this._clearSyncTimers();
    if (this._historyRestoreTimer) { clearTimeout(this._historyRestoreTimer); }
    this._historyRestoreTimer = null;
  }

  /** 重置本地编辑状态（断开连接 / 清空日志时） */
  resetEditing(): void {
    this._buffer = '';
    this._caret = 0;
    this._deviceLine = null;
    this._tabSync.active = false;
    this._historySync = false;
    this._historyRestore = null;
    if (this._historyRestoreTimer) { clearTimeout(this._historyRestoreTimer); this._historyRestoreTimer = null; }
    this._clearSyncTimers();
    this._events.onStateChange?.();
  }

  /** ANSI 清屏（ESC[2J）：清空实时行（日志桶清空由视口处理） */
  clearLive(): void {
    this._rxSim.reset();
    this._events.onStateChange?.();
  }

  /** 设备输出文本（OSC 已由调用方剥离；含完整行与 partial 分片） */
  feed(raw: string): void {
    const committed = this._rxSim.feed(raw);
    if (committed.length > 0) {
      this._events.onLines?.(committed);
    }

    // Tab 补全同步：设备 redraw 行包含发送前的缓冲时，把补全后的完整行同步回本地输入行
    if (this._tabSync.active && this._rxLine.text.includes(this._tabSync.sent)) {
      this._buffer = this._rxLine.text.slice(this._rxLine.text.indexOf(this._tabSync.sent));
      this._caret = this._buffer.length;
      this._deviceLine = this._buffer;
      this._scheduleSyncDeactivate('tab');
      this._events.onStateChange?.();
    }

    // 上下键历史同步：设备 redraw 行以历史命令结尾时（最长匹配），同步回本地输入行
    if (this._historySync) {
      let best: string | null = null;
      for (const cmd of this._terminalHistory) {
        if (cmd && this._rxLine.text.endsWith(cmd) && (best === null || cmd.length > best.length)) {
          best = cmd;
        }
      }
      if (best !== null) {
        this._cancelHistoryRestore();
        this._buffer = best;
        this._caret = best.length;
        this._deviceLine = best;
        this._scheduleSyncDeactivate('history');
        this._events.onStateChange?.();
      }
    }

    this._events.onStateChange?.();
  }

  /** 视口按键意图 → 更新状态 / 通过 onTx 输出发送字节 */
  handleKey(intent: TerminalKeyIntent): void {
    switch (intent.type) {
      case 'print': {
        const ch = intent.ch;
        if (ch.length !== 1) { return; }
        this._buffer = this._buffer.slice(0, this._caret) + ch + this._buffer.slice(this._caret);
        this._caret += 1;
        this._events.onStateChange?.();
        return;
      }
      case 'paste': {
        // 粘贴等价于逐字键入：写入光标处；换行处按行提交（与真实终端一致）
        const text = String(intent.text ?? '');
        if (!text) { return; }
        const segments = text.replace(/\r\n?/g, '\n').split('\n');
        let changed = false;
        for (let i = 0; i < segments.length; i++) {
          if (this._insertText(segments[i])) { changed = true; }
          if (i < segments.length - 1) {
            this._submitLine();
            changed = true;
          }
        }
        if (changed) { this._events.onStateChange?.(); }
        return;
      }
      case 'backspace': {
        if (this._caret > 0) {
          this._buffer = this._buffer.slice(0, this._caret - 1) + this._buffer.slice(this._caret);
          this._caret -= 1;
          this._events.onStateChange?.();
        }
        return;
      }
      case 'delete': {
        if (this._caret < this._buffer.length) {
          this._buffer = this._buffer.slice(0, this._caret) + this._buffer.slice(this._caret + 1);
          this._events.onStateChange?.();
        }
        return;
      }
      case 'move': {
        const next = this._caret + intent.delta;
        if (next >= 0 && next <= this._buffer.length) {
          this._caret = next;
          this._events.onStateChange?.();
        }
        return;
      }
      case 'moveTo': {
        const clamped = intent.position === 'start' ? 0 : this._buffer.length;
        if (clamped !== this._caret) {
          this._caret = clamped;
          this._events.onStateChange?.();
        }
        return;
      }
      case 'enter': {
        this._submitLine();
        return;
      }
      case 'tab': {
        const line = this._buffer;
        if (line) {
          this._tabSync.active = true;
          this._tabSync.sent = line;
        }
        // 必须清掉上一次补全留下的去激活定时器（快速再按 Tab 时同步失效会清空输入行）
        if (this._syncTimers.tab) { clearTimeout(this._syncTimers.tab); this._syncTimers.tab = null; }
        this._historySync = false;
        this._cancelHistoryRestore();
        if (this._syncTimers.history) { clearTimeout(this._syncTimers.history); this._syncTimers.history = null; }
        this._buffer = '';
        this._caret = 0;
        this._events.onTx?.(reconcileBytes(this._deviceLine, line, '\t'));
        this._deviceLine = line || null;
        this._events.onStateChange?.();
        return;
      }
      case 'history': {
        // 连续按键且尚无 redraw 时保留最初的快照（最后一次稳定状态）
        if (!this._historyRestore) {
          this._historyRestore = { buffer: this._buffer, caret: this._caret, deviceLine: this._deviceLine };
        }
        if (this._historyRestoreTimer) { clearTimeout(this._historyRestoreTimer); }
        this._historyRestoreTimer = setTimeout(() => this._restorePendingHistoryLine(), HISTORY_RESTORE_MS);
        this._buffer = '';
        this._caret = 0;
        this._tabSync.active = false;
        this._historySync = true;
        this._deviceLine = null;
        if (this._syncTimers.tab) { clearTimeout(this._syncTimers.tab); this._syncTimers.tab = null; }
        if (this._syncTimers.history) { clearTimeout(this._syncTimers.history); this._syncTimers.history = null; }
        this._events.onTx?.(intent.direction === 'up' ? '\x1b[A' : '\x1b[B');
        this._events.onStateChange?.();
        return;
      }
      case 'ctrlC': {
        this._buffer = '';
        this._caret = 0;
        this._deviceLine = null; // 设备收到 ^C 会丢弃编辑行
        this._cancelHistoryRestore();
        this._events.onTx?.('\x03');
        this._events.onStateChange?.();
        return;
      }
      case 'escape': {
        this._buffer = '';
        this._caret = 0;
        this._events.onTx?.('\x1b');
        this._events.onStateChange?.();
        return;
      }
      case 'passthrough': {
        this._events.onTx?.(intent.bytes);
        return;
      }
    }
  }

  /** 把文本插入光标处（粘贴用）：制表符转空格，其余控制字符丢弃；超长截断 */
  private _insertText(text: string): boolean {
    if (!text) { return false; }
    const clean = text.replace(/\t/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '');
    const room = Math.max(0, MAX_PASTE_CHARS - this._buffer.length);
    const chunk = clean.slice(0, room);
    if (!chunk) { return false; }
    this._buffer = this._buffer.slice(0, this._caret) + chunk + this._buffer.slice(this._caret);
    this._caret += chunk.length;
    return true;
  }

  /** 提交当前输入行（Enter / 粘贴换行）：发送对齐后的整行 + CR */
  private _submitLine(): void {
    const line = this._buffer;
    this._buffer = '';
    this._caret = 0;
    this._tabSync.active = false;
    this._historySync = false;
    this._clearSyncTimers();
    this._cancelHistoryRestore();
    if (line.trim()) { this._pushHistory(line); }
    // 终端回车固定发送 CR；设备行已同步时只补 CR，本地改过则先退格清空设备行
    this._events.onTx?.(reconcileBytes(this._deviceLine, line, '\r'));
    this._deviceLine = null;
    this._events.onStateChange?.();
  }

  /** msh 在最旧历史条目再按 ↑ 不重绘：超时未同步则恢复按键前的本地输入行 */
  private _restorePendingHistoryLine(): void {    this._historyRestoreTimer = null;
    if (!this._historyRestore) { return; }
    this._buffer = this._historyRestore.buffer;
    this._caret = this._historyRestore.caret;
    this._deviceLine = this._historyRestore.deviceLine;
    this._historyRestore = null;
    this._events.onStateChange?.();
  }

  private _pushHistory(line: string): void {
    if (this._terminalHistory[0] === line) { return; }
    this._terminalHistory.unshift(line);
    if (this._terminalHistory.length > MAX_TERMINAL_HISTORY) { this._terminalHistory.pop(); }
  }

  private _scheduleSyncDeactivate(kind: 'tab' | 'history'): void {
    const timer = this._syncTimers[kind];
    if (timer) { clearTimeout(timer); }
    this._syncTimers[kind] = setTimeout(() => {
      if (kind === 'tab') { this._tabSync.active = false; } else { this._historySync = false; }
      this._syncTimers[kind] = null;
    }, SYNC_DEACTIVATE_MS);
  }

  private _cancelHistoryRestore(): void {
    if (this._historyRestoreTimer) { clearTimeout(this._historyRestoreTimer); this._historyRestoreTimer = null; }
    this._historyRestore = null;
  }

  private _clearSyncTimers(): void {
    if (this._syncTimers.tab) { clearTimeout(this._syncTimers.tab); this._syncTimers.tab = null; }
    if (this._syncTimers.history) { clearTimeout(this._syncTimers.history); this._syncTimers.history = null; }
  }
}
