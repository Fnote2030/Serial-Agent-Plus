import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { SerialManager } from '../packages/serialagent-plus/src/serial-manager';

describe('SerialManager RX timestamp routing', () => {
  let manager: SerialManager;
  let webviewLines: string[];

  beforeEach(() => {
    manager = new SerialManager();
    webviewLines = [];
    manager.setCallbacks({
      onLog: (text) => { webviewLines.push(text); },
      onStatus: () => {},
      onError: () => {},
    });
    manager.updateSettings({ showTimestamp: true });
  });

  afterEach(() => {
    (manager as any)._clearRxPartialFlush();
    (manager as any)._clearRxWrap();
    vi.useRealTimers();
  });

  it('sends raw lines to the webview channel while the log buffer keeps timestamps', () => {
    (manager as any)._processReceivedData(Buffer.from('hello\r\n'));

    expect(webviewLines).toEqual(['hello\n']);
    const buffer = manager.getLogBuffer();
    expect(buffer[buffer.length - 1]).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] hello$/);
  });

  it('does not leak a timestamp into the empty echo line after Enter (msh redraw flow)', () => {
    // 设备 redraw 输出提示符 + 召回的命令（无换行），先走 partial flush
    (manager as any)._processReceivedData(Buffer.from('msh > list thread'));
    (manager as any)._flushPendingRx();
    // 回车后设备回显 \n，随后输出表头
    (manager as any)._processReceivedData(Buffer.from('\r\nthread pri ...\r\n'));

    // webview 通道必须全是原始文本：若空行带 "[hh:mm:ss.mss] " 前缀，
    // webview 行模拟器会拼出 "msh > list thread[04:36:06.078]"
    expect(webviewLines).toEqual(['msh > list thread', '\n', 'thread pri ...\n']);

    const buffer = manager.getLogBuffer();
    expect(buffer[1]).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] $/);
    expect(buffer[2]).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] thread pri \.\.\.$/);
  });

  it('MCP TX echo carries exactly one timestamp: raw text on the webview channel', () => {
    manager.injectTxLog('help');

    // webview 显示时自行加时间戳；宿主再塞一个就会显示成 "[t1] [t2] MCP TX>> help"
    expect(webviewLines).toEqual(['MCP TX>> help\n']);
    const buffer = manager.getLogBuffer();
    expect(buffer[buffer.length - 1]).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] MCP TX>> help$/);
  });

  it('MCP TX echo stays plain on both channels when timestamps are off', () => {
    manager.updateSettings({ showTimestamp: false });
    manager.injectTxLog('help');

    expect(webviewLines).toEqual(['MCP TX>> help\n']);
    expect(manager.getLogBuffer()[manager.getLogBuffer().length - 1]).toBe('MCP TX>> help');
  });

  it('MCP HEX echo is labelled MCP TX HEX>> with normalised bytes and a leading timestamp', () => {
    manager.injectTxLog('112233', true);

    // 时间戳在行首（"TX 在时间前面" 的旧格式已修正），HEX 回显用独立标签
    expect(webviewLines).toEqual(['MCP TX HEX>> 11 22 33\n']);
    const last = manager.getLogBuffer()[manager.getLogBuffer().length - 1];
    expect(last).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] MCP TX HEX>> 11 22 33$/);
  });
});

describe('SerialManager log buffer byte cap (logBufferKB)', () => {
  let manager: SerialManager;

  beforeEach(() => {
    manager = new SerialManager();
    manager.setCallbacks({ onLog: () => {}, onStatus: () => {}, onError: () => {} });
  });

  afterEach(() => {
    (manager as any)._clearRxPartialFlush();
    (manager as any)._clearRxWrap();
  });

  it('drops the oldest lines once the total exceeds the configured KB budget', () => {
    manager.updateSettings({ logBufferKB: 1 }); // 1KB
    manager.injectLog('a'.repeat(600));
    manager.injectLog('b'.repeat(600));
    manager.injectLog('c'.repeat(600));

    const buffer = manager.getLogBuffer();
    expect(buffer).toHaveLength(1); // 1200B > 1024B，仅保留最新一条
    expect(buffer[0].startsWith('c')).toBe(true);
  });

  it('retains more history when the KB budget is larger', () => {
    manager.updateSettings({ logBufferKB: 2 }); // 2KB
    manager.injectLog('a'.repeat(600));
    manager.injectLog('b'.repeat(600));
    manager.injectLog('c'.repeat(600));

    expect(manager.getLogBuffer()).toHaveLength(3); // 1800B ≤ 2048B
  });
});

