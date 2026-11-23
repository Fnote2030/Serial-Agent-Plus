import * as vscode from 'vscode';
import { SerialManager } from './serial-manager';
import { MonitorRegistry, MonitorMeta, MonitorStorage } from './monitor-registry';
import { TerminalSession } from './terminal-session';
import { SerialConfig } from './types';

/** 每监视器运行时：元数�?+ 串口管理�?+ 终端会话 + 未连接时的待发终端字�?*/
export interface MonitorRuntime {
  meta: MonitorMeta;
  manager: SerialManager;
  session: TerminalSession;
  pendingTerminalBytes: string | null;
}

/** 面向 UI 的监视器摘要（含连接状态） */
export interface MonitorViewInfo {
  id: string;
  index: number;
  name: string;
  connected: boolean;
  port: string;
  baudRate: number;
  parity: string;
}

/** 剥离 OSC（窗口标题等）序列；CSI 保留给终端会话按语义解释 */
function stripOsc(text: string): string {
  return text.replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, '');
}

/**
 * �?Serial Monitor 宿主：组�?MonitorRegistry（元数据/持久化）与每监视器运行时�?
 * 对上（provider/bridge/状态栏）提供统一的监视与操作入口�?
 */
export class MonitorHost implements vscode.Disposable {
  private readonly _runtimes = new Map<string, MonitorRuntime>();
  private readonly _sessions = new Map<string, TerminalSession>();

  constructor(
    private readonly _registry: MonitorRegistry,
    private readonly _onEvent: (event: MonitorHostEvent) => void,
  ) {
    for (const meta of _registry.list()) {
      this._spawn(meta);
    }
  }

  static create(context: vscode.ExtensionContext, onEvent: (event: MonitorHostEvent) => void): MonitorHost {
    const storage: MonitorStorage = {
      get: <T>(key: string, defaultValue: T): T => context.globalState.get<T>(key, defaultValue),
      update: (key: string, value: unknown) => context.globalState.update(key, value),
    };
    const registry = new MonitorRegistry(storage);
    return new MonitorHost(registry, onEvent);
  }

  dispose(): void {
    for (const rt of this._runtimes.values()) {
      rt.session.dispose();
      void rt.manager.disconnect();
    }
    this._runtimes.clear();
  }

  get registry(): MonitorRegistry {
    return this._registry;
  }

  list(): MonitorViewInfo[] {
    return this._registry.list().map((meta) => this.viewInfo(meta));
  }

  runtime(id: string): MonitorRuntime | undefined {
    return this._runtimes.get(id);
  }

  runtimeByRef(ref: number | string): MonitorRuntime | undefined {
    const meta = this._registry.resolve(ref);
    return meta ? this._runtimes.get(meta.id) : undefined;
  }

  /** 主监视器（列表第一个）：P1/P2 阶段 bridge 与端口扫描的兼容绑定目标 */
  primary(): MonitorRuntime {
    const first = this._registry.list()[0];
    return this._runtimes.get(first.id)!;
  }

  viewInfo(meta: MonitorMeta): MonitorViewInfo {
    const rt = this._runtimes.get(meta.id)!;
    const cfg = rt.manager.config;
    return {
      id: meta.id,
      index: meta.index,
      name: meta.name,
      connected: rt.manager.isConnected,
      port: rt.manager.isConnected ? rt.manager.currentPath : cfg.port,
      baudRate: rt.manager.currentBaudRate || cfg.baudRate,
      parity: cfg.parity,
    };
  }

  createMonitor(name?: string): MonitorViewInfo {
    const meta = this._registry.create(name);
    this._spawn(meta);
    this._emitMetas();
    return this.viewInfo(meta);
  }

  deleteMonitor(id: string): void {
    const rt = this._runtimes.get(id);
    if (!rt) { return; }
    // 静默断开 �?释放会话 �?删除元数�?
    void rt.manager.disconnect();
    rt.session.dispose();
    this._runtimes.delete(id);
    this._registry.delete(id);
    this._emitMetas();
  }

  renameMonitor(id: string, name: string): MonitorViewInfo {
    const meta = this._registry.rename(id, name);
    this._emitMetas();
    return this.viewInfo(meta);
  }

  /** 连接指定监视器；端口被其它监视器占用时拒绝并返回占用者描�?*/
  async connect(id: string, config: SerialConfig): Promise<{ ok: boolean; error?: string }> {
    const rt = this._runtimes.get(id);
    if (!rt) { return { ok: false, error: `Monitor not found: ${id}` }; }
    const conflict = this._portOwner(config.port, id);
    if (conflict) {
      const error = `Port ${config.port} is already opened by ${conflict.index}=${conflict.name}. Disconnect it first.`;
      vscode.window.showErrorMessage(`[Serial Agent Plus] ${error}`);
      return { ok: false, error };
    }
    rt.manager.updateSettings(config);
    this._registry.updateConfig(id, config);
    const ok = await rt.manager.connect(config);
    return ok ? { ok: true } : { ok: false, error: 'Connect failed' };
  }

