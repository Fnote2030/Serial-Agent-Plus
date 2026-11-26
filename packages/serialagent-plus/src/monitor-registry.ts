import * as crypto from 'crypto';
import { DEFAULT_CONFIG, SerialConfig } from './types';

/** 单个 Serial Monitor 的元数据（不含运行时状态，可整体持久化） */
export interface MonitorMeta {
  /** 内部稳定 id（uuid），消息路由用，永不变 */
  id: string;
  /** 序号 1..10，系统分配（最小空闲复用），删除后释放 */
  index: number;
  /** 显示名，用户可重命名，全局唯一 */
  name: string;
  /** 该监视器独立的串口配置 */
  config: SerialConfig;
  /** 该监视器独立的发送历史 */
  sendHistory: string[];
}

/** Registry 持久化适配器（globalState 或测试用内存实现） */
export interface MonitorStorage {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void> | void;
}

export interface RegistryEvents {
  /** 元数据增删改名后触发（不含 config 内容变化） */
  onMetasChanged?: () => void;
}

export const MAX_MONITORS = 10;
const MONITORS_KEY = 'monitors';
const LEGACY_CONFIG_KEY = 'serialConfig';
const LEGACY_SEND_HISTORY_KEY = 'sendHistory';

function defaultName(index: number): string {
  return `Serial Monitor${index}`;
}

/**
 * 多 Serial Monitor 注册表（纯逻辑，不含 UI/串口运行时）。
 * - index 与默认 name 均按"最小空闲"独立分配（1..10）
 * - 重命名只改 name，index 终身不变
 * - 最少保留 1 个，最多 10 个
 */
export class MonitorRegistry {
  private _metas: MonitorMeta[] = [];

  constructor(
    private readonly _storage: MonitorStorage,
    private readonly _events: RegistryEvents = {},
  ) {
    this._load();
  }

  /** 当前监视器列表（按 index 升序） */
  list(): MonitorMeta[] {
    return [...this._metas].sort((a, b) => a.index - b.index);
  }

  get(id: string): MonitorMeta | undefined {
    return this._metas.find((m) => m.id === id);
  }

  count(): number {
    return this._metas.length;
  }

  canCreate(): boolean {
    return this._metas.length < MAX_MONITORS;
  }

  canDelete(): boolean {
    return this._metas.length > 1;
  }

  /** 按 index 或 name 解析（name 大小写不敏感），供 MCP/命令寻址 */
  resolve(ref: number | string): MonitorMeta | undefined {
    const trimmed = typeof ref === 'string' ? ref.trim() : ref;
    if (typeof trimmed === 'number' || /^\d+$/.test(String(trimmed))) {
      const index = Number(trimmed);
      return this._metas.find((m) => m.index === index);
    }
    const lower = String(trimmed).toLowerCase();
    return this._metas.find((m) => m.name.toLowerCase() === lower);
  }

  /** 新建监视器：分配最小空闲 index 与默认名，返回新元数据 */
  create(name?: string): MonitorMeta {
    if (!this.canCreate()) {
      throw new Error(`Monitor limit reached (${MAX_MONITORS})`);
    }
    const index = this._smallestFreeIndex();
    let finalName = (name ?? '').trim() || this._smallestFreeDefaultName();
    if (this._nameTaken(finalName)) {
      throw new Error(`Name already in use: ${finalName}`);
    }
    const meta: MonitorMeta = {
      id: crypto.randomUUID(),
      index,
      name: finalName,
      config: { ...DEFAULT_CONFIG },
      sendHistory: [],
    };
    this._metas.push(meta);
    this._save();
    return meta;
  }

  /** 删除监视器（静默；连接中的断开由调用方在删除前完成） */
  delete(id: string): void {
    if (!this.canDelete()) {
      throw new Error('At least one monitor must remain');
    }
    const before = this._metas.length;
    this._metas = this._metas.filter((m) => m.id !== id);
    if (this._metas.length === before) {
      throw new Error(`Monitor not found: ${id}`);
    }
    this._save();
  }

  /** 重命名（唯一性 + 非空校验；index 不变） */
  rename(id: string, name: string): MonitorMeta {
    const meta = this.get(id);
    if (!meta) {
      throw new Error(`Monitor not found: ${id}`);
    }
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('Name must not be empty');
    }
    if (trimmed.length > 64) {
      throw new Error('Name too long (max 64 chars)');
    }
    if (this._metas.some((m) => m.id !== id && m.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error(`Name already in use: ${trimmed}`);
    }
    meta.name = trimmed;
    this._save();
    return meta;
  }

  /** 更新某监视器配置（浅合并）并持久化 */
  updateConfig(id: string, partial: Partial<SerialConfig>): SerialConfig {
    const meta = this.get(id);
    if (!meta) {
      throw new Error(`Monitor not found: ${id}`);
    }
    Object.assign(meta.config, partial);
    this._save();
    return { ...meta.config };
  }

  /** 更新某监视器发送历史并持久化 */
  updateSendHistory(id: string, history: string[]): void {
    const meta = this.get(id);
    if (!meta) {
      return;
    }
    meta.sendHistory = history.slice(-50);
    this._save();
  }

  /** 标题展示格式：1=Serial Monitor1 */
  static displayLabel(meta: MonitorMeta): string {
    return `${meta.index}=${meta.name}`;
  }

  private _smallestFreeIndex(): number {
    const used = new Set(this._metas.map((m) => m.index));
    for (let i = 1; i <= MAX_MONITORS; i++) {
      if (!used.has(i)) { return i; }
    }
    throw new Error('No free index');
  }

  private _nameTaken(name: string): boolean {
    const lower = name.toLowerCase();
    return this._metas.some((m) => m.name.toLowerCase() === lower);
  }

  /** 最小空闲默认名：Serial Monitor1..10 中第一个未被占用的 */
  private _smallestFreeDefaultName(): string {
    for (let i = 1; i <= MAX_MONITORS; i++) {
      const name = defaultName(i);
      if (!this._nameTaken(name)) { return name; }
    }
    throw new Error('No free default name');
  }

  private _save(): void {
    void this._storage.update(MONITORS_KEY, this._metas);
    this._events.onMetasChanged?.();
  }

  /** 读取持久化数据；无 monitors 记录时从旧单监视器配置迁移 */
  private _load(): void {
    const saved = this._storage.get<MonitorMeta[] | null>(MONITORS_KEY, null);
    if (Array.isArray(saved) && saved.length > 0) {
      this._metas = saved
        .filter((m) => m && m.id && typeof m.index === 'number' && typeof m.name === 'string')
        .map((m) => ({
          ...m,
          config: { ...DEFAULT_CONFIG, ...(m.config ?? {}) },
          sendHistory: Array.isArray(m.sendHistory) ? m.sendHistory : [],
        }));
      return;
    }
    // 迁移：旧单监视器 serialConfig + sendHistory → 1=Serial Monitor1
    const legacy = this._storage.get<Partial<SerialConfig> | null>(LEGACY_CONFIG_KEY, null);
    const legacyHistory = this._storage.get<string[]>(LEGACY_SEND_HISTORY_KEY, []);
    this._metas = [{
      id: crypto.randomUUID(),
      index: 1,
      name: defaultName(1),
      config: { ...DEFAULT_CONFIG, ...(legacy ?? {}) },
      sendHistory: Array.isArray(legacyHistory) ? legacyHistory.slice(-50) : [],
    }];
    void this._storage.update(MONITORS_KEY, this._metas);
  }
}