describe('SerialManager idle-gap line wrap (rxIdleWrapMs)', () => {
  let manager: SerialManager;
  let webviewLines: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new SerialManager();
    webviewLines = [];
    manager.setCallbacks({
      onLog: (text) => { webviewLines.push(text); },
      onStatus: () => {},
      onError: () => {},
    });
    manager.updateSettings({ showTimestamp: true, rxIdleWrapMs: 100 });
  });

  it('HEX mode: raw hex on the webview channel, exactly one timestamp in the log buffer', () => {
    manager.updateSettings({ hexMode: true });
    (manager as any)._processReceivedData(Buffer.from([0xab, 0xcd]));
    vi.advanceTimersByTime(20);   // partial flush: live line
    vi.advanceTimersByTime(80);   // idle wrap: commit

    // webview 通道只出现一次 hex 文本 + 一次换行提交（时间戳由 webview 显示层添加）
    expect(webviewLines).toEqual(['AB CD', '\n']);
    const buffer = manager.getLogBuffer();
    expect(buffer).toHaveLength(1);
    expect(buffer[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] AB CD$/);
  });

  it('HEX mode: bytes within the idle gap stay on one line, a later burst starts a new line', () => {
    manager.updateSettings({ hexMode: true });
    (manager as any)._processReceivedData(Buffer.from([0x01]));
    vi.advanceTimersByTime(20);
    (manager as any)._processReceivedData(Buffer.from([0x02, 0x03])); // 间隔 < 100ms，同一行
    vi.advanceTimersByTime(20);
    vi.advanceTimersByTime(80); // 空闲超过 100ms，提交

    expect(webviewLines).toEqual(['01', ' 02 03', '\n']);
    expect(manager.getLogBuffer()).toHaveLength(1);
    expect(manager.getLogBuffer()[0]).toMatch(/01 02 03$/);

    (manager as any)._processReceivedData(Buffer.from([0xff]));
    vi.advanceTimersByTime(20);
    vi.advanceTimersByTime(80);
    expect(manager.getLogBuffer()).toHaveLength(2); // 新的一行
  });

  it('text mode: unterminated data stays on the live line (no idle wrap)', () => {
    (manager as any)._processReceivedData(Buffer.from('msh > '));
    vi.advanceTimersByTime(20);
    vi.advanceTimersByTime(500); // 远超空闲阈值：文本模式不提交

    expect(webviewLines).toEqual(['msh > ']); // 无换行提交
    expect(manager.getLogBuffer()).toEqual(['msh > ']);
  });

  it('HEX mode: wrap threshold below the 20ms partial flush still commits immediately', () => {
    manager.updateSettings({ hexMode: true, rxIdleWrapMs: 5 });
    (manager as any)._processReceivedData(Buffer.from([0xaa]));
    vi.advanceTimersByTime(5); // wrap 先同步送出增量再提交，不等待 20ms partial flush

    expect(webviewLines).toEqual(['AA', '\n']);
    expect(manager.getLogBuffer()[0]).toMatch(/AA$/);
  });

  it('HEX mode: forces a wrap commit when a single line exceeds the 1MB guard', () => {
    // 缓冲预算调大到 10MB，避免 1.2MB 的强制换行行本身被日志字节上限逐出
    manager.updateSettings({ hexMode: true, logBufferKB: 10240 });
    // 400000 字节 → hex 字符串约 1.2MB，超过单行保护上限，立即强制提交
    (manager as any)._processReceivedData(Buffer.alloc(400_000, 0x55));

    // 增量已送出且换行已提交（无需等待空闲定时器）
    expect(webviewLines[webviewLines.length - 1]).toBe('\n');
    const buffer = manager.getLogBuffer();
    expect(buffer).toHaveLength(1);
    expect(buffer[0].endsWith('55')).toBe(true);
    // 提交后累积状态清零，后续字节进入新行
    (manager as any)._processReceivedData(Buffer.from([0x01]));
    vi.advanceTimersByTime(20);
    vi.advanceTimersByTime(80);
    expect(manager.getLogBuffer()).toHaveLength(2);
  });

  it('flushes pending HEX line when switching HEX back to text', () => {
    manager.updateSettings({ hexMode: true });
    (manager as any)._processReceivedData(Buffer.from([0x10, 0x20]));
    vi.advanceTimersByTime(20);
    manager.updateSettings({ hexMode: false });
    expect(webviewLines).toEqual(['10 20', '\n']);
    expect(manager.getLogBuffer()[0]).toMatch(/10 20$/);
  });
});
