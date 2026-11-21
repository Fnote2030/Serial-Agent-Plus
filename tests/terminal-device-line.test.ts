import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// 与 webview 共用的纯逻辑模块（CommonJS UMD），见 packages/serialagent-plus/media/terminal-device-line.js
const { reconcileBytes, createRxLineSimulator } = require('../packages/serialagent-plus/media/terminal-device-line.js');

describe('TerminalDeviceLine.reconcileBytes', () => {
  it('sends the full line when the device edit line is empty (normal typing)', () => {
    expect(reconcileBytes(null, 'ls', '\r')).toBe('ls\r');
    expect(reconcileBytes(null, 'ls', '\t')).toBe('ls\t');
    expect(reconcileBytes(null, '', '\r')).toBe('\r');
  });

  it('sends only the trailing byte after a history recall sync (up/down duplication bug)', () => {
    // ↑ 召回 "ls" 后设备编辑缓冲已持有 "ls"，本地未修改直接回车
    expect(reconcileBytes('ls', 'ls', '\r')).toBe('\r');
    expect(reconcileBytes('lslsls', 'lslsls', '\r')).toBe('\r');
  });

  it('clears the device line with backspaces before resending an edited line', () => {
    // ↑ 召回 "ls" 后本地继续编辑成 "ls -l"
    expect(reconcileBytes('ls', 'ls -l', '\r')).toBe('\b\bls -l\r');
    // 同步后本地删空再回车：清空设备行后仅发 CR
    expect(reconcileBytes('ls', '', '\r')).toBe('\b\b\r');
  });

  it('clears the device line before resending when tab is pressed after a recall sync', () => {
    // Tab 补全同样不得整行重发
    expect(reconcileBytes('ls', 'ls', '\t')).toBe('\t');
    expect(reconcileBytes('ls', 'pin', '\t')).toBe('\b\bpin\t');
  });
});

describe('createRxLineSimulator (msh redraw)', () => {
  it('erases the whole line on the ESC[2K history redraw (help -> ls leaves no residue)', () => {
    const sim = createRxLineSimulator();
    sim.feed('msh > help');
    // RT-Thread msh shell_handle_history() 输出 "\033[2K\r" + 提示符 + 历史命令
    sim.feed('\u001b[2K\rmsh > ls');
    expect(sim.line.text).toBe('msh > ls');
    expect(sim.line.cursor).toBe(8);
  });

  it('accumulates a CSI sequence split across serial chunks', () => {
    const sim = createRxLineSimulator();
    sim.feed('msh > help');
    sim.feed('\u001b');
    sim.feed('[2K');
    sim.feed('\rmsh > ls');
    expect(sim.line.text).toBe('msh > ls');
  });

  it('erases from cursor to end of line on ESC[K', () => {
    const sim = createRxLineSimulator();
    sim.feed('ls -l');
    sim.feed('\b\b\b'); // 光标移回 "ls" 之后
    sim.feed('\u001b[K');
    expect(sim.line.text).toBe('ls');
  });

  it('moves the cursor with ESC[nD / ESC[nC and ignores color sequences', () => {
    const sim = createRxLineSimulator();
    sim.feed('\u001b[31mabc\u001b[0m');
    expect(sim.line.text).toBe('abc');
    sim.feed('\u001b[2D');
    expect(sim.line.cursor).toBe(1);
    sim.feed('X');
    expect(sim.line.text).toBe('aXc');
  });

  it('commits the line on \\n and resets the row', () => {
    const sim = createRxLineSimulator();
    expect(sim.feed('msh > ls\r\n')).toEqual(['msh > ls']);
    expect(sim.line.text).toBe('');
  });
});
