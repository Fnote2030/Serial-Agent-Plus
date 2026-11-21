import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: {
    joinPath: (...parts: Array<{ path?: string } | string>) => ({
      path: parts.map((part) => typeof part === 'string' ? part : (part.path ?? '')).join('/'),
    }),
    file: (path: string) => ({ fsPath: path, path }),
  },
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
  },
}));

import { SerialPanelProvider } from '../packages/serialagent-plus/src/serial-panel-provider';

function createProvider() {
  const context = {
    extensionUri: { path: '/extension-root' },
    globalState: {
      get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
      update: vi.fn(),
    },
  };

  return new SerialPanelProvider(context as any, {} as any, vi.fn());
}

function createWebview() {
  return {
    cspSource: 'vscode-resource:',
    asWebviewUri: (uri: { path?: string }) => `webview:${uri.path ?? ''}`,
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
    expect(html).toContain('>Serial Monitor<');
    expect(html).toContain('accordion-panel--monitor is-expanded');
    expect(html).toContain('accordion-header--static');
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
