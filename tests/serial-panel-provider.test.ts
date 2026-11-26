import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('vscode', () => {
  // 测试可写的配置存储：(vscode as any).__configStore.autoConnectOnStartup = true
  const configStore: Record<string, unknown> = {};
  return {
    __configStore: configStore,
    Uri: {
      joinPath: (...parts: Array<{ path?: string } | string>) => ({
        path: parts.map((part) => typeof part === 'string' ? part : (part.path ?? '')).join('/'),
      }),
      file: (path: string) => ({ fsPath: path, path }),
    },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
    window: {
      showSaveDialog: vi.fn(),
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showWarningMessage: vi.fn(),
    },
    workspace: {
      fs: {
        writeFile: vi.fn(),
      },
      getConfiguration: () => ({
        get: (key: string, defaultValue: unknown) => (
          key in configStore ? configStore[key] : defaultValue
        ),
      }),
    },
    env: {
      clipboard: {
        readText: vi.fn(async () => ''),
      },
    },
  };
});

import { SerialPanelProvider } from '../packages/serialagent-plus/src/serial-panel-provider';
import * as vscode from 'vscode';

function createProvider(hostOverrides: Record<string, unknown> = {}, stateOverrides: Record<string, unknown> = {}) {
  const workspaceData = new Map<string, unknown>(Object.entries(stateOverrides));
  const context = {
    extensionUri: { path: '/extension-root' },
    globalState: {
      get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
      update: vi.fn(),
    },
    workspaceState: {
      get: vi.fn((key: string, defaultValue: unknown) => (
        workspaceData.has(key) ? workspaceData.get(key) : defaultValue
      )),
      update: vi.fn((key: string, value: unknown) => { workspaceData.set(key, value); }),
    },
  };

  // 最小 MonitorHost 桩：HTML 渲染不触串口，仅需 primary().manager.listPorts 形状
  const managerStub = { listPorts: vi.fn(async () => []), config: { showTimestamp: false } };
  const hostStub = {
    primary: () => ({ manager: managerStub }),
    list: () => [],
    runtime: () => undefined,
    periodicState: () => ({ enabled: false, intervalMs: 1000 }),
    registry: {},
    ...hostOverrides,
  };

  return new SerialPanelProvider(context as any, hostStub as any, vi.fn());
}

function createWebview() {
  return {
    cspSource: 'vscode-resource:',
    asWebviewUri: (uri: { path?: string }) => `webview:${uri.path ?? ''}`,
  };
}

/** 可捕获 postMessage 与消息处理器的 webview 桩 */
function createInteractiveWebview() {
  const posted: Array<Record<string, any>> = [];
  const handlers: Array<(message: any) => unknown> = [];
  return {
    posted,
    handlers,
    cspSource: 'vscode-resource:',
    asWebviewUri: (uri: { path?: string }) => `webview:${uri.path ?? ''}`,
    postMessage: (message: Record<string, any>) => {
      posted.push(message);
      return Promise.resolve(true);
    },
    onDidReceiveMessage: (handler: (message: any) => unknown) => {
      handlers.push(handler);
      return { dispose: vi.fn() };
    },
  };
}

/** 最小 WebviewPanel 桩（标题/可见性与消息） */
function createPanelStub() {
  const posted: Array<Record<string, any>> = [];
  return {
    posted,
    title: '',
    visible: true,
    iconPath: undefined as unknown,
    webview: {
      cspSource: 'vscode-resource:',
      asWebviewUri: (uri: { path?: string }) => `webview:${uri.path ?? ''}`,
      postMessage: (message: Record<string, any>) => {
        posted.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: () => ({ dispose: vi.fn() }),
    },
    onDidChangeViewState: () => ({ dispose: vi.fn() }),
    onDidDispose: () => ({ dispose: vi.fn() }),
    reveal: vi.fn(),
    dispose: vi.fn(),
  };
}

function extractBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);

  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`Failed to extract section between "${start}" and "${end}"`);
  }

  return source.slice(startIndex + start.length, endIndex);
}

