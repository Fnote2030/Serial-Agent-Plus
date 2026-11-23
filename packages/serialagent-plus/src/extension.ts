import * as vscode from 'vscode';
import { BridgeServer } from './bridge-server';
import { MonitorHost } from './monitor-host';
import { SerialPanelProvider } from './serial-panel-provider';

const bridgeOutputChannel = vscode.window.createOutputChannel('Serial Agent Plus Bridge');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const extensionPkgVersion: string = (require('../package.json') as { version: string }).version;

let monitorHost: MonitorHost;
let bridgeServer: BridgeServer;
let serialPanelProviderRef: SerialPanelProvider | undefined;
let statusBarItem: vscode.StatusBarItem;
let bridgeStatusBarItem: vscode.StatusBarItem;
let bridgeRunning = false;

async function waitForWebviewPanelToBeActive(panel: vscode.WebviewPanel): Promise<void> {
  if (panel.active) {
    return;
  }

  await new Promise<void>((resolve) => {
    const disposable = panel.onDidChangeViewState((event) => {
      if (!event.webviewPanel.active) {
        return;
      }
      disposable.dispose();
      resolve();
    });
  });
}

async function revealAndLockPanel(panel: vscode.WebviewPanel): Promise<void> {
  panel.reveal(undefined, false);
  await waitForWebviewPanelToBeActive(panel);
  await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
}

function updateBridgeStatusBar(): void {
  if (bridgeRunning) {
    bridgeStatusBarItem.text = '$(broadcast) SA Bridge Ready';
    bridgeStatusBarItem.tooltip = `Serial Agent Plus Bridge: Running on port ${bridgeServer.port} (click to stop)`;
    bridgeStatusBarItem.backgroundColor = undefined;
    bridgeStatusBarItem.color = new vscode.ThemeColor('testing.iconPassed');
  } else {
    bridgeStatusBarItem.text = '$(circle-slash) SA Bridge Off';
    bridgeStatusBarItem.tooltip = 'Serial Agent Plus Bridge: Stopped (click to start)';
    bridgeStatusBarItem.backgroundColor = undefined;
    bridgeStatusBarItem.color = undefined;
  }
}

/** 状态栏聚合：Serial 已连接数/总数（点击 Quick Pick 切换监视器，P2 完善） */
function updateStatusBarAggregate(): void {
  if (!monitorHost) { return; }
  const infos = monitorHost.list();
  const connected = infos.filter((m) => m.connected).length;
  statusBarItem.text = `$(plug) Serial ${connected}/${infos.length}`;
  statusBarItem.tooltip = 'Serial Agent Plus: monitors connected (click to focus panel)';
  statusBarItem.backgroundColor = undefined;
}

