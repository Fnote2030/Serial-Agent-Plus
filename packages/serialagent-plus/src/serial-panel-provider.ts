import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { SerialRuntime } from './serial-manager';
import { PortAutoRefresh } from './port-auto-refresh';
import { DEFAULT_CONFIG, SerialConfig } from './types';

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

export class SerialPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'serialagent-plus.serialPanel';
  public static readonly panelViewType = 'serialagent-plus.serialPanel.tab';

  private _view?: vscode.WebviewView;
  private _panel?: vscode.WebviewPanel;
  private readonly _portAutoRefresh: PortAutoRefresh;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _serialManager: SerialRuntime,
    private readonly _onStatusChange: (connected: boolean, portPath?: string, baudRate?: number) => void,
  ) {
    this._portAutoRefresh = new PortAutoRefresh(
      this._serialManager,
      (ports) => {
        this.postMessage({ type: 'updatePorts', ports });
      },
    );
  }

  dispose(): void {
    this._portAutoRefresh.dispose();
  }

  get panel(): vscode.WebviewPanel | undefined {
    return this._panel;
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

  public resolveWebviewPanel(panel: vscode.WebviewPanel): void {
    this._panel = panel;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._context.extensionUri],
    };
    panel.webview.html = this._getHtmlForWebview(panel.webview);

    this._initializeView(panel.webview);

    panel.onDidChangeViewState(() => {
      this._updatePortRefreshVisibility();
    });
    if (panel.visible) {
      this._updatePortRefreshVisibility();
    }

    panel.onDidDispose(() => {
      this._panel = undefined;
      this._updatePortRefreshVisibility();
    });
  }

  public async refreshPortList(options?: { forceFull?: boolean; silent?: boolean }): Promise<void> {
    try {
      if (options?.forceFull) {
        const ports = await this._serialManager.listPorts({
          metadata: 'full',
          forceMetadata: true,
        });
        this._portAutoRefresh.syncFingerprints(ports);
        this.postMessage({ type: 'updatePorts', ports });
        return;
      }

      const ports = await this._portAutoRefresh.refreshOnce();
      if (ports) {
        this.postMessage({ type: 'updatePorts', ports });
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

  /** 配置变化：同步 manager 与已打开的 webview */
  public handleLogBufferConfigChange(): void {
    const kb = this._readLogBufferKB();
    this._serialManager.updateSettings({ logBufferKB: kb });
    this.postMessage({ type: 'updateLogBuffer', logBufferKB: kb });
  }

  private _isAnyViewVisible(): boolean {
    return !!(this._view?.visible || this._panel?.visible);
  }

  private _updatePortRefreshVisibility(): void {
    this._portAutoRefresh.onVisibilityChange(this._isAnyViewVisible());
  }

  public postMessage(message: Record<string, unknown>) {
    void this._view?.webview.postMessage(message);
    void this._panel?.webview.postMessage(message);
  }

  public clearPanel(): void {
    this._panel = undefined;
  }

  private _saveConfig(partial: Partial<SerialConfig>): void {
    const saved = this._context.globalState.get<SerialConfig>('serialConfig', { ...DEFAULT_CONFIG });
    void this._context.globalState.update('serialConfig', { ...saved, ...partial });
  }

  private _loadConfig(): SerialConfig {
    const saved = this._context.globalState.get<Partial<SerialConfig>>('serialConfig', {});
    return { ...DEFAULT_CONFIG, ...saved };
  }

  private _saveSendHistory(history: string[]): void {
    void this._context.globalState.update('sendHistory', history.slice(0, MAX_SEND_HISTORY));
  }

  private _loadSendHistory(): string[] {
    return this._context.globalState.get<string[]>('sendHistory', []);
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

  private async _saveLogToFile(logLines: string[]): Promise<void> {
    const target = await vscode.window.showSaveDialog({
      saveLabel: 'Save Serial Log',
      filters: {
        'Log Files': ['log', 'txt'],
        'All Files': ['*'],
      },
      defaultUri: vscode.Uri.file(`serial-agent-${Date.now()}.log`),
    });

    if (!target) {
      return;
    }

    const content = logLines.join('\n');
    await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
    vscode.window.showInformationMessage(`[Serial Agent Plus] Log saved: ${target.fsPath}`);
  }

  private _initializeView(webview: vscode.Webview): void {
    const savedConfig = this._loadConfig();
    // 缓冲上限来自后台配置项 serialagent.logBufferKB（优先于历史 globalState 存值）
    savedConfig.logBufferKB = this._readLogBufferKB();
    this._serialManager.updateSettings(savedConfig);
    this._serialManager.setCallbacks({
      onLog: (text) => {
        this.postMessage({ type: 'appendLog', text });
      },
      onStatus: (connected, portPath, baudRate) => {
        this.postMessage({
          type: 'updateStatus',
          connected,
          port: portPath ?? '',
          baudRate: baudRate ?? 0,
          parity: this._serialManager.config.parity,
        });
        this._onStatusChange(connected, portPath, baudRate);
      },
      onError: (msg) => {
        vscode.window.showErrorMessage(`[Serial Agent Plus] ${msg}`);
        this.postMessage({ type: 'appendLog', text: `[ERROR] ${msg}\n` });
      },
      onCounterUpdate: (rx, tx) => {
        this.postMessage({ type: 'updateCounters', rx, tx });
      },
    });

    this._setupWebviewMessageHandler(webview);

    void this.refreshPortList({ forceFull: true, silent: true });

    this.postMessage({
      type: 'restoreConfig',
      config: savedConfig,
      sendHistory: this._loadSendHistory(),
      serialProfiles: this._loadSerialProfiles(),
      quickCommands: this._loadQuickCommands(),
      uiState: this._loadPanelUiState(),
    });

    if (this._serialManager.isConnected) {
      this.postMessage({
        type: 'updateStatus',
        connected: true,
        port: this._serialManager.currentPath,
        baudRate: this._serialManager.currentBaudRate,
        parity: this._serialManager.config.parity,
      });
      this.postMessage({
        type: 'updateCounters',
        rx: this._serialManager.rxBytes,
        tx: this._serialManager.txBytes,
      });
    }
  }

  private _setupWebviewMessageHandler(webview: vscode.Webview): void {
    webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'refreshPorts': {
          await this.refreshPortList({ forceFull: true });
          break;
        }

        case 'connect': {
          const { port, baudRate, dataBits, parity, stopBits, flowControl } = data;
          if (!port) {
            vscode.window.showWarningMessage('[Serial Agent Plus] Please select a serial port first');
            return;
          }
          const currentCfg = this._serialManager.config;
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
            logBufferKB: currentCfg.logBufferKB,
          };
          this._saveConfig(config);
          await this._serialManager.connect(config);
          break;
        }

        case 'disconnect': {
          await this._serialManager.disconnect();
          break;
        }

        case 'clearLog': {
          this._serialManager.clearLog();
          this._serialManager.resetCounters();
          this.postMessage({ type: 'clearLog' });
          break;
        }

        case 'sendData': {
          const cfg = this._serialManager.config;
          const hexSend = data.hexSend ?? false;
          const lineEnding = typeof data.lineEnding === 'string'
            ? data.lineEnding
            : cfg.lineEnding;
          await this._serialManager.send(data.text, hexSend, lineEnding);
          break;
        }

        case 'updateSettings': {
          const partial: Partial<SerialConfig> = {};
          if (data.showTimestamp !== undefined) { partial.showTimestamp = data.showTimestamp; }
          if (data.hexMode !== undefined) { partial.hexMode = data.hexMode; }
          if (data.lineEnding !== undefined) { partial.lineEnding = data.lineEnding; }
          if (data.encoding !== undefined) { partial.encoding = data.encoding === 'gbk' ? 'gbk' : 'utf8'; }
          if (data.rxIdleWrapMs !== undefined) {
            partial.rxIdleWrapMs = Math.max(1, Math.min(60000, Math.floor(Number(data.rxIdleWrapMs) || 20)));
          }
          if (data.flowControl !== undefined) { partial.flowControl = this._normalizeFlowControl(data.flowControl); }
          this._serialManager.updateSettings(partial);
          this._saveConfig(partial);
          break;
        }

        case 'saveSendHistory': {
          this._saveSendHistory(data.history ?? []);
          break;
        }

        case 'saveSerialProfiles': {
          this._saveSerialProfiles(data.profiles ?? []);
          break;
        }

        case 'saveQuickCommands': {
          this._saveQuickCommands(data.commands ?? []);
          break;
        }

        case 'saveConfig': {
          if (data.config) { this._saveConfig(data.config); }
          break;
        }

        case 'saveLogToFile': {
          await this._saveLogToFile(data.lines ?? []);
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

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'main.js'));
    const terminalDeviceLineUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'terminal-device-line.js'),
    );
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
<body>
  <div class="accordion-root">
  <section id="panel-monitor" class="accordion-panel accordion-panel--monitor is-expanded" data-panel="monitor">
    <header class="accordion-header accordion-header--static" aria-expanded="true">
      <span class="accordion-title">Serial Monitor</span>
    </header>
    <div id="accordion-body-monitor" class="accordion-body">
    <div class="monitor-panel-main">
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
        <label class="option-item" title="Periodically resend the current send box content">
          <input type="checkbox" id="opt-periodic-send" />
          <span>Cycle</span>
        </label>
        <input id="periodic-interval-input" class="periodic-interval-input" type="number" min="10" step="10" value="1000" title="Periodic interval in ms (min 10)" />
        <span class="periodic-unit">ms</span>
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

  <script nonce="${nonce}" src="${terminalDeviceLineUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}
