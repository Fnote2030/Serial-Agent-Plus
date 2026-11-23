import { describe, expect, it } from 'vitest';
import { MonitorRegistry, MonitorStorage } from '../packages/serialagent-plus/src/monitor-registry';
import { DEFAULT_CONFIG } from '../packages/serialagent-plus/src/types';

function memoryStorage(initial: Record<string, unknown> = {}): MonitorStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    get: <T>(key: string, defaultValue: T): T => (data.has(key) ? (data.get(key) as T) : defaultValue),
    update: (key: string, value: unknown) => { data.set(key, value); },
  };
}

describe('MonitorRegistry allocation', () => {
  it('starts with one migrated monitor (index 1, default name)', () => {
    const reg = new MonitorRegistry(memoryStorage());
    expect(reg.count()).toBe(1);
    const first = reg.list()[0];
    expect(first.index).toBe(1);
    expect(first.name).toBe('Serial Monitor1');
    expect(reg.canCreate()).toBe(true);
    expect(reg.canDelete()).toBe(false); // 最少保留 1 个
  });

  it('allocates smallest free index and default name (1..3, delete 2, recreate → 2)', () => {
    const reg = new MonitorRegistry(memoryStorage());
    reg.create(); // 2
    reg.create(); // 3
    expect(reg.list().map((m) => m.index)).toEqual([1, 2, 3]);

    const second = reg.list()[1];
    reg.delete(second.id);
    const recreated = reg.create();
    expect(recreated.index).toBe(2);
    expect(recreated.name).toBe('Serial Monitor2');
  });

  it('default name allocation skips names taken by renames (independent of index)', () => {
    const reg = new MonitorRegistry(memoryStorage());
    const first = reg.list()[0];
    const second = reg.create(); // index 2, name Serial Monitor2
    reg.rename(first.id, 'Main');
    reg.rename(second.id, 'Serial Monitor1'); // 默认名 1 被 index 2 的监视器占用
    reg.delete(first.id);                      // 释放 index 1
    const third = reg.create();
    // index 复用 1；默认名 1 已被占用 → 分配最小空闲默认名 Serial Monitor2
    expect(third.index).toBe(1);
    expect(third.name).toBe('Serial Monitor2');
    expect(reg.list().map((m) => `${m.index}=${m.name}`)).toEqual([
      '1=Serial Monitor2',
      '2=Serial Monitor1',
    ]);
  });

  it('caps at 10 monitors', () => {
    const reg = new MonitorRegistry(memoryStorage());
    for (let i = 0; i < 9; i++) { reg.create(); }
    expect(reg.count()).toBe(10);
    expect(reg.canCreate()).toBe(false);
    expect(() => reg.create()).toThrow(/limit reached/i);
  });

  it('rename keeps index and enforces uniqueness (case-insensitive)', () => {
    const reg = new MonitorRegistry(memoryStorage());
    reg.create();
    const [first, second] = reg.list();
    reg.rename(second.id, 'Debug UART');
    expect(second.index).toBe(2);
    expect(() => reg.rename(first.id, 'debug uart')).toThrow(/already in use/i);
    expect(() => reg.rename(first.id, '   ')).toThrow(/empty/i);
  });
});

describe('MonitorRegistry resolve', () => {
  it('resolves by index (number or numeric string) and by name (case-insensitive)', () => {
    const reg = new MonitorRegistry(memoryStorage());
    const second = reg.create();
    reg.rename(second.id, 'Debug');
    expect(reg.resolve(2)?.id).toBe(second.id);
    expect(reg.resolve('2')?.id).toBe(second.id);
    expect(reg.resolve('debug')?.id).toBe(second.id);
    expect(reg.resolve('Serial Monitor1')?.index).toBe(1);
    expect(reg.resolve(7)).toBeUndefined();
  });
});

describe('MonitorRegistry persistence', () => {
  it('migrates legacy serialConfig + sendHistory into monitor 1', () => {
    const storage = memoryStorage({
      serialConfig: { ...DEFAULT_CONFIG, port: 'COM7', baudRate: 9600 },
      sendHistory: ['ls', 'ps'],
    });
    const reg = new MonitorRegistry(storage);
    const first = reg.list()[0];
    expect(first.config.port).toBe('COM7');
    expect(first.config.baudRate).toBe(9600);
    expect(first.sendHistory).toEqual(['ls', 'ps']);
    // 迁移结果已写回 monitors 键，二次加载不再走迁移
    const reg2 = new MonitorRegistry(storage);
    expect(reg2.list()[0].config.port).toBe('COM7');
  });

  it('round-trips monitors across storage', () => {
    const storage = memoryStorage();
    const reg = new MonitorRegistry(storage);
    const extra = reg.create();
    reg.rename(extra.id, 'RTT');
    const reg2 = new MonitorRegistry(storage);
    expect(reg2.list().map((m) => m.name)).toEqual(['Serial Monitor1', 'RTT']);
  });

  it('persists config and sendHistory updates', () => {
    const storage = memoryStorage();
    const reg = new MonitorRegistry(storage);
    const first = reg.list()[0];
    reg.updateConfig(first.id, { port: 'COM3' });
    reg.updateSendHistory(first.id, ['hello']);
    const reg2 = new MonitorRegistry(storage);
    expect(reg2.list()[0].config.port).toBe('COM3');
    expect(reg2.list()[0].sendHistory).toEqual(['hello']);
  });
});