export function activate(context: vscode.ExtensionContext) {
  bridgeStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
  bridgeStatusBarItem.command = 'serialagent.toggleBridge';
  updateBridgeStatusBar();
  bridgeStatusBarItem.show();
  context.subscriptions.push(bridgeStatusBarItem);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'serialagent-plus.serialPanel.focus';
  updateStatusBarAggregate();
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  context.subscriptions.push(bridgeOutputChannel);

  monitorHost = MonitorHost.create(context, (event) => {
    serialPanelProviderRef?.handleHostEvent(event);
    if (event.type === 'metas' || event.type === 'status') {
      updateStatusBarAggregate();
    }
  });
  context.subscriptions.push(monitorHost);

  // P1/P2：bridge 绑定主监视器（列表第一个）；P3 将按监视器路由
  bridgeServer = new BridgeServer(monitorHost.primary().manager, bridgeOutputChannel, true, extensionPkgVersion);

  const provider = new SerialPanelProvider(context, monitorHost, () => { updateStatusBarAggregate(); });
  serialPanelProviderRef = provider;
  // 面板未打开时（如仅经 MCP bridge 连接）也保证日志缓冲上限来自工作区设置
  provider.handleLogBufferConfigChange();
  context.subscriptions.push(provider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SerialPanelProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  bridgeServer.setOnUiClear(() => {
    provider.postMessage({ type: 'clearLog' });
  });
  bridgeServer.start().then(() => {
    bridgeRunning = true;
    updateBridgeStatusBar();
    bridgeOutputChannel.appendLine(`[Serial Agent Plus Bridge] Token: ${bridgeServer.token}`);
  }).catch((err) => {
    bridgeRunning = false;
    updateBridgeStatusBar();
    bridgeOutputChannel.appendLine(`[Serial Agent Plus Bridge] Start failed: ${err}`);
    vscode.window.showWarningMessage('[Serial Agent Plus] Bridge Server failed to start. MCP integration unavailable.');
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('serialagent.addMonitor', () => {
      if (!monitorHost.registry.canCreate()) {
        vscode.window.showWarningMessage('[Serial Agent Plus] Monitor limit reached (10)');
        return;
      }
      monitorHost.createMonitor();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('serialagent.refreshPorts', async () => {
      await provider.refreshPortList({ forceFull: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('serialagent.toggleConnection', () => {
      const primary = monitorHost.primary().manager;
      if (primary.isConnected) {
        void vscode.commands.executeCommand('serialagent.disconnect');
      } else {
        void vscode.commands.executeCommand('serialagent-plus.serialPanel.focus');
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('serialagent.disconnect', async () => {
      await monitorHost.primary().manager.disconnect();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('serialagent.clearLog', () => {
      const rt = monitorHost.primary();
      rt.manager.clearLog();
      rt.manager.resetCounters();
      rt.session.resetEditing();
      serialPanelProviderRef?.postMessage({ type: 'clearLog', monitorId: rt.meta.id });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('serialagent.toggleBridge', async () => {
      if (bridgeRunning) {
        await bridgeServer.stop();
        bridgeRunning = false;
        updateBridgeStatusBar();
        bridgeOutputChannel.appendLine('[Serial Agent Plus Bridge] Stopped by user');
      } else {
        try {
          await bridgeServer.start();
          bridgeRunning = true;
          updateBridgeStatusBar();
          bridgeOutputChannel.appendLine(`[Serial Agent Plus Bridge] Restarted, Token: ${bridgeServer.token}`);
        } catch (err: unknown) {
          bridgeRunning = false;
          updateBridgeStatusBar();
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`[Serial Agent Plus] Bridge Server failed to start: ${msg}`);
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('serialagent.openInTab', async () => {
      if (provider.panel) {
        await revealAndLockPanel(provider.panel);
        return;
      }

      const lastVisibleColumn = Math.max(
        ...vscode.window.visibleTextEditors.map((editor) => editor.viewColumn || 0),
        0,
      );
      const hasVisibleEditors = vscode.window.visibleTextEditors.length > 0;

      if (!hasVisibleEditors) {
        await vscode.commands.executeCommand('workbench.action.newGroupRight');
      }

      const targetColumn = hasVisibleEditors
        ? Math.max(lastVisibleColumn + 1, 1)
        : vscode.ViewColumn.Two;

      const panel = vscode.window.createWebviewPanel(
        SerialPanelProvider.panelViewType,
        'Serial Agent Plus',
        targetColumn,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [context.extensionUri],
        },
      );

      panel.iconPath = {
        light: vscode.Uri.joinPath(context.extensionUri, 'media', 'SerialAgentPlus.png'),
        dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'SerialAgentPlus.png'),
      };

      provider.resolveWebviewPanel(panel);
      panel.onDidDispose(() => {
        provider.clearPanel();
      });
      await revealAndLockPanel(panel);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('serialagent.portAutoRefresh')
        || event.affectsConfiguration('serialagent.portRefreshIntervalMs')
        || event.affectsConfiguration('serialagent.portRefreshMetadataIntervalMs')
      ) {
        provider.handlePortRefreshConfigChange();
      }
      if (event.affectsConfiguration('serialagent.logBufferKB')) {
        provider.handleLogBufferConfigChange();
      }
    }),
  );
}

export async function deactivate(): Promise<void> {
  await bridgeServer?.stop();
  await monitorHost?.dispose();
}
