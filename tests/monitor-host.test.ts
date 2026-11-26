import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
}));

import { MonitorHost, MonitorHostEvent } from '../packages/serialagent-plus/src/monitor-host';
import { MonitorRegistry, MonitorStorage } from '../packages/serialagent-plus/src/monitor-registry';

function createStorage(): MonitorStorage {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue: T): T => (data.has(key) ? (data.get(key) as T) : defaultValue),
    update: (key: string, value: unknown) => { data.set(key, value); },
  };
}

function attachFakePort(host: MonitorHost, monitorId: string): string[] {
  const writes: string[] = [];
  const manager = host.runtime(monitorId)!.manager as any;
  const port: any = {
    isOpen: true,
    write: (buffer: Buffer, callback: (error?: Error) => void) => {
      writes.push(buffer.toString('utf8'));
      callback();
    },
    removeAllListeners: () => {},
    close: (callback: () => void) => {
      port.isOpen = false;
      callback();
    },
  };
  manager._port = port;
  return writes;
}

describe('MonitorHost periodic send', () => {
  let host: MonitorHost;
  let monitorId: string;
  let events: MonitorHostEvent[];
  let writes: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    const registry = new MonitorRegistry(createStorage());
    monitorId = registry.create().id;
    events = [];
    host = new MonitorHost(registry, (event) => { events.push(event); });
    writes = attachFakePort(host, monitorId);
  });

  afterEach(() => {
    host.dispose();
    vi.useRealTimers();
  });

  it('sends only once per tick when both viewports enable Cycle for the same monitor', () => {
    // 侧边栏与编辑器面板各发一次"开启"：宿主只保留一个定时器
    const options = { enabled: true, intervalMs: 100, text: 'ping', payload: 'ping', hexSend: false, echo: true };
    host.setPeriodicSend(monitorId, options);
    host.setPeriodicSend(monitorId, options);

    vi.advanceTimersByTime(300);

    expect(writes).toEqual(['ping', 'ping', 'ping']);
    expect(events.filter((event) => event.type === 'periodicTick')).toHaveLength(3);
  });

  it('stops the timer and broadcasts the last interval when disabled', () => {
    host.setPeriodicSend(monitorId, { enabled: true, intervalMs: 250, text: 'ping', payload: 'ping' });
    vi.advanceTimersByTime(250);
    expect(writes).toHaveLength(1);

    host.setPeriodicSend(monitorId, { enabled: false, intervalMs: 250 });

    expect(host.periodicState(monitorId)).toEqual({ enabled: false, intervalMs: 250 });
    expect(events).toContainEqual({
      type: 'periodicState',
      monitorId,
      enabled: false,
      intervalMs: 250,
    });

    vi.advanceTimersByTime(500);
    expect(writes).toHaveLength(1);
  });

  it('keeps the configured interval for new views after the timer stops', () => {
    host.setPeriodicSend(monitorId, { enabled: false, intervalMs: 750 });
    expect(host.periodicState(monitorId)).toEqual({ enabled: false, intervalMs: 750 });
  });

  it('uses the escaped payload for text sends while keeping the raw text for echo', () => {
    host.setPeriodicSend(monitorId, {
      enabled: true,
      intervalMs: 100,
      text: 'a\\nb',
      payload: 'a\nb',
      hexSend: false,
      echo: true,
    });

    vi.advanceTimersByTime(100);

    expect(writes).toEqual(['a\nb']);
    const tick = events.find((event) => event.type === 'periodicTick');
    expect(tick).toMatchObject({ text: 'a\\nb', payload: 'a\nb', echo: true });
  });

  it('accumulates terminal bytes queued while disconnected (multi-line paste)', () => {
    const runtime = host.runtime(monitorId)!;
    const manager = runtime.manager as any;
    manager._port = null; // 未连接：字节进入待发缓冲

    runtime.session.handleKey({ type: 'paste', text: 'help\nls\n' });

    expect(runtime.pendingTerminalBytes).toBe('help\rls\r');
    expect(events.filter((event) => event.type === 'terminalConnectRequest')).toHaveLength(1);
  });
});