describe('SerialPanelProvider monitor layout', () => {
  it('renders a single always-expanded Serial Monitor panel without firmware or connection panels', () => {
    const provider = createProvider();
    const html = (provider as any)._getHtmlForWebview(createWebview());

    expect(html).toContain('class="accordion-root"');
    expect(html).toContain('data-panel="monitor"');
    expect(html).toContain('id="monitor-tabs"');
    expect(html).toContain('id="monitor-name-title"');
    expect(html).toContain('id="btn-add-monitor"');
    expect(html).toContain('id="btn-monitor-expand"');
    expect(html).toContain('accordion-panel--monitor is-expanded');
    expect(html).toContain('monitor-title-row');
    expect(html).not.toContain('accordion-header');
    expect(html).not.toContain('data-panel="firmware"');
    expect(html).not.toContain('data-panel="connection"');
    expect(html).not.toContain('Firmware Program Config');
    expect(html).not.toContain('COM Port Config');
    expect(html).not.toContain('accordion-chevron');
    expect(html).not.toContain('data-accordion');
    expect(html).not.toContain('firmware-config-drawer');
    expect(html).not.toContain('keil');
    expect(html).not.toContain('Keil');
    expect(html).toContain('font-src vscode-resource:');
    expect(html).toContain('codicon.css');
    expect(html).not.toContain('btn-focus-mode');
    expect(html).not.toContain('btn-log-focus-mode');
    expect(html).not.toContain('Logs Config');
    expect(html).not.toContain('class="status-bar"');
  });

  it('collapses serial config into a drawer toggled from the status bar', () => {
    const provider = createProvider();
    const html = (provider as any)._getHtmlForWebview(createWebview());

    expect(html).toContain('id="btn-config-toggle"');
    expect(html).toContain('id="serial-config-drawer"');
    expect(html).toContain('class="serial-config-drawer hidden"');
    expect(html.indexOf('id="btn-config-toggle"')).toBeLessThan(html.indexOf('id="serial-config-drawer"'));

    const configDrawer = extractBetween(html, 'id="serial-config-drawer"', 'class="log-toolbar"');
    expect(configDrawer).toContain('id="port-select"');
    expect(configDrawer).toContain('id="btn-refresh"');
    expect(configDrawer).toContain('id="baudrate-preset-select"');
    expect(configDrawer).toContain('id="baudrate-input"');
    expect(configDrawer).toContain('<option value="">Custom</option>');
    expect(configDrawer).toContain('<option value="4800">4800</option>');
    expect(configDrawer).toContain('<option value="9600">9600</option>');
    expect(configDrawer).toContain('<option value="115200" selected>115200</option>');
    expect(configDrawer).toContain('<option value="256000">256000</option>');
    expect(configDrawer).toContain('<option value="921600">921600</option>');
    expect(configDrawer).toContain('id="parity-select"');
    expect(configDrawer).toContain('id="flow-control-select"');
    expect(configDrawer).toContain('id="databits-select"');
    expect(configDrawer).toContain('id="stopbits-select"');
    expect(configDrawer).not.toContain('id="btn-connect"');
    expect(configDrawer).not.toContain('id="line-ending-select"');
    expect(configDrawer).not.toContain('baudrate-list');
    expect(html).not.toContain('datalist');
  });

  it('keeps log toolbar and options inside Serial Monitor without a separate logs config card', () => {
    const provider = createProvider();
    const html = (provider as any)._getHtmlForWebview(createWebview());
    const logToolbar = extractBetween(html, '<div class="log-toolbar">', '</div>\n\n    <div class="options-bar">');
    const optionsBar = extractBetween(html, '<div class="options-bar">', '\n\n  <div class="content-wrapper">');

    expect(logToolbar).toContain('btn-freeze');
    expect(logToolbar).toContain('btn-copy-log');
    expect(logToolbar).toContain('btn-save-log');
    expect(logToolbar).toContain('btn-clear');
    expect(logToolbar).toContain('clear-broom');
    expect(logToolbar).toContain('M14.854 1.146');
    expect(logToolbar).not.toContain('M10 12.6l.7.7');
    expect(logToolbar).not.toContain('opt-auto-scroll');

    expect(optionsBar).toContain('opt-timestamp');
    expect(optionsBar).toContain('opt-hex');
    expect(optionsBar).toContain('opt-echo');
    expect(optionsBar).toContain('opt-auto-scroll');
    expect(optionsBar).not.toContain('opt-terminal');
    expect(optionsBar).not.toContain('btn-log-focus-mode');
  });

  it('provides periodic send controls to the left of the send button, off by default and always editable', () => {
    const provider = createProvider();
    const html = (provider as any)._getHtmlForWebview(createWebview());
    const sendRow = extractBetween(html, '<div class="send-options-row">', '</div>\n      <div class="send-input-row">');

    expect(sendRow).toContain('id="opt-periodic-send"');
    expect(sendRow).toContain('id="periodic-interval-input"');
    expect(sendRow).toContain('value="1000"');
    expect(sendRow).toContain('min="10"');
    expect(sendRow).not.toContain('checked />\n          <span>Cycle</span>');
    expect(sendRow).not.toMatch(/periodic-interval-input[^>]*disabled/);
    expect(html.indexOf('id="opt-periodic-send"')).toBeLessThan(html.indexOf('id="btn-send"'));
    expect(html.indexOf('id="periodic-interval-input"')).toBeLessThan(html.indexOf('id="btn-send"'));
  });

  it('keeps the send input editable while disconnected', () => {
    const provider = createProvider();
    const html = (provider as any)._getHtmlForWebview(createWebview());

    expect(html).not.toMatch(/<textarea id="send-input"[^>]*disabled/);
  });

  it('enables terminal typing in the log panel without a mode toggle', () => {
    const provider = createProvider();
    const html = (provider as any)._getHtmlForWebview(createWebview());

    expect(html).not.toContain('id="opt-terminal"');
    expect(html).not.toContain('id="terminal-input-row"');
    expect(html).not.toContain('id="terminal-input"');
  });

  it('places line ending and hex send in the send options row', () => {
    const provider = createProvider();
    const html = (provider as any)._getHtmlForWebview(createWebview());
    const sendRow = extractBetween(html, '<div class="send-options-row">', '</div>\n      <div class="send-input-row">');

    expect(sendRow).toContain('id="line-ending-select"');
    expect(sendRow).toContain('id="opt-hex-send"');
    expect(sendRow).toContain('<span>Hex</span>');
    expect(sendRow).not.toContain('HEX Send');
  });

  it('uses a multiline textarea for quick command values', () => {
    const provider = createProvider();
    const html = (provider as any)._getHtmlForWebview(createWebview());

    expect(html).toContain('<textarea id="quick-command-value"');
    expect(html).not.toMatch(/<input[^>]*id="quick-command-value"/);
  });

  it('includes monitor status bar with open/close toggle and parity chip', () => {
    const provider = createProvider();
    const html = (provider as any)._getHtmlForWebview(createWebview());

    expect(html).toContain('class="monitor-status-bar"');
    expect(html).toContain('id="monitor-parity-chip"');
    expect(html).toContain('id="btn-monitor-connect"');
    expect(html).toContain('id="btn-config-toggle"');
    expect(html).not.toContain('id="btn-connect"');
    expect(html).toContain('id="btn-send"');
    expect(html).not.toMatch(/<button id="btn-send"[^>]*disabled/);
  });

  it('normalizes panel ui state to layout-only and strips legacy fields', () => {
    const provider = createProvider();
    const normalize = (provider as any)._normalizePanelUiState.bind(provider);

    expect(normalize({
      activePanel: 'firmware',
      firmwareDrawerOpen: true,
      firmwareDrawerRoute: 'build',
      firmwareDrawerStack: ['home', 'build'],
      normalSendHeight: 42,
    })).toEqual({ normalSendHeight: 42 });

    expect(normalize({ activePanel: 'connection' })).toEqual({ normalSendHeight: undefined });
    expect(normalize({ normalSendHeight: 7 })).toEqual({ normalSendHeight: 7 });
    expect(normalize({})).toEqual({ normalSendHeight: undefined });
  });
});

