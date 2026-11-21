import * as vscode from 'vscode';
import { BridgeServer } from './bridge-server';
import { SerialPanelProvider } from './serial-panel-provider';
import { SerialManager } from './serial-manager';

const serialManager = new SerialManager();
const bridgeOutputChannel = vscode.window.createOutputChannel('Serial Agent Plus Bridge');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const extensionPkgVersion: string = (require('../package.json') as { version: string }).version;
const bridgeServer = new BridgeServer(serialManager, bridgeOutputChannel, true, extensionPkgVersion);

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

function updateStatusBar(connected: boolean, port?: string, baudRate?: number): void {
  if (connected && port) {
    statusBarItem.text = `$(plug) ${port} @ ${baudRate}`;
    statusBarItem.tooltip = 'Serial Agent Plus: Connected (click to disconnect)';
    statusBarItem.backgroundColor = undefined;
  } else if (serialManager.isReconnecting) {
    statusBarItem.text = '$(sync~spin) Reconnecting...';
    statusBarItem.tooltip = 'Serial Agent Plus: Attempting to reconnect';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    statusBarItem.text = '$(debug-disconnect) Serial';
    statusBarItem.tooltip = 'Serial Agent Plus: Disconnected (click to open panel)';
    statusBarItem.backgroundColor = undefined;
  }
}

export function activate(context: vscode.ExtensionContext) {
  bridgeStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
  bridgeStatusBarItem.command = 'serialagent.toggleBridge';
  updateBridgeStatusBar();
  bridgeStatusBarItem.show();
  context.subscriptions.push(bridgeStatusBarItem);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'serialagent.toggleConnection';
  updateStatusBar(false);
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  context.subscriptions.push(bridgeOutputChannel);

  const provider = new SerialPanelProvider(context, serialManager, updateStatusBar);
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
    vscode.commands.registerCommand('serialagent.refreshPorts', async () => {
      await provider.refreshPortList({ forceFull: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('serialagent.toggleConnection', () => {
      if (serialManager.isConnected) {
        void vscode.commands.executeCommand('serialagent.disconnect');
      } else {
        void vscode.commands.executeCommand('serialagent-plus.serialPanel.focus');
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('serialagent.disconnect', async () => {
      await serialManager.disconnect();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('serialagent.clearLog', () => {
      serialManager.clearLog();
      serialManager.resetCounters();
      provider.postMessage({ type: 'clearLog' });
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
    }),
  );
}

export async function deactivate(): Promise<void> {
  await bridgeServer.stop();
  await serialManager.disconnect();
}
