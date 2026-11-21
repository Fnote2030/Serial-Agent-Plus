import { describe, expect, it, beforeEach, afterEach } from 'vitest';
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