describe('SerialPanelProvider cross-view sync', () => {
  const monitorInfo = {
    id: 'm1',
    index: 1,
    name: 'Serial Monitor1',
    connected: false,
    port: '',
    baudRate: 115200,
    parity: 'none',
  };

  function createRuntime(overrides: Record<string, unknown> = {}) {
    return {
      meta: { id: 'm1', index: 1, name: 'Serial Monitor1', sendHistory: [] },
      manager: {
        config: { showTimestamp: false },
        updateSettings: vi.fn(),
        clearLog: vi.fn(),
        resetCounters: vi.fn(),
      },
      session: {
        snapshot: () => ({ liveLine: 'msh > ls', buffer: '', caret: 0, deviceLine: null }),
        resetEditing: vi.fn(),
        clearLive: vi.fn(),
      },
      ...overrides,
    };
  }

  it('replays buffered log lines and the terminal snapshot to a new view', async () => {
    const runtime = createRuntime({ manager: { config: { showTimestamp: true } } });
    const provider = createProvider({
      runtime: (id: string) => (id === 'm1' ? runtime : undefined),
    });
    provider.handleHostEvent({
      type: 'logLines',
      monitorId: 'm1',
      lines: ['boot ok'],
      kind: 'text',
    });

    const webview = createInteractiveWebview();
    (provider as any)._setupWebviewMessageHandler(webview);
    await webview.handlers[0]({ type: 'requestMonitorSnapshot', monitorId: 'm1' });

    const snapshot = webview.posted.find((message) => message.type === 'monitorSnapshot');
    expect(snapshot).toBeDefined();
    expect(snapshot!.monitorId).toBe('m1');
    expect(snapshot!.entries).toHaveLength(1);
    expect(snapshot!.entries[0].kind).toBe('text');
    expect(snapshot!.entries[0].text).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] boot ok$/);
    expect(snapshot!.terminal).toEqual({ liveLine: 'msh > ls', buffer: '', caret: 0, deviceLine: null });
  });

  it('drops the replay buffer when a monitor log is cleared', async () => {
    const runtime = createRuntime();
    const provider = createProvider({
      runtime: (id: string) => (id === 'm1' ? runtime : undefined),
    });
    provider.handleHostEvent({
      type: 'logLines',
      monitorId: 'm1',
      lines: ['boot ok'],
      kind: 'text',
    });
    provider.clearMonitorLog('m1');

    const webview = createInteractiveWebview();
    (provider as any)._setupWebviewMessageHandler(webview);
    await webview.handlers[0]({ type: 'requestMonitorSnapshot', monitorId: 'm1' });

    const snapshot = webview.posted.find((message) => message.type === 'monitorSnapshot');
    expect(snapshot!.entries).toEqual([]);
  });

  it('sends the host periodic state when a view is initialized', () => {
    const runtime = createRuntime();
    const provider = createProvider({
      list: () => [monitorInfo],
      runtime: (id: string) => (id === 'm1' ? runtime : undefined),
      periodicState: () => ({ enabled: true, intervalMs: 250 }),
    });

    const webview = createInteractiveWebview();
    (provider as any)._initializeView(webview, 'm1');

    expect(webview.posted).toContainEqual({
      type: 'periodicState',
      monitorId: 'm1',
      enabled: true,
      intervalMs: 250,
    });
  });

  it('re-sends the initial state when the webview reports it is ready', async () => {    // 首次 postMessage 可能早于 webview 脚本注册监听而丢失（标签栏/快捷指令空白）
    const runtime = createRuntime();
    const provider = createProvider({
      list: () => [monitorInfo],
      runtime: (id: string) => (id === 'm1' ? runtime : undefined),
    });

    const webview = createInteractiveWebview();
    (provider as any)._setupWebviewMessageHandler(webview, 'm1');
    expect(webview.posted).toHaveLength(0);

    await webview.handlers[0]({ type: 'ready' });

    const restore = webview.posted.find((message) => message.type === 'restoreState');
    expect(restore).toBeDefined();
    expect(restore!.monitors[0].id).toBe('m1');
    expect(webview.posted).toContainEqual({ type: 'activateMonitor', monitorId: 'm1' });
    expect(webview.posted.some((message) => message.type === 'periodicState')).toBe(true);
  });

  it('keeps editor panel titles on the index=name format and refreshes them after a rename', () => {
    const meta = { id: 'm1', index: 1, name: 'Serial Monitor1' };
    const provider = createProvider({
      list: () => [monitorInfo],
      runtime: (id: string) => (id === 'm1' ? createRuntime() : undefined),
      registry: { get: (id: string) => (id === 'm1' ? meta : undefined) },
    });

    const panel = createPanelStub();
    (provider as any).resolveWebviewPanel(panel, 'm1');
    expect(panel.title).toBe('1=Serial Monitor1');

    // 任一视口重命名成功 → metas 广播 → 所有视口重渲染，编辑器面板标题同步
    meta.name = 'UART A';
    provider.handleHostEvent({
      type: 'metas',
      monitors: [{
        id: 'm1',
        index: 1,
        name: 'UART A',
        connected: false,
        port: '',
        baudRate: 115200,
        parity: 'none',
      }],
    });

    expect(panel.title).toBe('1=UART A');
    const changed = panel.posted.find((message) => message.type === 'monitorsChanged');
    expect(changed!.monitors[0]).toMatchObject({ id: 'm1', index: 1, name: 'UART A' });
  });

  it('pastes the host clipboard into the terminal session on Ctrl+V', async () => {
    const handleKey = vi.fn();
    const runtime = createRuntime({ session: { snapshot: vi.fn(), handleKey } });
    const provider = createProvider({
      runtime: (id: string) => (id === 'm1' ? runtime : undefined),
    });
    vi.mocked(vscode.env.clipboard.readText).mockResolvedValue('list_device\n');

    const webview = createInteractiveWebview();
    (provider as any)._setupWebviewMessageHandler(webview);
    await webview.handlers[0]({ type: 'pasteToTerminal', monitorId: 'm1' });

    expect(handleKey).toHaveBeenCalledWith({ type: 'paste', text: 'list_device\n' });
  });

  it('clears the un-terminated RX live line when the log is cleared', () => {
    const clearLive = vi.fn();
    const resetEditing = vi.fn();
    const clearLog = vi.fn();
    const resetCounters = vi.fn();
    const runtime = createRuntime({
      manager: { config: { showTimestamp: false }, updateSettings: vi.fn(), clearLog, resetCounters },
      session: { snapshot: vi.fn(), clearLive, resetEditing },
    });
    const provider = createProvider({
      runtime: (id: string) => (id === 'm1' ? runtime : undefined),
    });

    provider.clearMonitorLog('m1');

    // 文本模式收到的 HEX 数据没有换行，停留在终端实时行，清屏必须一并清掉
    expect(clearLog).toHaveBeenCalled();
    expect(resetCounters).toHaveBeenCalled();
    expect(resetEditing).toHaveBeenCalled();
    expect(clearLive).toHaveBeenCalled();
  });

  it('restores editor panels that were open before the reload', () => {
    const runtime = createRuntime();
    const created: Array<{ viewType: string; title: string; showOptions: unknown }> = [];
    const originalCreate = (vscode.window as any).createWebviewPanel;
    (vscode.window as any).createWebviewPanel = vi.fn((viewType: string, title: string, showOptions: unknown) => {
      created.push({ viewType, title, showOptions });
      const panel = createPanelStub();
      panel.webview.onDidReceiveMessage = () => ({ dispose: vi.fn() });
      return panel;
    });
    (vscode.window as any).tabGroups = { all: [{}, {}] };

    try {
      const provider = createProvider(
        {
          list: () => [monitorInfo],
          runtime: (id: string) => (id === 'm1' ? runtime : undefined),
          registry: { get: (id: string) => (id === 'm1' ? { id: 'm1', index: 1, name: 'Serial Monitor1' } : undefined) },
        },
        { openEditorMonitors: [{ id: 'm1', viewColumn: 2 }, { id: 'gone', viewColumn: 1 }] },
      );

      (provider as any).restoreEditorPanels();

      expect(created).toHaveLength(1);
      expect(created[0].title).toBe('1=Serial Monitor1');
      expect(created[0].showOptions).toMatchObject({ viewColumn: 2, preserveFocus: true });
    } finally {
      (vscode.window as any).createWebviewPanel = originalCreate;
      delete (vscode.window as any).tabGroups;
    }
  });
});

