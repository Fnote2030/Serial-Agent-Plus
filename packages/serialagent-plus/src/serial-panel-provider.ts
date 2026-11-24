import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { MonitorHost, MonitorHostEvent, MonitorViewInfo } from './monitor-host';
import { PortAutoRefresh } from './port-auto-refresh';
import { SerialConfig } from './types';

const DEFAULT_BAUDRATES = [
  4800, 9600, 19200, 38400, 57600, 74880,
  115200, 230400, 256000, 460800, 921600,
  1000000, 1500000, 2000000, 4500000,
];

const MAX_SEND_HISTORY = 20;
const MAX_SERIAL_PROFILES = 10;
const MAX_QUICK_COMMANDS = 12;

interface SerialProfile {
  id: string;
  name: string;
  config: SerialConfig;
}

interface QuickCommand {
  id: string;
  label: string;
  value: string;
  hexSend?: boolean;
}

export type AccordionPanel = 'monitor';

interface SerialPanelUiState {
  normalSendHeight?: number;
}

/** 视口日志条的显示条目（时间戳已格式化，回放时原样追加） */
interface LogSnapshotEntry {
  text: string;
  kind: 'text' | 'echo';
}

interface LogRing {
  entries: LogSnapshotEntry[];
  bytes: number;
}

export class SerialPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'serialagent-plus.serialPanel';
  public static readonly panelViewType = 'serialagent-plus.serialPanel.tab';

  private _view?: vscode.WebviewView;
  /** 编辑器区面板注册表：panel → 绑定的 monitorId（空串 = 未指定，默认第一个） */
  private readonly _panels = new Map<vscode.WebviewPanel, string>();
  private readonly _portAutoRefresh: PortAutoRefresh;
  /** 每监视器最近一次广播的 UI 状态（新视口打开时随 restoreState 下发） */
  private readonly _uiStates = new Map<string, Record<string, unknown>>();
  /** 每监视器日志区显示内容（新视口打开时回放，保证两个视口日志一致） */
  private readonly _logRings = new Map<string, LogRing>();

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _host: MonitorHost,
    private readonly _onStatusChange: (connected: boolean, portPath?: string, baudRate?: number) => void,
  ) {
    this._portAutoRefresh = new PortAutoRefresh(
      this._host.primary().manager,
      (ports) => {
        this.postMessage({ type: 'updatePorts', ports });
      },
    );
  }

  /** MonitorHost 事件 → 组播到所有视口（侧边栏 + 编辑器面板） */
  public handleHostEvent(event: MonitorHostEvent): void {
    switch (event.type) {
      case 'metas': {
        this.postMessage({ type: 'monitorsChanged', monitors: event.monitors });
        // 重命名刷新面板标题；被删除监视器的编辑器面板同步关闭
        const alive = new Set(event.monitors.map((m) => m.id));
        for (const id of [...this._logRings.keys()]) {
          if (!alive.has(id)) { this._logRings.delete(id); }
        }
        for (const [panel, mid] of [...this._panels]) {
          if (mid && !alive.has(mid)) {
            panel.dispose();
          } else if (mid) {
            this._refreshPanelTitle(panel, mid);
          }
        }
        break;
      }
      case 'status':
        this.postMessage({
          type: 'updateStatus',
          monitorId: event.monitorId,
          connected: event.connected,
          port: event.port,
          baudRate: event.baudRate,
          parity: this._host.runtime(event.monitorId)?.manager.config.parity ?? 'none',
        });
        this._onStatusChange(event.connected, event.port, event.baudRate);
        break;
      case 'logLines':
        for (const line of event.lines) {
          this._appendLogRing(event.monitorId, this._prefixTimestamp(event.monitorId, line), event.kind);
        }
        this.postMessage({ type: 'logLines', monitorId: event.monitorId, lines: event.lines, kind: event.kind });
        break;
      case 'terminalState':
        this.postMessage({ type: 'terminalState', monitorId: event.monitorId, state: event.state });
        break;
      case 'counters':
        this.postMessage({ type: 'updateCounters', monitorId: event.monitorId, rx: event.rx, tx: event.tx });
        break;
      case 'error':
        this._appendLogRing(event.monitorId, `[ERROR] ${event.message}`, 'echo');
        this.postMessage({ type: 'appendError', monitorId: event.monitorId, message: event.message });
        break;
      case 'clearScreen':
        this._clearLogRing(event.monitorId);
        this.postMessage({ type: 'clearScreen', monitorId: event.monitorId });
        break;
      case 'terminalConnectRequest': {
        // 终端在未连接时按键：按该监视器当前配置发起连接，连接成功后由 host 排空待发字节
        const rt = this._host.runtime(event.monitorId);
        if (rt && !rt.manager.isConnected) {
          void this._host.connect(event.monitorId, rt.meta.config);
        }
        break;
      }
      case 'periodicState':
        this.postMessage({
          type: 'periodicState',
          monitorId: event.monitorId,
          enabled: event.enabled,
          intervalMs: event.intervalMs,
        });
        break;
      case 'periodicTick': {
        if (event.echo) {
          // 周期发送回显行也进日志环：新视口回放时与已有视口一致
          this._appendLogRing(
            event.monitorId,
            `TX>> ${this._prefixTimestamp(event.monitorId, event.payload)}`,
            'echo',
          );
        }
        this.postMessage({
          type: 'periodicTick',
          monitorId: event.monitorId,
          text: event.text,
          payload: event.payload,
          hexSend: event.hexSend,
          echo: event.echo,
        });
        // 发送历史由宿主统一维护（节拍内文本不变时不写全局状态、不广播）
        const meta = this._host.registry.get(event.monitorId);
        if (meta && meta.sendHistory[0] !== event.text) {
          const history = [
            event.text,
            ...meta.sendHistory.filter((item) => item !== event.text),
          ].slice(0, MAX_SEND_HISTORY);
          this._host.registry.updateSendHistory(event.monitorId, history);
          this.postMessage({ type: 'sendHistorySync', monitorId: event.monitorId, history });
        }
        break;
      }
    }
  }

  dispose(): void {
    this._portAutoRefresh.dispose();
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._context.extensionUri],
    };
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    this._initializeView(webviewView.webview);

    webviewView.onDidChangeVisibility(() => {
      this._updatePortRefreshVisibility();
    });
    if (webviewView.visible) {
      this._updatePortRefreshVisibility();
    }
  }

  public resolveWebviewPanel(panel: vscode.WebviewPanel, monitorId?: string): void {
    const boundMonitorId = monitorId ?? '';
    this._panels.set(panel, boundMonitorId);
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._context.extensionUri],
    };
    // 面板视图：隐藏标签栏管理组件（仅展示绑定的监视器）
    panel.webview.html = this._getHtmlForWebview(panel.webview, !!boundMonitorId);

    this._initializeView(panel.webview, boundMonitorId || undefined);

    panel.onDidChangeViewState(() => {
      this._updatePortRefreshVisibility();
    });
    if (panel.visible) {
      this._updatePortRefreshVisibility();
    }

    panel.onDidDispose(() => {
      this._panels.delete(panel);
      this._updatePortRefreshVisibility();
    });

    if (boundMonitorId) {
      this._refreshPanelTitle(panel, boundMonitorId);
    }
  }

  /** 将指定监视器展示到编辑器区（按 monitorOpenTarget 设置选择分组），已打开则前置 */
  public openMonitorInEditor(monitorId: string): void {
    const meta = this._host.registry.get(monitorId);
    if (!meta) {
      vscode.window.showWarningMessage('[Serial Agent Plus] Monitor not found');
      return;
    }
    for (const [panel, mid] of this._panels) {
      if (mid === monitorId) {
        panel.reveal();
        return;
      }
    }
    const target = vscode.workspace.getConfiguration('serialagent')
      .get<'active' | 'beside'>('monitorOpenTarget', 'active');
    const panel = vscode.window.createWebviewPanel(
      SerialPanelProvider.panelViewType,
      `${meta.index}=${meta.name}`,
      target === 'beside' ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this._context.extensionUri],
      },
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(this._context.extensionUri, 'media', 'SerialAgentPlus.png'),
      dark: vscode.Uri.joinPath(this._context.extensionUri, 'media', 'SerialAgentPlus.png'),
    };
    this.resolveWebviewPanel(panel, monitorId);
  }

  private _refreshPanelTitle(panel: vscode.WebviewPanel, monitorId: string): void {
    const meta = this._host.registry.get(monitorId);
    if (meta) {
      panel.title = `${meta.index}=${meta.name}`;
    }
  }

  public async refreshPortList(options?: { forceFull?: boolean; silent?: boolean; target?: vscode.Webview }): Promise<void> {
    const send = (message: Record<string, unknown>) => {
      if (options?.target) {
        void options.target.postMessage(message);
      } else {
        this.postMessage(message);
      }
    };
    try {
      if (options?.forceFull) {
        const ports = await this._host.primary().manager.listPorts({
          metadata: 'full',
          forceMetadata: true,
        });
        this._portAutoRefresh.syncFingerprints(ports);
        send({ type: 'updatePorts', ports });
        return;
      }

      const ports = await this._portAutoRefresh.refreshOnce();
      if (ports) {
        send({ type: 'updatePorts', ports });
      }
    } catch (err: unknown) {
      if (options?.silent) {
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`[Serial Agent Plus] Scan failed: ${msg}`);
    }
  }

  public handlePortRefreshConfigChange(): void {
    this._portAutoRefresh.handleConfigChange();
  }

  /** 读取后台配置 serialagent.logBufferKB（钳制 1..10240） */
  private _readLogBufferKB(): number {
    const kb = vscode.workspace.getConfiguration('serialagent').get<number>('logBufferKB', 1024);
    return Math.max(1, Math.min(10240, Math.floor(kb) || 1024));
  }

  /** 配置变化：同步所有监视器与已打开的 webview */
  public handleLogBufferConfigChange(): void {
    const kb = this._readLogBufferKB();
    for (const rt of this._host.list().map((info) => this._host.runtime(info.id))) {
      rt?.manager.updateSettings({ logBufferKB: kb });
    }
    for (const ring of this._logRings.values()) {
      this._trimLogRing(ring);
    }
    this.postMessage({ type: 'updateLogBuffer', logBufferKB: kb });
  }

  /** 与 webview 的 formatLogTimestamp 输出一致（含尾随空格），回放时原样追加 */
  private _logTimestamp(): string {
    const now = new Date();
    return `[${now.toTimeString().split(' ')[0]}.${String(now.getMilliseconds()).padStart(3, '0')}] `;
  }

  private _prefixTimestamp(monitorId: string, text: string): string {
    const showTimestamp = this._host.runtime(monitorId)?.manager.config.showTimestamp ?? false;
    return showTimestamp ? `${this._logTimestamp()}${text}` : text;
  }

  /** 新视口打开时回放的日志条（时间戳在产生的视口格式化后此处原样保存） */
  private _appendLogRing(monitorId: string, text: string, kind: 'text' | 'echo'): void {
    if (!monitorId) { return; }
    let ring = this._logRings.get(monitorId);
    if (!ring) {
      ring = { entries: [], bytes: 0 };
      this._logRings.set(monitorId, ring);
    }
    ring.entries.push({ text, kind });
    ring.bytes += Buffer.byteLength(text, 'utf8');
    this._trimLogRing(ring);
  }

  /** 按 serialagent.logBufferKB 裁剪（与 webview 一致：至少保留最新一条） */
  private _trimLogRing(ring: LogRing): void {
    const limit = this._readLogBufferKB() * 1024;
    while (ring.entries.length > 1 && ring.bytes > limit) {
      const oldest = ring.entries.shift();
      if (!oldest) { break; }
      ring.bytes -= Buffer.byteLength(oldest.text, 'utf8');
    }
  }

  private _clearLogRing(monitorId: string): void {
    this._logRings.delete(monitorId);
  }

  /** 清空某监视器日志：清日志环 + 广播给所有视口（bridge/MCP 与 webview 按钮共用） */
  public clearMonitorLog(monitorId: string): void {
    this._clearLogRing(monitorId);
    this.postMessage({ type: 'clearLog', monitorId });
  }

  private _isAnyViewVisible(): boolean {
    if (this._view?.visible) { return true; }
    for (const [panel] of this._panels) {
      if (panel.visible) { return true; }
    }
    return false;
  }

  private _updatePortRefreshVisibility(): void {
    this._portAutoRefresh.onVisibilityChange(this._isAnyViewVisible());
  }

  public postMessage(message: Record<string, unknown>) {
    void this._view?.webview.postMessage(message);
    for (const [panel] of this._panels) {
      void panel.webview.postMessage(message);
    }
  }

  private _saveSerialProfiles(profiles: SerialProfile[]): void {
    void this._context.globalState.update('serialProfiles', profiles.slice(0, MAX_SERIAL_PROFILES));
  }

  private _loadSerialProfiles(): SerialProfile[] {
    return this._context.globalState.get<SerialProfile[]>('serialProfiles', []);
  }

  private _saveQuickCommands(commands: QuickCommand[]): void {
    void this._context.globalState.update('quickCommands', commands.slice(0, MAX_QUICK_COMMANDS));
  }

  private _loadQuickCommands(): QuickCommand[] {
    return this._context.globalState.get<QuickCommand[]>('quickCommands', []);
  }

  private _loadPanelUiState(): SerialPanelUiState {
    return this._normalizePanelUiState(this._context.globalState.get<Partial<SerialPanelUiState>>('serialPanelUiState', {}));
  }

  private _persistPanelUiState(partial: Partial<SerialPanelUiState>): void {
    const nextState = this._normalizePanelUiState({
      ...this._loadPanelUiState(),
      ...partial,
    });
    void this._context.globalState.update('serialPanelUiState', nextState);
  }

  private _normalizePanelUiState(state: Partial<SerialPanelUiState>): SerialPanelUiState {
    return {
      normalSendHeight: typeof state.normalSendHeight === 'number' ? state.normalSendHeight : undefined,
    };
  }

  /** 非法文件名字符（Windows/POSIX 交集）替换为 '-'，并压缩空白 */
  private _sanitizeFileNameSegment(value: string): string {
    const cleaned = value
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.]+/, '')
      .slice(0, 40)
      .replace(/[-.]+$/, '');
    return cleaned || 'monitor';
  }

  /** 文件名时间戳：YYYYMMDDHHmmss */
  private _compactTimestamp(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
      + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }

  /** 可读时间戳：YYYY-MM-DD HH:mm:ss */
  private _readableTimestamp(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
      + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  /** 默认文件名：serial-agent-plus-<监视器名>-<YYYYMMDDHHmmss>.log */
  private _defaultLogFileName(monitorId: string, now: Date): string {
    const meta = this._host.registry.get(monitorId);
    const segment = this._sanitizeFileNameSegment(meta?.name ?? 'monitor');
    return `serial-agent-plus-${segment}-${this._compactTimestamp(now)}.log`;
  }

  /** 文件头部的串口信息（与日志正文一起保存，便于事后回溯连接参数） */
  private _buildLogHeader(monitorId: string, lineCount: number, now: Date): string[] {
    const meta = this._host.registry.get(monitorId);
    const rt = this._host.runtime(monitorId);
    const cfg = rt?.manager.config;
    const connected = !!rt?.manager.isConnected;
    const port = (connected ? rt!.manager.currentPath : cfg?.port) || '(none)';
    const baudRate = (connected ? rt!.manager.currentBaudRate : cfg?.baudRate) || 0;
    const frame = cfg ? `${cfg.dataBits}-${cfg.parity}-${cfg.stopBits}` : 'unknown';

    const rows: Array<[string, string]> = [
      ['Monitor', meta ? `${meta.index}=${meta.name}` : monitorId || '(unknown)'],
      ['Connection', connected ? 'Connected' : 'Disconnected'],
      ['Port', String(port)],
      ['Baud Rate', baudRate ? String(baudRate) : '(unknown)'],
      ['Frame', frame],
      ['Flow Control', cfg?.flowControl ?? 'none'],
      ['Encoding', cfg?.encoding === 'gbk' ? 'GBK' : 'UTF-8'],
      ['RX / TX', `${formatByteCount(rt?.manager.rxBytes ?? 0)} / ${formatByteCount(rt?.manager.txBytes ?? 0)}`],
      ['Exported At', this._readableTimestamp(now)],
      ['Log Lines', String(lineCount)],
    ];
    const width = Math.max(...rows.map(([label]) => label.length));
    return [
      '# ===== Serial Agent Plus log =====',
      ...rows.map(([label, value]) => `# ${label.padEnd(width)} : ${value}`),
      '# ===== log data =====',
      '',
    ];
  }

  private async _saveLogToFile(monitorId: string, logLines: string[]): Promise<void> {
    const now = new Date();
    const fileName = this._defaultLogFileName(monitorId, now);
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const defaultUri = workspaceFolder
      ? vscode.Uri.joinPath(workspaceFolder.uri, fileName)
      : vscode.Uri.file(path.join(os.homedir(), fileName));

    const target = await vscode.window.showSaveDialog({
      saveLabel: 'Save Serial Log',
      filters: {
        'Log Files': ['log', 'txt'],
        'All Files': ['*'],
      },
      defaultUri,
    });

    if (!target) {
      return;
    }

    const header = this._buildLogHeader(monitorId, logLines.length, now);
    const content = `${[...header, ...logLines].join('\n')}\n`;
    await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
    vscode.window.showInformationMessage(`[Serial Agent Plus] Log saved: ${target.fsPath}`);
  }

  private _initializeView(webview: vscode.Webview, monitorId?: string): void {
    // 缓冲上限来自后台配置项 serialagent.logBufferKB，应用到所有监视器
    this.handleLogBufferConfigChange();

    this._setupWebviewMessageHandler(webview, monitorId);
    // webview 脚本注册 message 监听前收到的 postMessage 会丢失（标签栏/快捷指令空白），
    // 因此初始状态等视口发来 ready 后再下发；这里先发一次覆盖"脚本已就绪"的竞态
    this._sendInitialState(webview, monitorId);
  }

  /** 向单个视口下发初始状态（restoreState + activateMonitor + 周期/连接/计数） */
  private _sendInitialState(webview: vscode.Webview, monitorId?: string): void {
    // 初始状态只发给"这个"新视口：广播会让其它视口误切标签（如 activateMonitor）
    const send = (message: Record<string, unknown>) => { void webview.postMessage(message); };

    void this.refreshPortList({ forceFull: true, silent: true, target: webview });

    // 监视器列表 + 各自配置与发送历史（webview 按 monitorId 分桶恢复）
    const monitors = this._host.list().map((info) => {
      const rt = this._host.runtime(info.id)!;
      return {
        ...info,
        config: rt.manager.config,
        sendHistory: rt.meta.sendHistory,
        ui: this._uiStates.get(info.id) ?? null,
      };
    });
    send({
      type: 'restoreState',
      monitors,
      serialProfiles: this._loadSerialProfiles(),
      quickCommands: this._loadQuickCommands(),
      uiState: this._loadPanelUiState(),
    });

    // 编辑器面板绑定指定监视器：恢复完成后切换激活标签
    if (monitorId) {
      send({ type: 'activateMonitor', monitorId });
    }

    // 补充推送各监视器的周期发送状态；已连接的再补连接状态与计数（webview 恢复时默认 disconnected）
    for (const rt of this._host.list().map((info) => this._host.runtime(info.id)!)) {
      // 周期发送状态：新视口打开时与已有视口一致（勾选 + 周期数值）
      send({
        type: 'periodicState',
        monitorId: rt.meta.id,
        ...this._host.periodicState(rt.meta.id),
      });
      if (rt.manager.isConnected) {
        send({
          type: 'updateStatus',
          monitorId: rt.meta.id,
          connected: true,
          port: rt.manager.currentPath,
          baudRate: rt.manager.currentBaudRate,
          parity: rt.manager.config.parity,
        });
        send({
          type: 'updateCounters',
          monitorId: rt.meta.id,
          rx: rt.manager.rxBytes,
          tx: rt.manager.txBytes,
        });
      }
    }
  }

  private _setupWebviewMessageHandler(webview: vscode.Webview, boundMonitorId?: string): void {
    webview.onDidReceiveMessage(async (data) => {
      const monitorId = typeof data.monitorId === 'string' ? data.monitorId : '';
      switch (data.type) {
        case 'ready': {
          // 视口脚本已注册消息监听：补发初始状态（首次下发可能早于脚本就绪而丢失）
          this._sendInitialState(webview, boundMonitorId);
          break;
        }

        case 'refreshPorts': {
          await this.refreshPortList({ forceFull: true });
          break;
        }

        case 'addMonitor': {
          if (this._host.registry.canCreate()) {
            this._host.createMonitor();
          } else {
            vscode.window.showWarningMessage('[Serial Agent Plus] Monitor limit reached (10)');
          }
          break;
        }

        case 'deleteMonitor': {
          if (!this._host.registry.canDelete()) {
            // 最后一个监视器不可删除：警告通知（而不是塞进串口状态栏）
            vscode.window.showWarningMessage('[Serial Agent Plus] At least one monitor must remain');
            break;
          }
          try {
            this._host.deleteMonitor(monitorId);
          } catch (err) {
            vscode.window.showWarningMessage(`[Serial Agent Plus] ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }

        case 'renameMonitor': {
          try {
            const info = this._host.renameMonitor(monitorId, String(data.name ?? ''));
            this.postMessage({ type: 'renameResult', monitorId, ok: true, index: info.index, name: info.name });
          } catch (err) {
            this.postMessage({
              type: 'renameResult',
              monitorId,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          break;
        }

        case 'connect': {
          const rt = this._host.runtime(monitorId);
          if (!rt) { break; }
          const { port, baudRate, dataBits, parity, stopBits, flowControl } = data;
          if (!port) {
            vscode.window.showWarningMessage('[Serial Agent Plus] Please select a serial port first');
            return;
          }
          const currentCfg = rt.manager.config;
          const normalizedFlowControl = this._normalizeFlowControl(flowControl ?? currentCfg.flowControl);
          const config: SerialConfig = {
            port,
            baudRate: baudRate ?? 115200,
            dataBits: dataBits ?? 8,
            parity: parity ?? 'none',
            stopBits: stopBits ?? 1,
            flowControl: normalizedFlowControl,
            lineEnding: currentCfg.lineEnding,
            showTimestamp: currentCfg.showTimestamp,
            hexMode: currentCfg.hexMode,
            encoding: currentCfg.encoding,
            rxIdleWrapMs: typeof data.rxIdleWrapMs === 'number' && data.rxIdleWrapMs >= 1
              ? Math.floor(data.rxIdleWrapMs)
              : currentCfg.rxIdleWrapMs,
            logBufferKB: this._readLogBufferKB(),
          };
          await this._host.connect(monitorId, config);
          break;
        }

        case 'disconnect': {
          const rt = this._host.runtime(monitorId);
          if (rt) { await rt.manager.disconnect(); }
          break;
        }

        case 'clearLog': {
          const rt = this._host.runtime(monitorId);
          if (!rt) { break; }
          rt.manager.clearLog();
          rt.manager.resetCounters();
          rt.session.resetEditing();
          this.clearMonitorLog(monitorId);
          break;
        }

        case 'terminalKey': {
          const rt = this._host.runtime(monitorId);
          if (rt) { rt.session.handleKey(data.intent); }
          break;
        }

        case 'pasteToTerminal': {
          // Ctrl/Cmd+V：由扩展侧读取剪贴板（webview 无剪贴板读权限），写入终端输入行
          const rt = this._host.runtime(monitorId);
          if (!rt) { break; }
          const text = await vscode.env.clipboard.readText();
          if (text) { rt.session.handleKey({ type: 'paste', text }); }
          break;
        }

        case 'requestMonitorSnapshot': {
          // 新视口 / 切换标签：回放该监视器的日志与终端快照，两个视口数据保持一致
          if (!monitorId) { break; }
          const rt = this._host.runtime(monitorId);
          const ring = this._logRings.get(monitorId);
          void webview.postMessage({
            type: 'monitorSnapshot',
            monitorId,
            entries: ring ? ring.entries.map((entry) => ({ ...entry })) : [],
            terminal: rt ? rt.session.snapshot() : null,
          });
          break;
        }

        case 'setPeriodicSend': {
          // 周期发送：宿主侧单一定时器（视口只发指令，避免双视口双发）
          this._host.setPeriodicSend(monitorId, {
            enabled: !!data.enabled,
            intervalMs: Number(data.intervalMs) || 1000,
            text: typeof data.text === 'string' ? data.text : undefined,
            payload: typeof data.payload === 'string' ? data.payload : undefined,
            hexSend: data.hexSend === undefined ? undefined : !!data.hexSend,
            echo: data.echo === undefined ? undefined : !!data.echo,
          });
          break;
        }

        case 'openMonitorInEditor': {
          // 标题行"展开到编辑器区"按钮：展开当前选定的监视器
          if (monitorId) {
            this.openMonitorInEditor(monitorId);
          }
          break;
        }

        case 'sendData': {
          const rt = this._host.runtime(monitorId);
          if (!rt) { break; }
          const cfg = rt.manager.config;
          const hexSend = data.hexSend ?? false;
          const lineEnding = typeof data.lineEnding === 'string'
            ? data.lineEnding
            : cfg.lineEnding;
          await rt.manager.send(data.text, hexSend, lineEnding);
          break;
        }

        case 'updateSettings': {
          const rt = this._host.runtime(monitorId);
          if (!rt) { break; }
          const partial: Partial<SerialConfig> = {};
          if (data.showTimestamp !== undefined) { partial.showTimestamp = data.showTimestamp; }
          if (data.hexMode !== undefined) { partial.hexMode = data.hexMode; }
          if (data.lineEnding !== undefined) { partial.lineEnding = data.lineEnding; }
          if (data.encoding !== undefined) { partial.encoding = data.encoding === 'gbk' ? 'gbk' : 'utf8'; }
          if (data.rxIdleWrapMs !== undefined) {
            partial.rxIdleWrapMs = Math.max(1, Math.min(60000, Math.floor(Number(data.rxIdleWrapMs) || 20)));
          }
          if (data.flowControl !== undefined) { partial.flowControl = this._normalizeFlowControl(data.flowControl); }
          rt.manager.updateSettings(partial);
          this._host.registry.updateConfig(monitorId, partial);
          // 广播到所有视口（侧边栏 + 编辑器面板）：同一监视器的显示选项保持一致
          this.postMessage({ type: 'settingsSync', monitorId, settings: partial });
          break;
        }

        case 'saveSendHistory': {
          this._host.registry.updateSendHistory(monitorId, data.history ?? []);
          // 广播：另一视口的发送历史下拉同步更新
          this.postMessage({ type: 'sendHistorySync', monitorId, history: data.history ?? [] });
          break;
        }

        case 'saveSerialProfiles': {
          this._saveSerialProfiles(data.profiles ?? []);
          break;
        }

        case 'uiStateChange': {
          // 任一视口的完整 UI 状态变化：记录并广播到所有视口（同一监视器保持一致）
          if (monitorId && data.state && typeof data.state === 'object') {
            this._uiStates.set(monitorId, data.state as Record<string, unknown>);
            this.postMessage({ type: 'uiStateSync', monitorId, state: data.state });
          }
          break;
        }

        case 'saveQuickCommands': {
          this._saveQuickCommands(data.commands ?? []);
          // 广播：另一视口的快捷指令列表同步更新
          this.postMessage({ type: 'quickCommandsSync', commands: data.commands ?? [] });
          break;
        }

        case 'saveConfig': {
          if (data.config && monitorId) {
            const rt = this._host.runtime(monitorId);
            if (rt) {
              this._host.registry.updateConfig(monitorId, { ...rt.manager.config, ...data.config });
            }
          }
          break;
        }

        case 'saveLogToFile': {
          // monitorId 决定默认文件名与文件头部的串口信息；缺失时回退到主监视器
          const targetId = monitorId || this._host.list()[0]?.id || '';
          await this._saveLogToFile(targetId, data.lines ?? []);
          break;
        }

        case 'savePanelLayout': {
          if (typeof data.normalSendHeight === 'number') {
            this._persistPanelUiState({ normalSendHeight: data.normalSendHeight });
          }
          break;
        }
      }
    });
  }

  private _normalizeFlowControl(value: unknown): SerialConfig['flowControl'] {
    switch (value) {
      case 'rtscts':
      case 'xon':
      case 'xoff':
      case 'none':
        return value;
      default:
        return 'none';
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview, panelMode = false): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'main.js'));
    const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'reset.css'));
    const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'vscode.css'));
    const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'main.css'));
    const styleCodiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this._context.extensionUri,
        'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css',
      ),
    );

    const nonce = getNonce();
    const baudratePresetOptions = [
      '<option value="">Custom</option>',
      ...DEFAULT_BAUDRATES.map((baudrate) => `<option value="${baudrate}"${baudrate === 115200 ? ' selected' : ''}>${baudrate}</option>`),
    ].join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleResetUri}" rel="stylesheet">
  <link href="${styleVSCodeUri}" rel="stylesheet">
  <link href="${styleMainUri}" rel="stylesheet">
  <link href="${styleCodiconsUri}" rel="stylesheet">
  <title>Serial Agent Plus Monitor</title>
</head>
<body${panelMode ? ' class="panel-view"' : ''}>
  <div class="accordion-root">
  <section id="panel-monitor" class="accordion-panel accordion-panel--monitor is-expanded" data-panel="monitor">
    <div id="accordion-body-monitor" class="accordion-body">
    <div class="monitor-panel-main">
    <div class="monitor-tabs-wrap">
      <div id="monitor-tabs-slider" class="monitor-tabs-slider" aria-hidden="true"><div class="monitor-tabs-slider-thumb"></div></div>
    <div class="monitor-tabs-scroll">
      <div id="monitor-tabs" class="monitor-tabs" aria-label="Serial monitors"></div>
      <button id="btn-add-monitor" class="monitor-tabs-add" type="button" title="Add Serial Monitor (max 10)">&#43;</button>
    </div>
    </div>
    <div class="monitor-title-row">
    <span id="monitor-name-title" class="monitor-title-row-name" title="1=Serial Monitor1 (double-click to rename)">1=Serial Monitor1</span>
    <span class="spacer"></span>
    <button id="btn-monitor-expand" class="monitor-row-btn" type="button" title="Open this monitor in the editor area">
      <span class="codicon codicon-link-external" aria-hidden="true"></span>
    </button>
    </div>
    <div class="monitor-status-bar">
      <span id="status-dot" class="status-indicator status-disconnected"></span>
      <span id="status-text">Disconnected</span>
      <span id="monitor-port-chip" class="config-chip hidden"></span>
      <span id="monitor-baud-chip" class="config-chip hidden"></span>
      <span id="monitor-parity-chip" class="config-chip hidden"></span>
      <span class="spacer"></span>
      <span id="rx-count" class="counter" title="Received bytes">RX: 0</span>
      <span id="tx-count" class="counter" title="Sent bytes">TX: 0</span>
      <button id="btn-config-toggle" class="status-action-btn" type="button" title="Toggle serial port settings" aria-expanded="false">
        <span class="config-toggle-icon" aria-hidden="true"></span>Config
      </button>
      <button id="btn-monitor-connect" class="status-action-btn status-action-primary" type="button" title="Toggle serial connection">Open</button>
    </div>

    <div id="serial-config-drawer" class="serial-config-drawer hidden">
    <div id="serial-config-section" class="panel-inner">
    <div class="config-section">
    <div class="config-row">
      <label>Port</label>
      <div class="config-control">
        <select id="port-select"><option value="">-- Refresh --</option></select>
        <button id="btn-refresh" class="icon-btn" title="Refresh Ports">&#x21bb;</button>
      </div>
    </div>
    <div class="config-row">
      <label>Baud</label>
      <div class="config-control">
        <select id="baudrate-preset-select" title="Common baud rates">${baudratePresetOptions}</select>
        <input id="baudrate-input" type="number" value="115200" min="1" title="Custom baud rate" />
      </div>
    </div>
    <div class="config-row">
      <label>Parity</label>
      <div class="config-control">
        <select id="parity-select">
          <option value="none" selected>None</option><option value="even">Even</option>
          <option value="odd">Odd</option><option value="mark">Mark</option>
          <option value="space">Space</option>
        </select>
      </div>
    </div>
    <div id="advanced-config" class="config-section">
      <div class="config-row">
        <label>Data</label>
        <select id="databits-select">
          <option value="5">5</option><option value="6">6</option>
          <option value="7">7</option><option value="8" selected>8</option>
        </select>
      </div>
      <div class="config-row">
        <label>Stop</label>
        <select id="stopbits-select">
          <option value="1" selected>1</option><option value="1.5">1.5</option>
          <option value="2">2</option>
        </select>
      </div>
      <div class="config-row">
        <label>Flow</label>
        <select id="flow-control-select" title="Flow control">
          <option value="none" selected>None</option>
          <option value="rtscts">RTS/CTS</option>
          <option value="xon">XON/XOFF</option>
          <option value="xoff">XOFF only</option>
        </select>
      </div>
    </div>
    </div>

    </div>

    </div>

    <div class="log-toolbar">
      <input id="log-search" class="log-search-input" type="text" placeholder="Search or filter logs" />
      <button id="btn-freeze" class="btn-secondary btn-compact" type="button">Freeze</button>
      <button id="btn-copy-log" class="btn-secondary btn-compact" type="button">Copy</button>
      <button id="btn-save-log" class="btn-secondary btn-compact" type="button">Save</button>
      <button id="btn-clear" class="btn-secondary btn-icon-compact" type="button" title="Clear logs" aria-label="Clear logs">
        <svg class="btn-icon-svg clear-broom" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="currentColor">
          <path d="M14.854 1.146a.5.5 0 0 0-.707 0L9.476 5.817A3.5 3.5 0 0 0 4.653 6.19l-.684.639-2.675 1.216a.5.5 0 0 0-.285.809l6 6a.5.5 0 0 0 .443.138.5.5 0 0 0 .366-.245l1.212-2.667.686-.686A3.5 3.5 0 0 0 10.184 6.524l4.67-4.67a.5.5 0 0 0 0-.707ZM4.141 7.849l4.01 4.01-.808 1.777L2.364 8.657 4.141 7.849Zm4.609 3.194L4.969 7.263l.372-.347.012-.012A2.5 2.5 0 0 1 9.146 6.854a2.5 2.5 0 0 1-1.793 4.189h-.003Z"/>
        </svg>
      </button>
    </div>

    <div class="options-bar">
      <label class="option-item" title="Show timestamp on each line">
        <input type="checkbox" id="opt-timestamp" />
        <span>Time</span>
      </label>
      <label class="option-item" title="HEX display mode (received data)">
        <input type="checkbox" id="opt-hex" />
        <span>HEX Recv</span>
      </label>
      <label class="option-item" title="Echo sent data in log area">
        <input type="checkbox" id="opt-echo" checked />
        <span>Echo</span>
      </label>
      <label class="option-item" title="Follow the latest log lines automatically">
        <input type="checkbox" id="opt-auto-scroll" checked />
        <span>Auto Scroll</span>
      </label>
      <label class="option-item send-ending-option" title="HEX display: wrap into a new line when the inter-byte gap exceeds this many ms (text display always waits for CR/LF)">
        <span>Wrap</span>
        <input id="rx-idle-wrap-input" class="periodic-interval-input" type="number" min="1" step="1" value="20" />
        <span>ms</span>
      </label>
      <label class="option-item send-ending-option" title="Text encoding for RX log decode and TX encode">
        <span>Encoding</span>
        <select id="encoding-select">
          <option value="utf8" selected>UTF-8</option>
          <option value="gbk">GBK</option>
        </select>
      </label>
    </div>

  <div class="content-wrapper">
    <div class="log-section">
      <div id="log-empty-state" class="empty-state">Waiting RX data...</div>
      <div id="log-area" class="log-area" tabindex="-1"></div>
    </div>
    <div id="resize-handle" class="resize-handle" title="Drag to resize"></div>
    <div class="send-section" id="send-section">
      <div class="quick-command-bar">
        <div id="quick-command-list" class="quick-command-list"></div>
      </div>

      <details id="quick-command-editor" class="quick-command-editor">
        <summary>Manage Quick Commands</summary>
        <div class="quick-command-form">
          <input id="quick-command-label" class="quick-command-input" type="text" placeholder="Label" />
          <textarea id="quick-command-value" class="quick-command-input quick-command-value" rows="3" placeholder="Command value"></textarea>
          <label class="option-item option-item-inline" title="Send the quick command as HEX bytes">
            <input type="checkbox" id="quick-command-hex" />
            <span>HEX</span>
          </label>
          <button id="btn-quick-command-save" class="btn-secondary btn-compact" type="button">Save</button>
          <button id="btn-quick-command-reset" class="btn-secondary btn-compact" type="button">Reset</button>
        </div>
        <div id="quick-command-manage-list" class="quick-command-manage-list"></div>
      </details>

      <div class="send-options-row">
        <label class="option-item" title="Send data as HEX bytes">
          <input type="checkbox" id="opt-hex-send" />
          <span>Hex</span>
        </label>
        <label class="option-item send-ending-option" title="Line ending for send">
          <span>End</span>
          <select id="line-ending-select">
            <option value="none" selected>None</option>
            <option value="lf">LF</option>
            <option value="crlf">CRLF</option>
            <option value="cr">CR</option>
          </select>
        </label>
        <div class="history-dropdown" id="history-dropdown">
          <button class="history-toggle" id="history-toggle" type="button">-- History --</button>
          <div class="history-menu" id="history-menu"></div>
        </div>
        <div class="cycle-group" title="Periodically resend the current send box content">
          <label class="option-item">
            <input type="checkbox" id="opt-periodic-send" />
            <span>Cycle</span>
          </label>
          <input id="periodic-interval-input" class="periodic-interval-input" type="number" min="10" step="10" value="1000" title="Periodic interval in ms (min 10)" />
          <span class="periodic-unit">ms</span>
        </div>
        <button id="btn-send" class="btn-send">Send</button>
      </div>
      <div class="send-input-row">
        <textarea id="send-input" rows="3" placeholder="Send data... (Ctrl+Enter to send)"></textarea>
      </div>
    </div>
    </div>
    </div>
  </section>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** 字节数可读化（与 webview 的日志计数显示一致） */
function formatByteCount(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1048576) { return `${(bytes / 1024).toFixed(1)} KB`; }
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
