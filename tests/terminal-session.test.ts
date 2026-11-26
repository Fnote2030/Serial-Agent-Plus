import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { TerminalSession, TerminalKeyIntent } from '../packages/serialagent-plus/src/terminal-session';

function harness() {
  const tx: string[] = [];
  const lines: string[] = [];
  const states: number[] = [];
  const session = new TerminalSession({
    onTx: (bytes) => { tx.push(bytes); },
    onLines: (committed) => { lines.push(...committed); },
    onStateChange: () => { states.push(0); },
  });
  return { session, tx, lines };
}

const key = (intent: TerminalKeyIntent) => intent;

describe('TerminalSession local line editing', () => {
  it('accumulates printable input and edits with backspace/move', () => {
    const { session } = harness();
    session.handleKey(key({ type: 'print', ch: 'l' }));
    session.handleKey(key({ type: 'print', ch: 's' }));
    session.handleKey(key({ type: 'move', delta: -1 }));
    session.handleKey(key({ type: 'print', ch: 'X' })); // lXs 光标中插
    expect(session.snapshot().buffer).toBe('lXs');
    session.handleKey(key({ type: 'backspace' }));
    expect(session.snapshot().buffer).toBe('ls');
    session.handleKey(key({ type: 'moveTo', position: 'end' }));
    expect(session.snapshot().caret).toBe(2);
  });

  it('enter sends line + CR when device line is empty', () => {
    const { session, tx } = harness();
    session.handleKey(key({ type: 'print', ch: 'l' }));
    session.handleKey(key({ type: 'print', ch: 's' }));
    session.handleKey(key({ type: 'enter' }));
    expect(tx).toEqual(['ls\r']);
    expect(session.snapshot().buffer).toBe('');
  });
});

describe('TerminalSession paste', () => {
  it('inserts pasted text at the caret without submitting', () => {
    const { session, tx } = harness();
    session.handleKey(key({ type: 'print', ch: 'l' }));
    session.handleKey(key({ type: 'print', ch: 's' }));
    session.handleKey(key({ type: 'moveTo', position: 'start' }));

    session.handleKey(key({ type: 'paste', text: 'li' }));

    expect(tx).toEqual([]); // 单行粘贴不自动执行
    expect(session.snapshot().buffer).toBe('lils');
    expect(session.snapshot().caret).toBe(2);
  });

  it('submits each pasted line like typing + Enter', () => {
    const { session, tx } = harness();
    session.handleKey(key({ type: 'paste', text: 'help\r\nlist_device\n' }));

    expect(tx).toEqual(['help\r', 'list_device\r']);
    expect(session.snapshot().buffer).toBe('');
  });

  it('keeps the remainder of the last line in the buffer when it has no trailing newline', () => {
    const { session, tx } = harness();
    session.handleKey(key({ type: 'paste', text: 'help\nlis' }));

    expect(tx).toEqual(['help\r']);
    expect(session.snapshot().buffer).toBe('lis');
  });

  it('strips tab/control characters and caps the inserted length', () => {
    const { session } = harness();
    session.handleKey(key({ type: 'paste', text: 'a\tb\u0007c\u001b[2J' }));
    expect(session.snapshot().buffer).toBe('a bc[2J');

    session.handleKey(key({ type: 'paste', text: 'x'.repeat(5000) }));
    expect(session.snapshot().buffer.length).toBe(4096);
  });

  it('reconciles against the device line before submitting pasted multi-line text', () => {
    const { session, tx } = harness();
    session.handleKey(key({ type: 'print', ch: 'l' }));
    session.handleKey(key({ type: 'tab' })); // 设备持有 'l'，本地缓冲清空
    session.handleKey(key({ type: 'paste', text: 'ist\n' }));
    // 设备行 'l' 与本地 'ist' 不一致：先退格清空设备行再整行 + CR
    expect(tx[tx.length - 1]).toBe('\bist\r');
  });
});

describe('TerminalSession history recall sync (msh redraw)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('sends only CR after history redraw sync (no lsls duplication)', () => {
    const { session, tx, lines } = harness();
    session.handleKey(key({ type: 'print', ch: 'l' }));
    session.handleKey(key({ type: 'print', ch: 's' }));
    session.handleKey(key({ type: 'enter' })); // history: ["ls"]
    session.feed('\r\nmsh > '); // 回车回显 + 新提示符
    session.handleKey(key({ type: 'print', ch: 'h' }));
    session.handleKey(key({ type: 'print', ch: 'e' }));
    session.handleKey(key({ type: 'print', ch: 'l' }));
    session.handleKey(key({ type: 'print', ch: 'p' }));
    session.handleKey(key({ type: 'enter' })); // history: ["help","ls"]
    session.feed('\r\nmsh > ');

    // ↑ 召回 help：设备 redraw = ESC[2K + \r + 提示符 + help
    session.handleKey(key({ type: 'history', direction: 'up' }));
    expect(tx[tx.length - 1]).toBe('\x1b[A');
    session.feed('\u001b[2K\rmsh > help');
    expect(session.snapshot().deviceLine).toBe('help');
    expect(session.snapshot().buffer).toBe('help');

    // ↑↑ 再切回 ls（redraw 清行后重写）
    session.feed('\u001b[2K\rmsh > ls');
    expect(session.snapshot().buffer).toBe('ls');
    session.handleKey(key({ type: 'enter' }));
    expect(tx[tx.length - 1]).toBe('\r'); // 只补 CR，不整行重发
    session.feed('\r\n'); // 设备回显提交
    expect(lines.join('|')).toContain('msh > ls');
  });

  it('restores the typed line when pressing up with empty history (no redraw)', () => {
    const { session } = harness();
    session.handleKey(key({ type: 'print', ch: 'a' }));
    session.handleKey(key({ type: 'print', ch: 'b' }));
    session.handleKey(key({ type: 'history', direction: 'up' })); // 历史为空，设备不重绘
    expect(session.snapshot().buffer).toBe('');
    vi.advanceTimersByTime(200);
    expect(session.snapshot().buffer).toBe('ab'); // 恢复快照
  });

  it('second Tab keeps sync alive (stale deactivate timer cancelled)', () => {
    const { session } = harness();
    session.handleKey(key({ type: 'print', ch: 'l' }));
    session.handleKey(key({ type: 'tab' }));
    session.feed('msh > list_device'); // 补全结果
    vi.advanceTimersByTime(200); // 旧去激活定时器本应在此关闭 tabSync
    expect(session.snapshot().buffer).toBe('list_device');
    session.handleKey(key({ type: 'tab' })); // 第二次 Tab：重置 sent 并清旧定时器
    session.feed('\u001b[2K\rmsh > list_device'); // 第二次 redraw（清行后重写）
    expect(session.snapshot().buffer).toBe('list_device'); // 不为空
  });
});

describe('TerminalSession RX line simulation', () => {
  it('interprets ESC[2K/ESC[K redraws without residue', () => {
    const { session, lines } = harness();
    session.feed('msh > help');
    session.feed('\u001b[2K\rmsh > ls');
    expect(session.snapshot().liveLine).toBe('msh > ls');
    session.feed('\r\n');
    expect(lines).toEqual(['msh > ls']);
  });

  it('ctrl+C clears the line and emits ETX', () => {
    const { session, tx } = harness();
    session.handleKey(key({ type: 'print', ch: 'x' }));
    session.handleKey(key({ type: 'ctrlC' }));
    expect(tx).toEqual(['\x03']);
    expect(session.snapshot().buffer).toBe('');
  });
});