describe('SerialPanelProvider saved serial config restore', () => {
  const configStore = (vscode as any).__configStore as Record<string, unknown>;

  afterEach(() => {
    for (const key of Object.keys(configStore)) { delete configStore[key]; }
  });

  function createRestoreProvider(options: {
    ports: Array<{ path: string }>;
    monitors: Array<{ info: Record<string, unknown>; runtime: Record<string, any> }>;
    config?: Record<string, unknown>;
  }) {
    const updateMonitorConfig = vi.fn();
    const connect = vi.fn(async () => ({ ok: true }));
    Object.assign(configStore, options.config ?? {});
    const provider = createProvider({
      primary: () => ({ manager: { listPorts: vi.fn(async () => options.ports) } }),
      list: () => options.monitors.map((item) => item.info),
      runtime: (id: string) => options.monitors.find((item) => item.info.id === id)?.runtime,
      updateMonitorConfig,
      connect,
      registry: {},
    });
    return { provider, updateMonitorConfig, connect };
  }

  function makeMonitor(id: string, savedPort: string, connected = false) {
    return {
      info: {
        id, index: Number(id.slice(1)), name: `Serial Monitor${id.slice(1)}`,
        connected, port: savedPort, baudRate: 115200, parity: 'none',
      },
      runtime: {
        meta: { id, index: Number(id.slice(1)), name: `Serial Monitor${id.slice(1)}`, sendHistory: [] },
        manager: {
          config: { port: savedPort, baudRate: 115200, lineEnding: 'none', showTimestamp: false, hexMode: false, encoding: 'utf8', rxIdleWrapMs: 20, logBufferKB: 1024 },
          isConnected: connected,
          injectLog: vi.fn(),
          updateSettings: vi.fn(),
        },
        session: { snapshot: vi.fn(), resetEditing: vi.fn(), clearLive: vi.fn() },
      },
    };
  }

  it('clears a saved port whose device is gone and keeps an available one', async () => {
    const alive = makeMonitor('m1', 'COM5');
    const gone = makeMonitor('m2', 'COM9');
    const { provider, updateMonitorConfig } = createRestoreProvider({
      ports: [{ path: 'COM5' }, { path: 'COM3' }],
      monitors: [alive, gone],
    });

    await provider.validateSavedPorts();

    // 只清端口，波特率等偏好保留（换设备通常仍然适用）
    expect(updateMonitorConfig).toHaveBeenCalledTimes(1);
    expect(updateMonitorConfig).toHaveBeenCalledWith('m2', { port: '' });
    expect(gone.runtime.manager.injectLog).toHaveBeenCalledWith(
      expect.stringContaining('COM9 is no longer available'),
    );
    expect(alive.runtime.manager.injectLog).not.toHaveBeenCalled();
  });

  it('does not touch a connected monitor even if its port is missing from the list', async () => {
    const connected = makeMonitor('m1', 'COM7', true);
    const { provider, updateMonitorConfig } = createRestoreProvider({
      ports: [{ path: 'COM3' }],
      monitors: [connected],
    });

    await provider.validateSavedPorts();

    expect(updateMonitorConfig).not.toHaveBeenCalled();
  });

  it('keeps saved configs when the port scan fails (no false reset)', async () => {
    const monitor = makeMonitor('m1', 'COM9');
    const { provider, updateMonitorConfig } = createRestoreProvider({
      ports: [],
      monitors: [monitor],
    });
    // 扫描失败用 rejected Promise 模拟
    (provider as any)._listAvailablePorts = async () => null;

    await provider.validateSavedPorts();

    expect(updateMonitorConfig).not.toHaveBeenCalled();
  });

  it('validates saved ports only once per session (mid-session unplug keeps the config)', async () => {
    const monitor = makeMonitor('m1', 'COM9');
    const { provider, updateMonitorConfig } = createRestoreProvider({
      ports: [{ path: 'COM5' }],
      monitors: [monitor],
    });

    await provider.validateSavedPorts();
    await provider.validateSavedPorts();

    expect(updateMonitorConfig).toHaveBeenCalledTimes(1);
  });

  it('does not auto-connect when the setting is off (default)', async () => {
    const monitor = makeMonitor('m1', 'COM5');
    const { provider, connect } = createRestoreProvider({
      ports: [{ path: 'COM5' }],
      monitors: [monitor],
    });

    await provider.autoConnectOnStartup();

    expect(connect).not.toHaveBeenCalled();
  });

  it('auto-connects only monitors whose saved port still exists when enabled', async () => {
    const alive = makeMonitor('m1', 'COM5');
    const gone = makeMonitor('m2', 'COM9');
    const { provider, connect } = createRestoreProvider({
      ports: [{ path: 'COM5' }],
      monitors: [alive, gone],
      config: { autoConnectOnStartup: true },
    });

    await provider.autoConnectOnStartup();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0][0]).toBe('m1');
    expect((connect.mock.calls[0][1] as { port: string }).port).toBe('COM5');
  });

  it('skips monitors that are already connected', async () => {
    const connected = makeMonitor('m1', 'COM5', true);
    const { provider, connect } = createRestoreProvider({
      ports: [{ path: 'COM5' }],
      monitors: [connected],
      config: { autoConnectOnStartup: true },
    });

    await provider.autoConnectOnStartup();

    expect(connect).not.toHaveBeenCalled();
  });

  it('scans the port list only once when validating and auto-connecting at startup', async () => {
    const monitor = makeMonitor('m1', 'COM5');
    const listPorts = vi.fn(async () => [{ path: 'COM5' }]);
    Object.assign(configStore, { autoConnectOnStartup: true });
    const connect = vi.fn(async () => ({ ok: true }));
    const provider = createProvider({
      primary: () => ({ manager: { listPorts } }),
      list: () => [monitor.info],
      runtime: (id: string) => (id === 'm1' ? monitor.runtime : undefined),
      updateMonitorConfig: vi.fn(),
      connect,
      registry: {},
    });

    await provider.restoreSavedConnections();

    // Windows 全量扫描要起 PowerShell：校验与自动连接必须共用同一次扫描结果
    expect(listPorts).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});

