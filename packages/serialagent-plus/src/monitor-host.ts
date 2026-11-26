import * as vscode from 'vscode';
import { SerialManager } from './serial-manager';
import { MonitorRegistry, MonitorMeta, MonitorStorage } from './monitor-registry';
import { TerminalSession } from './terminal-session';
import { SerialConfig } from './types';

/** 每监视器运行时：元数据 + 串口管理器 + 终端会话 + 未连接时的待发终端字节 */
export interface MonitorRuntime {
  meta: MonitorMeta;
  manager: SerialManager;
  session: TerminalSession;
  pendingTerminalBytes: string | null;
  /** 最近一次设置的周期（定时器停止后仍保留，供新视口同步显示） */
  periodicIntervalMs: number;
  /** 周期发送状态：定时器在宿主侧运行，视口只发指令/收状态，天然不会双发 */
  periodic: {
    timer: ReturnType<typeof setInterval> | null;
    intervalMs: number;
    /** 发送框原文（回显/历史与手动发送一致） */
    text: string;
    /** 实际落串口的内容（文本模式已解释 \r\n\t\xNN 转义） */
    payload: string;
    hexSend: boolean;
    echo: boolean;
  } | null;
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
 * Serial Monitor 宿主：组合 MonitorRegistry（元数据/持久化）与每监视器运行时；
 * 对上（provider/bridge/状态栏）提供统一的监视与操作入口。
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
      this._stopPeriodic(rt);
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
    // 静默断开 → 释放会话 → 删除元数据
    this._stopPeriodic(rt);
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

  /** 更新监视器显示类配置（bridge config 端点用）：manager 生效 + 持久化 */
  updateMonitorConfig(id: string, partial: Partial<SerialConfig>): SerialConfig {
    const rt = this._runtimes.get(id);
    if (rt) { rt.manager.updateSettings(partial); }
    return this._registry.updateConfig(id, partial);
  }

  /** 连接指定监视器；端口被其它监视器占用时拒绝并返回占用者描述 */
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