  /** 检查端口被哪个其它监视器占用（返回占用者元数据�?*/
  portConflict(port: string, excludeId: string): MonitorMeta | undefined {
    return this._portOwner(port, excludeId);
  }

  private _portOwner(port: string, excludeId: string): MonitorMeta | undefined {
    if (!port) { return undefined; }
    for (const rt of this._runtimes.values()) {
      if (rt.meta.id !== excludeId && rt.manager.isConnected && rt.manager.currentPath === port) {
        return rt.meta;
      }
    }
    return undefined;
  }

  private _spawn(meta: MonitorMeta): void {
    const manager = new SerialManager();
    const session = new TerminalSession({
      onTx: (bytes) => { this._onTx(meta.id, bytes); },
      onLines: (lines) => { this._onEvent({ type: 'logLines', monitorId: meta.id, lines, kind: 'text' }); },
      onStateChange: () => {
        this._onEvent({ type: 'terminalState', monitorId: meta.id, state: session.snapshot() });
      },
    });
    manager.setCallbacks({
      onLog: (text) => { this._onManagerLog(meta.id, text); },
      onStatus: (connected, portPath, baudRate) => {
        const rt = this._runtimes.get(meta.id);
        if (rt) {
          if (connected) {
            // 连接成功：排空终端按键触发的待发字节
            this.flushPendingTerminalBytes(meta.id);
          } else {
            rt.session.resetEditing();
            rt.pendingTerminalBytes = null;
          }
        }
        this._onEvent({ type: 'status', monitorId: meta.id, connected, port: portPath ?? '', baudRate: baudRate ?? 0 });
      },
      onError: (msg) => { this._onEvent({ type: 'error', monitorId: meta.id, message: msg }); },
      onCounterUpdate: (rx, tx) => { this._onEvent({ type: 'counters', monitorId: meta.id, rx, tx }); },
    });
    manager.updateSettings(meta.config);
    this._runtimes.set(meta.id, { meta, manager, session, pendingTerminalBytes: null });
  }

  /** 终端字节落串口：未连接时暂存并触发连接（连接成功后由 provider 排空�?*/
  private _onTx(id: string, bytes: string): void {
    const rt = this._runtimes.get(id);
    if (!rt) { return; }
    if (rt.manager.isConnected) {
      void rt.manager.send(bytes, false, 'none');
    } else {
      rt.pendingTerminalBytes = bytes;
      this._onEvent({ type: 'terminalConnectRequest', monitorId: id });
    }
  }

  /** 连接建立后排空该监视器的待发终端字节 */
  flushPendingTerminalBytes(id: string): void {
    const rt = this._runtimes.get(id);
    if (!rt || rt.pendingTerminalBytes === null || !rt.manager.isConnected) { return; }
    const bytes = rt.pendingTerminalBytes;
    rt.pendingTerminalBytes = null;
    void rt.manager.send(bytes, false, 'none');
  }

  private _onManagerLog(id: string, text: string): void {
    const rt = this._runtimes.get(id);
    if (!rt) { return; }
    if (text.includes('MCP TX>> ')) {
      // MCP 发送回显：直接作为 echo 日志行，不进终端行模�?
      const cleaned = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\n$/, '');
      this._onEvent({ type: 'logLines', monitorId: id, lines: [cleaned], kind: 'echo' });
      return;
    }
    if (/\u001b\[2J/.test(text)) {
      rt.session.clearLive();
      this._onEvent({ type: 'clearScreen', monitorId: id });
      return;
    }
    rt.session.feed(stripOsc(text));
  }

  private _emitMetas(): void {
    this._onEvent({ type: 'metas', monitors: this.list() });
  }
}

export type MonitorHostEvent =
  | { type: 'metas'; monitors: MonitorViewInfo[] }
  | { type: 'status'; monitorId: string; connected: boolean; port: string; baudRate: number }
  | { type: 'logLines'; monitorId: string; lines: string[]; kind: 'text' | 'echo' }
  | { type: 'terminalState'; monitorId: string; state: ReturnType<TerminalSession['snapshot']> }
  | { type: 'counters'; monitorId: string; rx: number; tx: number }
  | { type: 'error'; monitorId: string; message: string }
  | { type: 'clearScreen'; monitorId: string }
  | { type: 'terminalConnectRequest'; monitorId: string };