describe('SerialPanelProvider log export', () => {
  function createExportProvider(monitorName: string) {
    const runtime = {
      meta: { id: 'm1', index: 1, name: monitorName, sendHistory: [] },
      manager: {
        config: {
          port: 'COM3',
          baudRate: 115200,
          dataBits: 8,
          parity: 'none',
          stopBits: 1,
          flowControl: 'none',
          encoding: 'utf8',
          showTimestamp: false,
          hexMode: false,
          lineEnding: 'none',
          rxIdleWrapMs: 20,
          logBufferKB: 1024,
        },
        isConnected: true,
        currentPath: 'COM7',
        currentBaudRate: 921600,
        rxBytes: 2048,
        txBytes: 12,
        updateSettings: vi.fn(),
      },
      session: { snapshot: () => ({ liveLine: '', buffer: '', caret: 0, deviceLine: null }) },
    };
    const provider = createProvider({
      runtime: (id: string) => (id === 'm1' ? runtime : undefined),
      registry: {
        get: (id: string) => (id === 'm1'
          ? { id: 'm1', index: 1, name: monitorName, config: runtime.manager.config }
          : undefined),
      },
    });
    return provider;
  }

  beforeEach(() => {
    vi.mocked(vscode.window.showSaveDialog).mockReset();
    vi.mocked(vscode.workspace.fs.writeFile).mockReset();
  });

  it('defaults the file name to serial-agent-plus-<monitor>-<timestamp>.log', async () => {
    const provider = createExportProvider('UART A/B');
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue({ fsPath: '/tmp/out.log' } as any);

    await (provider as any)._saveLogToFile('m1', []);

    const options = vi.mocked(vscode.window.showSaveDialog).mock.calls[0][0]!;
    const defaultPath = String((options.defaultUri as { path?: string }).path);
    expect(defaultPath).toMatch(/serial-agent-plus-UART-A-B-\d{14}\.log$/);
  });

  it('writes the serial port header before the log data', async () => {
    const provider = createExportProvider('Serial Monitor1');
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue({ fsPath: '/tmp/out.log' } as any);

    await (provider as any)._saveLogToFile('m1', ['[1] boot', '[2] ok']);

    const written = vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1] as Buffer;
    const text = written.toString('utf8');
    const headerEnd = text.indexOf('# ===== log data =====');
    expect(headerEnd).toBeGreaterThan(-1);

    const header = text.slice(0, headerEnd);
    expect(header).toContain('# ===== Serial Agent Plus log =====');
    expect(header).toMatch(/^# Monitor\s+: 1=Serial Monitor1$/m);
    expect(header).toMatch(/^# Connection\s+: Connected$/m);
    expect(header).toMatch(/^# Port\s+: COM7$/m);
    expect(header).toMatch(/^# Baud Rate\s+: 921600$/m);
    expect(header).toMatch(/^# Frame\s+: 8-none-1$/m);
    expect(header).toMatch(/^# Encoding\s+: UTF-8$/m);
    expect(header).toMatch(/^# RX \/ TX\s+: 2\.0 KB \/ 12 B$/m);
    expect(header).toMatch(/^# Log Lines\s+: 2$/m);

    expect(text.slice(headerEnd)).toContain('[1] boot\n[2] ok');
  });

  it('reports the configured port and Disconnected state when the monitor is offline', async () => {
    const runtime = {
      meta: { id: 'm1', index: 1, name: 'Serial Monitor1', sendHistory: [] },
      manager: {
        config: {
          port: 'COM3',
          baudRate: 115200,
          dataBits: 8,
          parity: 'none',
          stopBits: 1,
          flowControl: 'none',
          encoding: 'gbk',
          showTimestamp: false,
          hexMode: false,
          lineEnding: 'none',
          rxIdleWrapMs: 20,
          logBufferKB: 1024,
        },
        isConnected: false,
        currentPath: '',
        currentBaudRate: 0,
        rxBytes: 0,
        txBytes: 0,
        updateSettings: vi.fn(),
      },
      session: { snapshot: () => ({ liveLine: '', buffer: '', caret: 0, deviceLine: null }) },
    };
    const provider = createProvider({
      runtime: (id: string) => (id === 'm1' ? runtime : undefined),
      registry: { get: () => ({ id: 'm1', index: 1, name: 'Serial Monitor1', config: runtime.manager.config }) },
    });
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue({ fsPath: '/tmp/out.log' } as any);

    await (provider as any)._saveLogToFile('m1', []);

    const text = (vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1] as Buffer).toString('utf8');
    expect(text).toMatch(/^# Connection\s+: Disconnected$/m);
    expect(text).toMatch(/^# Port\s+: COM3$/m);
    expect(text).toMatch(/^# Baud Rate\s+: 115200$/m);
    expect(text).toMatch(/^# Encoding\s+: GBK$/m);
  });
});