  /** 检查端口被哪个其它监视器占用（返回占用者元数据） */
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
            // 断开时停止该监视器的周期发送，并广播状态（视口同步取消勾选）
            if (rt.periodic) {
              this._stopPeriodic(rt);
              this._emitPeriodicState(meta.id, false, rt.periodicIntervalMs);
            }
          }
        }
        this._onEvent({ type: 'status', monitorId: meta.id, connected, port: portPath ?? '', baudRate: baudRate ?? 0 });
      },
      onError: (msg) => { this._onEvent({ type: 'error', monitorId: meta.id, message: msg }); },
      onCounterUpdate: (rx, tx) => { this._onEvent({ type: 'counters', monitorId: meta.id, rx, tx }); },
    });
    manager.updateSettings(meta.config);
    this._runtimes.set(meta.id, {
      meta,
      manager,
      session,
      pendingTerminalBytes: null,
      periodicIntervalMs: 1000,
      periodic: null,
    });
  }

  /** 周期发送的对外状态（新视口初始化时同步勾选与周期） */
  periodicState(id: string): { enabled: boolean; intervalMs: number } {
    const rt = this._runtimes.get(id);
    return {
      enabled: !!rt?.periodic?.timer,
      intervalMs: rt?.periodicIntervalMs ?? 1000,
    };
  }

  /**
   * 周期发送（宿主侧唯一定时器）：视口发来启停/参数更新，宿主运行定时器，
   * 状态经 periodicState 广播到所有视口——两侧界面表现完全一致且不会双发。
   */
  setPeriodicSend(
    id: string,
    opts: {
      enabled: boolean; intervalMs?: number; text?: string; payload?: string; hexSend?: boolean; echo?: boolean;
    },
  ): void {
    const rt = this._runtimes.get(id);
    if (!rt) { return; }

    if (!opts.enabled || !rt.manager.isConnected) {
      // 关闭，或未连接时请求开启：一律按关闭处理并广播（视口同步取消勾选）
      const intervalMs = Math.max(10, Math.floor(opts.intervalMs ?? rt.periodicIntervalMs));
      rt.periodicIntervalMs = intervalMs;
      this._stopPeriodic(rt);
      this._emitPeriodicState(id, false, intervalMs);
      return;
    }

    const intervalMs = Math.max(10, Math.floor(opts.intervalMs ?? rt.periodicIntervalMs));
    rt.periodicIntervalMs = intervalMs;
    const previousInterval = rt.periodic?.intervalMs;
    if (!rt.periodic) {
      rt.periodic = {
        timer: null,
        intervalMs,
        text: opts.text ?? '',
        payload: opts.payload ?? opts.text ?? '',
        hexSend: opts.hexSend ?? false,
        echo: opts.echo ?? false,
      };
    } else {
      rt.periodic.intervalMs = intervalMs;
      if (opts.text !== undefined) {
        rt.periodic.text = opts.text;
        if (opts.payload === undefined) { rt.periodic.payload = opts.text; }
      }
      if (opts.payload !== undefined) { rt.periodic.payload = opts.payload; }
      if (opts.hexSend !== undefined) { rt.periodic.hexSend = opts.hexSend; }
      if (opts.echo !== undefined) { rt.periodic.echo = opts.echo; }
    }
    // 定时器不存在或周期变化时（重）启动；仅更新文本时不重启、保持节拍相位
    if (!rt.periodic.timer || previousInterval !== intervalMs) {
      if (rt.periodic.timer) { clearInterval(rt.periodic.timer); }
      rt.periodic.timer = setInterval(() => this._periodicTick(id), intervalMs);
    }
    this._emitPeriodicState(id, true, intervalMs);
  }

  private _periodicTick(id: string): void {
    const rt = this._runtimes.get(id);
    if (!rt || !rt.periodic) { return; }
    if (!rt.manager.isConnected) {
      const intervalMs = rt.periodicIntervalMs;
      this._stopPeriodic(rt);
      this._emitPeriodicState(id, false, intervalMs);
      return;
    }
    const { text, payload, hexSend, echo } = rt.periodic;
    if (!text.trim()) { return; } // 空草稿：跳过本拍（与旧行为一致）
    void rt.manager.send(payload, hexSend, rt.manager.config.lineEnding);
    this._onEvent({ type: 'periodicTick', monitorId: id, text, payload, hexSend, echo });
  }

  private _stopPeriodic(rt: MonitorRuntime): void {
    if (rt.periodic?.timer) { clearInterval(rt.periodic.timer); }
    rt.periodic = null;
  }

  private _emitPeriodicState(id: string, enabled: boolean, intervalMs: number): void {
    this._onEvent({ type: 'periodicState', monitorId: id, enabled, intervalMs });
  }

  /** 终端字节落串口：未连接时暂存并触发连接（连接成功后由 provider 排空） */
  private _onTx(id: string, bytes: string): void {
    const rt = this._runtimes.get(id);
    if (!rt) { return; }
    if (rt.manager.isConnected) {
      void rt.manager.send(bytes, false, 'none');
    } else if (rt.pendingTerminalBytes === null) {
      // 首次入队才请求连接；后续字节（如多行粘贴）追加到同一批，避免重复发起连接
      rt.pendingTerminalBytes = bytes;
      this._onEvent({ type: 'terminalConnectRequest', monitorId: id });
    } else {
      rt.pendingTerminalBytes += bytes;
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
    if (/MCP TX(?: HEX)?>> /.test(text)) {
      // MCP 发送回显：直接作为 echo 日志行，不进终端行模拟
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
  | { type: 'terminalConnectRequest'; monitorId: string }
  | { type: 'periodicState'; monitorId: string; enabled: boolean; intervalMs: number }
  | {
      type: 'periodicTick'; monitorId: string; text: string; payload: string; hexSend: boolean; echo: boolean;
    };
