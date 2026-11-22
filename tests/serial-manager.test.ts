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

  it('flushes pending HEX line when switching HEX back to text', () => {
    manager.updateSettings({ hexMode: true });
    (manager as any)._processReceivedData(Buffer.from([0x10, 0x20]));
    vi.advanceTimersByTime(20);
    manager.updateSettings({ hexMode: false });
    expect(webviewLines).toEqual(['10 20', '\n']);
    expect(manager.getLogBuffer()[0]).toMatch(/10 20$/);
  });
});
