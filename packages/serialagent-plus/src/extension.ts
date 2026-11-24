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

/** 上下文键 serialagent.monitorN：控制编辑器标题下拉里"Monitor N"项按已分配序号显示 */
function syncMonitorContextKeys(): void {
  const used = new Set(monitorHost.list().map((m) => m.index));
  for (let i = 1; i <= 10; i++) {
    void vscode.commands.executeCommand('setContext', `serialagent.monitor${i}`, used.has(i));
  }
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
    if (event.type === 'metas') {
      syncMonitorContextKeys();
    }
  });
  context.subscriptions.push(monitorHost);
  syncMonitorContextKeys();

  // P3：bridge 按监视器路由（MonitorHost 实现 BridgeHost 接口）
  bridgeServer = new BridgeServer(monitorHost, bridgeOutputChannel, true, extensionPkgVersion);

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

  bridgeServer.setOnUiClear((monitorId) => {
    provider.clearMonitorLog(monitorId);
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
      serialPanelProviderRef?.clearMonitorLog(rt.meta.id);
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
      // 下拉菜单末尾项：Quick Pick 提供名称/连接状态等更详细的信息后打开到编辑器区
      const infos = monitorHost.list();
      const items = infos.map((info) => ({
        label: `$(${info.connected ? 'plug' : 'debug-disconnect'}) ${info.index}=${info.name}`,
        description: info.connected ? `Connected · ${info.port} @ ${info.baudRate}` : 'Disconnected',
        id: info.id,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Serial Monitors',
        matchOnDescription: true,
      });
      if (picked) {
        provider.openMonitorInEditor(picked.id);
      }
    }),
  );

  // 编辑器选项卡栏下拉"Monitor N"项：按序号展开对应监视器（可见性由 serialagent.monitorN 上下文键控制）
  for (let index = 1; index <= 10; index++) {
    const idx = index;
    context.subscriptions.push(
      vscode.commands.registerCommand(`serialagent.openMonitor${idx}`, () => {
        const info = monitorHost.list().find((m) => m.index === idx);
        if (info) {
          provider.openMonitorInEditor(info.id);
        } else {
          vscode.window.showWarningMessage(`[Serial Agent Plus] Monitor ${idx} does not exist`);
        }
      }),
    );
  }

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
