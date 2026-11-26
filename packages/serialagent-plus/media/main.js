// @ts-check

/**
 * Serial Agent Plus 侧边栏 Webview 脚本
 *
 * P0 目标：
 * - 日志工具条：搜索、冻结、自动滚动、复制、保存
 * - 常用发送区：命令预设的一键发送和管理
 * - 连接配置预设：保存和快速切换常用串口配置
 * - 空状态引导：未连接时给出下一步提示
 */

(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  const MAX_HISTORY = 20;
  // 显示缓冲上限按 UTF-8 总字节数限制，大小来自后台配置项 serialagent-plus.logBufferKB
  // （默认 1024=1MB，最大 10240=10MB），由扩展侧推送（restoreConfig / updateLogBuffer）
  let logBufferKB = 1024;
  const utf8Encoder = new TextEncoder();
  const utf8ByteLength = (text) => utf8Encoder.encode(text).length;

  function logRenderBytesLimit() {
    return Math.max(1, Math.min(10240, logBufferKB)) * 1024;
  }
  const DEFAULT_NORMAL_SEND_HEIGHT = 38;

  /**
   * @typedef {{ text: string; kind: 'text' | 'echo' }} LogEntry
   */

  /**
   * @typedef {{ id: string; label: string; value: string; hexSend?: boolean }} QuickCommand
   */

  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const monitorPortChip = document.getElementById('monitor-port-chip');
  const monitorBaudChip = document.getElementById('monitor-baud-chip');
  const monitorParityChip = document.getElementById('monitor-parity-chip');

  const PARITY_LABELS = { none: 'None', even: 'Even', odd: 'Odd', mark: 'Mark', space: 'Space' };
  const rxCountEl = document.getElementById('rx-count');
  const txCountEl = document.getElementById('tx-count');
  const monitorConnectBtn = document.getElementById('btn-monitor-connect');
  const accordionHeaders = Array.from(document.querySelectorAll('.accordion-header'));
  const accordionPanels = Array.from(document.querySelectorAll('.accordion-panel'));

  /** @type {HTMLSelectElement | null} */
  const portSelect = /** @type {HTMLSelectElement} */ (document.getElementById('port-select'));
  /** @type {HTMLInputElement | null} */
  const baudrateInput = /** @type {HTMLInputElement} */ (document.getElementById('baudrate-input'));
  /** @type {HTMLSelectElement | null} */
  const baudratePresetSelect = /** @type {HTMLSelectElement} */ (document.getElementById('baudrate-preset-select'));
  /** @type {HTMLSelectElement | null} */
  const databitsSelect = /** @type {HTMLSelectElement} */ (document.getElementById('databits-select'));
  /** @type {HTMLSelectElement | null} */
  const paritySelect = /** @type {HTMLSelectElement} */ (document.getElementById('parity-select'));
  /** @type {HTMLSelectElement | null} */
  const stopbitsSelect = /** @type {HTMLSelectElement} */ (document.getElementById('stopbits-select'));
  /** @type {HTMLSelectElement | null} */
  const flowControlSelect = /** @type {HTMLSelectElement} */ (document.getElementById('flow-control-select'));
  /** @type {HTMLSelectElement | null} */
  const lineEndingSelect = /** @type {HTMLSelectElement} */ (document.getElementById('line-ending-select'));
  /** @type {HTMLSelectElement | null} */
  const encodingSelect = /** @type {HTMLSelectElement} */ (document.getElementById('encoding-select'));
  const rxIdleWrapInput = /** @type {HTMLInputElement} */ (document.getElementById('rx-idle-wrap-input'));

  const refreshBtn = document.getElementById('btn-refresh');
  const clearBtn = document.getElementById('btn-clear');
  const configDrawer = document.getElementById('serial-config-drawer');
  const configToggleBtn = document.getElementById('btn-config-toggle');
  const optPeriodicSend = document.getElementById('opt-periodic-send');
  const periodicIntervalInput = document.getElementById('periodic-interval-input');

  /** @type {HTMLInputElement | null} */
  const optTimestamp = /** @type {HTMLInputElement} */ (document.getElementById('opt-timestamp'));
  /** @type {HTMLInputElement | null} */
  const optHex = /** @type {HTMLInputElement} */ (document.getElementById('opt-hex'));
  /** @type {HTMLInputElement | null} */
  const optHexSend = /** @type {HTMLInputElement} */ (document.getElementById('opt-hex-send'));
  /** @type {HTMLInputElement | null} */
  const optEcho = /** @type {HTMLInputElement} */ (document.getElementById('opt-echo'));
  /** @type {HTMLInputElement | null} */
  const optAutoScroll = /** @type {HTMLInputElement} */ (document.getElementById('opt-auto-scroll'));

  const logArea = document.getElementById('log-area');
  const logEmptyState = document.getElementById('log-empty-state');
  /** @type {HTMLInputElement | null} */
  const logSearchInput = /** @type {HTMLInputElement} */ (document.getElementById('log-search'));
  const freezeBtn = document.getElementById('btn-freeze');
  const copyLogBtn = document.getElementById('btn-copy-log');
  const saveLogBtn = document.getElementById('btn-save-log');

  /** @type {HTMLTextAreaElement | null} */
  const sendInput = /** @type {HTMLTextAreaElement} */ (document.getElementById('send-input'));
  /** @type {HTMLButtonElement | null} */
  const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById('btn-send'));
  const historyDropdown = document.getElementById('history-dropdown');
  const historyToggle = document.getElementById('history-toggle');
  const historyMenu = document.getElementById('history-menu');
  const resizeHandle = document.getElementById('resize-handle');
  const sendSection = document.getElementById('send-section');
  const contentWrapper = document.querySelector('.content-wrapper');

  const quickCommandBar = document.querySelector('.quick-command-bar');
  const quickCommandList = document.getElementById('quick-command-list');
  const quickCommandManageList = document.getElementById('quick-command-manage-list');
  /** @type {HTMLInputElement | null} */
  const quickCommandLabelInput = /** @type {HTMLInputElement} */ (document.getElementById('quick-command-label'));
  /** @type {HTMLInputElement | null} */
  const quickCommandValueInput = /** @type {HTMLTextAreaElement} */ (document.getElementById('quick-command-value'));
  /** @type {HTMLInputElement | null} */
  const quickCommandHexInput = /** @type {HTMLInputElement} */ (document.getElementById('quick-command-hex'));
  const quickCommandSaveBtn = document.getElementById('btn-quick-command-save');
  const quickCommandResetBtn = document.getElementById('btn-quick-command-reset');

  const monitorTabs = document.getElementById('monitor-tabs');
  const monitorTabsSlider = document.getElementById('monitor-tabs-slider');
  const monitorTabsThumb = monitorTabsSlider?.querySelector('.monitor-tabs-slider-thumb') ?? null;
  const monitorAddBtn = document.getElementById('btn-add-monitor');
  const monitorExpandBtn = document.getElementById('btn-monitor-expand');
  const monitorNameTitle = document.getElementById('monitor-name-title');

  let quickCommands = /** @type {QuickCommand[]} */ ([]);
  let editingQuickCommandId = '';
  let frozenLog = false;
  let activeLogFilter = '';
  let normalSendHeight;
  /** 标题行重命名进行中：renderMonitors 不覆盖正在编辑的输入框 */
  let titleRenameActive = false;
  /** 最近一次 Ctrl/Cmd+V 按键时间：同一次按键还会触发 DOM paste 事件，需去重 */
  let lastPasteKeyAt = 0;
  /** 最近一次已应用的 DOM paste 时间：少数平台先派发 paste 再派发 keydown，反向去重 */
  let lastPasteEventAt = 0;
  /** 连接成功时是否自动收起 Config 抽屉（后台设置，默认关闭） */
  let collapseConfigOnConnect = false;

  // ---- 多监视器状态：列表 + 按监视器分桶 ----
  /** @type {{ id: string; index: number; name: string; connected: boolean; port: string; baudRate: number; parity: string }[]} */
  let monitors = [];
  let activeMonitorId = '';
  let pendingPort = ''; // updatePorts 到达前保留的目标端口（如恢复的配置）

  /**
   * @typedef {{ logEntries: LogEntry[]; logEntriesBytes: number; sendHistory: string[];
   *             sendDraft: string; connected: boolean; pendingSendAfterConnect: boolean;
   *             rxCount: number; txCount: number; statusText: string; statusConnected: boolean;
   *             statusPort: string; statusBaud: number; statusParity: string;
   *             periodic: { enabled: boolean; intervalMs: number };
   *             snapshotRequested: boolean;
   *             terminal: { liveLine: string; buffer: string; caret: number; deviceLine: string | null } }} MonitorBucket
   */
  /** @type {Object<string, MonitorBucket>} */
  const buckets = /** @type {Record<string, MonitorBucket>} */ ({});

  function defaultBucket() {
    return {
      logEntries: [],
      logEntriesBytes: 0,
      sendHistory: [],
      sendDraft: '',
      config: null,
      ui: null,
      connected: false,
      pendingSendAfterConnect: false,
      rxCount: 0,
      txCount: 0,
      statusText: '',
      statusConnected: false,
      statusPort: '',
      statusBaud: 0,
      statusParity: 'none',
      periodic: { enabled: false, intervalMs: 1000 },
      snapshotRequested: false,
      terminal: { liveLine: '', buffer: '', caret: 0, deviceLine: null },
    };
  }

  function bucketFor(id) {
    if (!buckets[id]) { buckets[id] = defaultBucket(); }
    return buckets[id];
  }

  function activeBucket() {
    return bucketFor(activeMonitorId);
  }

  function activeMeta() {
    return monitors.find((m) => m.id === activeMonitorId) || null;
  }

  /** 向当前监视器的扩展侧终端会话发送按键意图 */
  function sendKeyIntent(intent) {
    vscode.postMessage({ type: 'terminalKey', monitorId: activeMonitorId, intent });
  }

  restoreWebviewState();

  // 编辑器面板视图（body.panel-view）：隐藏标签栏、不跟随新建切换（见 applyMonitors）
  window.__isPanelView = document.body.classList.contains('panel-view');

  bindSerialActions();
  bindLogActions();
  bindSendActions();
  bindQuickCommandActions();
  bindResizeActions();

  function restoreWebviewState() {
    const previousState = vscode.getState();
    if (!previousState) {
      return;
    }

    if (sendInput && previousState.sendText) {
      sendInput.value = previousState.sendText;
    }
    if (optHexSend && previousState.hexSend) {
      optHexSend.checked = true;
    }
    if (optAutoScroll && previousState.autoScroll !== undefined) {
      optAutoScroll.checked = !!previousState.autoScroll;
    }
    if (logSearchInput && previousState.logFilter) {
      logSearchInput.value = previousState.logFilter;
      activeLogFilter = previousState.logFilter.toLowerCase();
    }
    if (previousState.frozenLog) {
      frozenLog = true;
      updateFreezeButton();
    }
    // 抽屉展开状态随 webview 状态持久化：重载/重新挂载后保持用户的选择
    if (previousState.configDrawerOpen) {
      setConfigDrawerOpen(true);
    }
    updateSendPlaceholder();
  }

  function saveState() {
    vscode.setState({
      sendText: sendInput?.value || '',
      hexSend: optHexSend?.checked || false,
      autoScroll: optAutoScroll?.checked || false,
      logFilter: logSearchInput?.value || '',
      frozenLog,
      configDrawerOpen: !!configDrawer && !configDrawer.classList.contains('hidden'),
    });
  }

  function bindSerialActions() {
    refreshBtn?.addEventListener('click', () => {
      vscode.postMessage({ type: 'refreshPorts' });
    });

    monitorConnectBtn?.addEventListener('click', handleConnectionToggle);

    configToggleBtn?.addEventListener('click', () => {
      const collapsed = configDrawer?.classList.contains('hidden') ?? false;
      setConfigDrawerOpen(collapsed);
      saveState();
    });

    logArea?.addEventListener('keydown', (event) => {
      const key = event.key;
      if (event.ctrlKey && !event.altKey && !event.metaKey && (key === 'c' || key === 'C')) {
        // 有选中文本时放行系统复制，仅在无选中时向设备发送 ^C 中断
        const selection = document.getSelection();
        if (selection && !selection.isCollapsed) {
          return;
        }
        event.preventDefault();
        sendKeyIntent({ type: 'ctrlC' });
        return;
      }

      if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'v' || key === 'V')) {
        // 粘贴到终端输入行：扩展侧读取剪贴板，多行内容按行提交
        event.preventDefault();
        if (event.repeat) { return; } // 长按 Ctrl+V 不重复粘贴
        const now = Date.now();
        if (now - lastPasteEventAt < 300) { return; } // 已由 DOM paste 处理，避免粘贴两次
        lastPasteKeyAt = now;
        vscode.postMessage({ type: 'pasteToTerminal', monitorId: activeMonitorId });
        return;
      }

      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      // 终端行编辑状态在扩展侧（TerminalSession），这里只发送按键意图
      if (key === 'Enter') {
        event.preventDefault();
        sendKeyIntent({ type: 'enter' });
        return;
      }

      if (key === 'Tab') {
        event.preventDefault();
        sendKeyIntent({ type: 'tab' });
        return;
      }

      if (key === 'Backspace') {
        event.preventDefault();
        sendKeyIntent({ type: 'backspace' });
        return;
      }

      if (key === 'Delete') {
        event.preventDefault();
        sendKeyIntent({ type: 'delete' });
        return;
      }

      if (key === 'ArrowLeft') {
        event.preventDefault();
        sendKeyIntent({ type: 'move', delta: -1 });
        return;
      }

      if (key === 'ArrowRight') {
        event.preventDefault();
        sendKeyIntent({ type: 'move', delta: 1 });
        return;
      }

      if (key === 'Home') {
        event.preventDefault();
        sendKeyIntent({ type: 'moveTo', position: 'start' });
        return;
      }

      if (key === 'End') {
        event.preventDefault();
        sendKeyIntent({ type: 'moveTo', position: 'end' });
        return;
      }

      if (key === 'ArrowUp' || key === 'ArrowDown') {
        // 历史切换由设备 shell 接管（redraw 同步在扩展侧完成）
        event.preventDefault();
        sendKeyIntent({ type: 'history', direction: key === 'ArrowUp' ? 'up' : 'down' });
        return;
      }

      if (key === 'Escape') {
        event.preventDefault();
        sendKeyIntent({ type: 'escape' });
        return;
      }

      if (key === 'PageUp') {
        event.preventDefault();
        sendKeyIntent({ type: 'passthrough', bytes: '\x1b[5~' });
        return;
      }

      if (key === 'PageDown') {
        event.preventDefault();
        sendKeyIntent({ type: 'passthrough', bytes: '\x1b[6~' });
        return;
      }

      if (key.length === 1) {
        event.preventDefault();
        sendKeyIntent({ type: 'print', ch: key });
        return;
      }
    });

    logArea?.addEventListener('click', () => {
      if (logArea instanceof HTMLElement) {
        logArea.focus();
      }
    });

    // 鼠标/菜单粘贴：键盘 Ctrl+V 已由 keydown 交给宿主剪贴板处理，
    // 同一次按键紧随其后的 DOM paste 事件必须忽略，否则会粘贴两次
    logArea?.addEventListener('paste', (event) => {
      const text = event.clipboardData?.getData('text/plain') ?? '';
      event.preventDefault();
      if (!text || Date.now() - lastPasteKeyAt < 300) { return; }
      lastPasteEventAt = Date.now();
      sendKeyIntent({ type: 'paste', text });
    });

    // 串口配置页下拉框：悬停自动聚焦，聚焦后不展开也能用滚轮切换选项
    function bindHoverWheelSelect(select) {
      if (!select) { return; }
      select.addEventListener('mouseenter', () => {
        select.focus({ preventScroll: true });
      });
      select.addEventListener('wheel', (event) => {
        if (document.activeElement !== select) { return; }
        event.preventDefault();
        const delta = event.deltaY > 0 ? 1 : (event.deltaY < 0 ? -1 : 0);
        const options = select.options;
        if (!delta || !options || options.length === 0) { return; }
        const next = Math.max(0, Math.min(options.length - 1, select.selectedIndex + delta));
        if (next !== select.selectedIndex) {
          select.selectedIndex = next;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, { passive: false });
    }

    [portSelect, baudratePresetSelect, databitsSelect, paritySelect, stopbitsSelect, flowControlSelect]
      .forEach((select) => bindHoverWheelSelect(select));

    optPeriodicSend?.addEventListener('change', () => {
      postPeriodicCommand(optPeriodicSend.checked);
      saveState();
      broadcastUiState();
    });

    // Echo 开关：跨视口同步；周期发送运行中同步给宿主（回显由宿主定时器决定）
    optEcho?.addEventListener('change', () => {
      saveState();
      broadcastUiState();
      syncPeriodicSource();
    });

    periodicIntervalInput?.addEventListener('change', () => {
      clampPeriodicInterval();
      // 运行中：宿主按新周期重启定时器；未运行：仅同步数值（宿主保存供各视口初始化）
      postPeriodicCommand(activeBucket().periodic.enabled);
      saveState();
      broadcastUiState();
    });

    // 滚轮微调数值只触发 input（无 change/blur），需 input 级防抖提交才能跨视口同步
    let cycleWheelTimer = null;
    periodicIntervalInput?.addEventListener('input', () => {
      if (cycleWheelTimer) { clearTimeout(cycleWheelTimer); }
      cycleWheelTimer = setTimeout(() => {
        clampPeriodicInterval();
        postPeriodicCommand(activeBucket().periodic.enabled);
        broadcastUiState();
      }, 250);
    });

    // Cycle / Wrap 数值输入框：光标悬停自动聚焦（无需先点击）
    [periodicIntervalInput, rxIdleWrapInput].forEach((input) => {
      input?.addEventListener('mouseenter', () => {
        input.focus({ preventScroll: true });
      });
    });

    function applyBaudPreset(value) {
      if (baudrateInput) {
        baudrateInput.value = value;
      }
      if (baudratePresetSelect) {
        baudratePresetSelect.value = value;
      }
      persistCurrentConfigDraft();
      updateMonitorConfigChips();
      broadcastUiState();
    }

    baudratePresetSelect?.addEventListener('change', () => {
      if (!baudratePresetSelect.value) {
        // Custom：聚焦保持在当前下拉框（滚轮选择后不打断），不转移到自定义输入框
        return;
      }
      applyBaudPreset(baudratePresetSelect.value);
    });

    // 自定义波特率输入框：滚轮调整并吸附到 100 的倍数（与 Cycle 的步进逻辑一致，
    // 个位/十位非 0 时滚动会归零），悬停即可、无需先点击聚焦
    baudrateInput?.addEventListener('wheel', (event) => {
      event.preventDefault();
      const step = 100;
      const current = parseInt(baudrateInput.value, 10) || 115200;
      let next;
      if (event.deltaY > 0) {
        next = Math.floor(current / step) * step + step; // 下一个 100 的倍数
      } else if (event.deltaY < 0) {
        next = Math.ceil(current / step) * step - step;  // 上一个 100 的倍数
      } else {
        return;
      }
      baudrateInput.value = String(Math.max(1, Math.min(4000000, next)));
      baudrateInput.dispatchEvent(new Event('change', { bubbles: true }));
    }, { passive: false });

    /** 显示选项变更：写入当前监视器配置并上送（扩展会广播同步所有视口） */
    function syncDisplayConfig(partial) {
      const bucket = activeBucket();
      bucket.config = { ...(bucket.config || collectCurrentConfig()), ...partial };
    }

    optTimestamp?.addEventListener('change', () => {
      syncDisplayConfig({ showTimestamp: optTimestamp.checked });
      vscode.postMessage({ type: 'updateSettings', monitorId: activeMonitorId, showTimestamp: optTimestamp.checked });
      broadcastUiState();
    });
    optHex?.addEventListener('change', () => {
      syncDisplayConfig({ hexMode: optHex.checked });
      vscode.postMessage({ type: 'updateSettings', monitorId: activeMonitorId, hexMode: optHex.checked });
      broadcastUiState();
    });
    lineEndingSelect?.addEventListener('change', () => {
      syncDisplayConfig({ lineEnding: lineEndingSelect.value });
      vscode.postMessage({ type: 'updateSettings', monitorId: activeMonitorId, lineEnding: lineEndingSelect.value });
      broadcastUiState();
    });
    encodingSelect?.addEventListener('change', () => {
      syncDisplayConfig({ encoding: encodingSelect.value });
      vscode.postMessage({ type: 'updateSettings', monitorId: activeMonitorId, encoding: encodingSelect.value });
      broadcastUiState();
    });

    rxIdleWrapInput?.addEventListener('change', () => {
      const value = Math.max(1, Math.min(60000, parseInt(rxIdleWrapInput.value, 10) || 20));
      rxIdleWrapInput.value = String(value);
      syncDisplayConfig({ rxIdleWrapMs: value });
      vscode.postMessage({ type: 'updateSettings', monitorId: activeMonitorId, rxIdleWrapMs: value });
      broadcastUiState();
    });

    // 滚轮微调数值只触发 input（无 change/blur），需 input 级防抖提交才能跨视口同步
    let wrapWheelTimer = null;
    rxIdleWrapInput?.addEventListener('input', () => {
      if (wrapWheelTimer) { clearTimeout(wrapWheelTimer); }
      wrapWheelTimer = setTimeout(() => {
        const value = Math.max(1, Math.min(60000, parseInt(rxIdleWrapInput.value, 10) || 20));
        if (String(value) !== rxIdleWrapInput.value) { rxIdleWrapInput.value = String(value); }
        syncDisplayConfig({ rxIdleWrapMs: value });
        vscode.postMessage({ type: 'updateSettings', monitorId: activeMonitorId, rxIdleWrapMs: value });
        broadcastUiState();
      }, 250);
    });

    [
      portSelect,
      baudrateInput,
      databitsSelect,
      paritySelect,
      stopbitsSelect,
      flowControlSelect,
    ].forEach((element) => {
      element?.addEventListener('change', () => {
        // 用户手选后不再用"恢复的待选端口"覆盖，否则下次刷新会跳回旧设备
        pendingPort = '';
        // 选了别的端口后，"设备已不在"的失效项（下拉刷新前可能残留很久）就地清掉
        if (portSelect) {
          const selected = portSelect.selectedOptions && portSelect.selectedOptions[0];
          portSelect.querySelectorAll('option[data-port-missing="1"]').forEach((option) => {
            if (option !== selected) { option.remove(); }
          });
        }
        syncBaudratePreset();
        persistCurrentConfigDraft();
        updateMonitorConfigChips();
        broadcastUiState();
      });
    });
  }

  /** 未连接时用 chip 显示待连接参数；已连接时信息改由状态文字显示（端口 @ 波特率 校验） */
  function updateMonitorConfigChips() {
    const bucket = activeBucket();
    if (bucket.connected) {
      monitorPortChip?.classList.add('hidden');
      monitorBaudChip?.classList.add('hidden');
      monitorParityChip?.classList.add('hidden');
      return;
    }

    const port = portSelect?.value || '';
    const baud = baudrateInput?.value || '115200';
    if (monitorPortChip) {
      if (port) {
        monitorPortChip.textContent = port;
        monitorPortChip.classList.remove('hidden');
      } else {
        monitorPortChip.classList.add('hidden');
      }
    }
    if (monitorBaudChip) {
      monitorBaudChip.textContent = baud;
      monitorBaudChip.classList.toggle('hidden', !port);
    }
    if (monitorParityChip) {
      const parity = paritySelect?.value || 'none';
      monitorParityChip.textContent = PARITY_LABELS[parity] ?? PARITY_LABELS.none;
      monitorParityChip.classList.toggle('hidden', !port);
    }
  }

  /**
   * 状态文字：已连接显示 `端口 @ 波特率 校验`；未连接不显示文字，
   * 仅保留状态点（灰色圆点）表示断开。
   */
  function applyStatusText(text) {
    if (!statusText) { return; }
    statusText.textContent = text;
    statusText.classList.toggle('hidden', !text);
  }

  /** 展开/收起串口配置抽屉（按钮、默认状态恢复、可选的连接后自动收起共用） */
  function setConfigDrawerOpen(open) {
    if (!configDrawer) { return; }
    configDrawer.classList.toggle('hidden', !open);
    // aria-expanded 驱动 .config-toggle-icon 的 ▸/▾ 两态（纯 CSS）
    configToggleBtn?.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function bindLogActions() {
    logSearchInput?.addEventListener('input', () => {
      activeLogFilter = (logSearchInput.value || '').trim().toLowerCase();
      renderLogArea();
      saveState();
      broadcastUiState();
    });

    optAutoScroll?.addEventListener('change', () => {
      if (optAutoScroll.checked && !frozenLog) {
        scrollLogToBottom();
      }
      saveState();
      broadcastUiState();
    });

    freezeBtn?.addEventListener('click', () => {
      frozenLog = !frozenLog;
      updateFreezeButton();
      if (!frozenLog) {
        renderLogArea(true); // 解冻：强制刷新，补上冻结期间累积的日志
      }
      saveState();
      broadcastUiState();
    });

    clearBtn?.addEventListener('click', () => {
      vscode.postMessage({ type: 'clearLog', monitorId: activeMonitorId });
      const bucket = bucketFor(activeMonitorId);
      bucket.logEntries = [];
      bucket.logEntriesBytes = 0;
      // 无换行的 RX（文本模式下收到的 HEX 数据）停留在实时行，清屏时一并清掉
      bucket.terminal = { liveLine: '', buffer: '', caret: 0, deviceLine: null };
      renderLogArea(true);
    });

    copyLogBtn?.addEventListener('click', async () => {
      const visibleLog = getVisibleLogText();
      if (!visibleLog.length) {
        return;
      }
      try {
        await navigator.clipboard.writeText(visibleLog);
      } catch {
        const range = document.createRange();
        if (logArea) {
          range.selectNodeContents(logArea);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          document.execCommand('copy');
          selection?.removeAllRanges();
        }
      }
    });

    saveLogBtn?.addEventListener('click', () => {
      // monitorId 用于默认文件名与文件头部的串口信息
      vscode.postMessage({
        type: 'saveLogToFile',
        monitorId: activeMonitorId,
        lines: activeBucket().logEntries.map((entry) => entry.text.trimEnd()),
      });
    });
  }

  function bindSendActions() {
    optHexSend?.addEventListener('change', () => {
      updateSendPlaceholder();
      saveState();
      broadcastUiState();
      syncPeriodicSource();
    });

    sendBtn?.addEventListener('click', () => {
      doSend();
    });

    sendInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        doSend();
      }
    });

    // 发送框草稿：防抖广播到其它视口；周期发送运行中同步更新宿主的发送文本
    let sendDraftTimer = null;
    sendInput?.addEventListener('input', () => {
      saveState();
      if (sendDraftTimer) { clearTimeout(sendDraftTimer); }
      sendDraftTimer = setTimeout(() => {
        broadcastUiState();
        syncPeriodicSource();
      }, 300);
    });

    historyToggle?.addEventListener('click', () => {
      setHistoryOpen(!historyDropdown?.classList.contains('open'));
    });

    document.addEventListener('click', (event) => {
      if (historyDropdown && !historyDropdown.contains(/** @type {Node} */ (event.target))) {
        setHistoryOpen(false);
      }
    });
  }

  /** 历史下拉开合：同时切换发送区类名，让菜单能越过发送区上边界（不被日志区遮挡） */
  function setHistoryOpen(open) {
    historyDropdown?.classList.toggle('open', open);
    sendSection?.classList.toggle('history-open', open);
  }

  function bindQuickCommandActions() {
    quickCommandSaveBtn?.addEventListener('click', () => {
      const label = (quickCommandLabelInput?.value || '').trim();
      const value = quickCommandValueInput?.value || '';

      if (!label || !value.trim()) {
        return;
      }

      const command = {
        id: editingQuickCommandId || createId('cmd'),
        label,
        value,
        hexSend: !!quickCommandHexInput?.checked,
      };

      const existingIndex = quickCommands.findIndex((item) => item.id === command.id);
      if (existingIndex !== -1) {
        quickCommands.splice(existingIndex, 1, command);
      } else {
        quickCommands.unshift(command);
      }

      quickCommands = quickCommands.slice(0, 12);
      persistQuickCommands();
      renderQuickCommands();
      resetQuickCommandForm();
    });

    quickCommandResetBtn?.addEventListener('click', () => {
      resetQuickCommandForm();
    });
  }

  function bindResizeActions() {
    if (!(resizeHandle && sendSection && contentWrapper instanceof HTMLElement)) {
      return;
    }

    const MIN_LOG_HEIGHT = 60;
    const MIN_SEND_HEIGHT = 60;
    let dragging = false;
    let startY = 0;
    let startHeight = 0;
    let wrapperHeight = 0;

    resizeHandle.addEventListener('mousedown', (event) => {
      event.preventDefault();
      dragging = true;
      startY = event.clientY;
      startHeight = sendSection.offsetHeight;
      wrapperHeight = contentWrapper.clientHeight;
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (event) => {
      if (!dragging) {
        return;
      }

      const delta = startY - event.clientY;
      const maxHeight = Math.max(
        MIN_SEND_HEIGHT,
        wrapperHeight - MIN_LOG_HEIGHT - resizeHandle.offsetHeight,
      );
      const nextHeight = Math.max(MIN_SEND_HEIGHT, Math.min(maxHeight, startHeight + delta));
      sendSection.style.flexBasis = nextHeight + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) {
        return;
      }
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      saveCurrentLayout();
      saveState();
    });
  }

  function handleConnectionToggle() {
    const bucket = activeBucket();
    if (bucket.connected) {
      vscode.postMessage({ type: 'disconnect', monitorId: activeMonitorId });
      return;
    }

    const config = collectCurrentConfig();
    vscode.postMessage({ type: 'connect', monitorId: activeMonitorId, ...config });
  }

  function getActiveSendHeight() {
    return normalSendHeight;
  }

  function getDefaultSendHeight() {
    return DEFAULT_NORMAL_SEND_HEIGHT;
  }

  function applyCurrentLayout() {
    if (!sendSection) {
      return;
    }

    const nextHeight = getActiveSendHeight();
    sendSection.style.flexBasis = `${nextHeight ?? getDefaultSendHeight()}%`;
  }

  function saveCurrentLayout() {
    if (!(sendSection && contentWrapper instanceof HTMLElement)) {
      return;
    }

    const wrapperHeight = contentWrapper.clientHeight;
    if (!wrapperHeight) {
      return;
    }

    const nextHeight = Math.max(10, Math.min(90, (sendSection.offsetHeight / wrapperHeight) * 100));
    normalSendHeight = nextHeight;
    vscode.postMessage({ type: 'savePanelLayout', normalSendHeight: nextHeight });
  }

  function updateConnectionButtons() {
    const bucket = activeBucket();
    if (monitorConnectBtn) {
      monitorConnectBtn.textContent = bucket.connected ? 'Close' : 'Open';
      monitorConnectBtn.classList.toggle('status-action-primary', !bucket.connected);
      monitorConnectBtn.classList.toggle('status-action-danger', bucket.connected);
    }

    updateMonitorConfigChips();
  }

  function applyUiState(uiState) {
    normalSendHeight = typeof uiState?.normalSendHeight === 'number'
      ? uiState.normalSendHeight
      : normalSendHeight;

    updateConnectionButtons();
    applyCurrentLayout();
  }

  // 终端行编辑与 RX 行模拟已上移扩展侧（TerminalSession），
  // webview 通过 terminalKey 意图输入、terminalState 快照渲染。

  function unescapeSendText(text) {
    return String(text).replace(/\\(x[0-9a-fA-F]{2}|r|n|t|0|\\)/g, (match, seq) => {
      if (seq.charAt(0) === 'x' || seq.charAt(0) === 'X') {
        return String.fromCharCode(parseInt(seq.slice(1), 16));
      }
      switch (seq) {
        case 'r': return '\r';
        case 'n': return '\n';
        case 't': return '\t';
        case '0': return '\x00';
      }
      return match;
    });
  }

  /** 向宿主发送周期发送指令（定时器在宿主侧，单实例不会双发） */
  function postPeriodicCommand(enabled) {
    const text = sendInput?.value || '';
    const hexSend = !!optHexSend?.checked;
    vscode.postMessage({
      type: 'setPeriodicSend',
      monitorId: activeMonitorId,
      enabled,
      intervalMs: Math.max(10, parseInt(periodicIntervalInput?.value || '1000', 10) || 1000),
      text,
      // 与手动发送一致：文本模式先解释 \r \n \t \xNN 转义再落串口
      payload: hexSend ? text : unescapeSendText(text),
      hexSend,
      echo: !!optEcho?.checked,
    });
  }

  function clampPeriodicInterval() {
    if (!periodicIntervalInput) {
      return;
    }
    const value = parseInt(periodicIntervalInput.value, 10);
    const clamped = Number.isFinite(value) ? Math.max(10, value) : 1000;
    periodicIntervalInput.value = String(clamped);
  }

  /** 周期发送运行中：把回显/HEX/发送文本等来源同步给宿主定时器 */
  function syncPeriodicSource() {
    if (activeBucket().periodic.enabled) {
      postPeriodicCommand(true);
    }
  }

  // 周期发送的定时器在扩展宿主侧（MonitorHost.setPeriodicSend）：
  // 本地仅发送指令 + 通过 periodicState 广播同步勾选状态，天然不会双发。

  function updateSendControlsDisabled() {
    const connected = activeBucket().connected;
    quickCommandList?.querySelectorAll('.quick-command-chip').forEach((button) => {
      if (button instanceof HTMLButtonElement) {
        button.disabled = !connected;
      }
    });
  }

  function formatLogTimestamp() {
    const now = new Date();
    return `[${now.toTimeString().split(' ')[0]}.${String(now.getMilliseconds()).padStart(3, '0')}]`;
  }

  /** HEX 发送回显：与宿主共用 media/hex-format.js（大写、两字符一组） */
  function normalizeHexInput(text) {
    const api = /** @type {any} */ (window).HexFormat;
    if (api && typeof api.normalizeHexInput === 'function') {
      return api.normalizeHexInput(text);
    }
    return String(text || '').replace(/\s+/g, '').toUpperCase().replace(/(..)/g, '$1 ').trim();
  }

  function syncBaudratePreset() {
    if (!baudratePresetSelect) {
      return;
    }
    const baud = baudrateInput?.value || '';
    baudratePresetSelect.value = Array.from(baudratePresetSelect.options).some((option) => option.value === baud)
      ? baud
      : '';
  }

  function collectCurrentConfig() {
    return {
      port: portSelect?.value || '',
      baudRate: parseInt(baudrateInput?.value || '115200', 10),
      dataBits: parseInt(databitsSelect?.value || '8', 10),
      parity: paritySelect?.value || 'none',
      stopBits: parseFloat(stopbitsSelect?.value || '1'),
      flowControl: flowControlSelect?.value || 'none',
      lineEnding: lineEndingSelect?.value || 'none',
      showTimestamp: !!optTimestamp?.checked,
      hexMode: !!optHex?.checked,
      encoding: encodingSelect?.value || 'utf8',
      rxIdleWrapMs: Math.max(1, parseInt(rxIdleWrapInput?.value || '20', 10) || 20),
    };
  }

  /**
   * 在端口下拉里选中目标端口。
   * 端口不在列表时插入 `(not available)` 占位项并选中它：既保留上次保存的选择，
   * 也避免静默选中列表里的第一个设备（可能连到别的板子）。
   * @param {string} port
   */
  function applyPortSelection(port) {
    if (!portSelect) { return; }
    // 清掉上一次插入的占位/失效项（同一表单在多监视器间切换，不能残留别的端口）
    portSelect
      .querySelectorAll('option[data-port-placeholder="1"], option[data-port-missing="1"]')
      .forEach((option) => option.remove());
    if (!port) {
      // 清空选择：补一个空占位项，避免下拉默认展示第一个设备
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '-- Select port --';
      placeholder.dataset.portPlaceholder = '1';
      portSelect.insertBefore(placeholder, portSelect.firstChild);
      portSelect.value = '';
      return;
    }
    const exists = Array.from(portSelect.options).some((option) => option.value === port);
    if (!exists) {
      const missing = document.createElement('option');
      missing.value = port;
      missing.textContent = `${port} (not available)`;
      missing.dataset.portMissing = '1';
      portSelect.insertBefore(missing, portSelect.firstChild);
    }
    portSelect.value = port;
  }

  /**
   * @param {{ port: string; baudRate: number; dataBits: number; parity: string; stopBits: number; flowControl?: string; lineEnding: string; showTimestamp: boolean; hexMode: boolean; encoding?: string; rxIdleWrapMs?: number }} config
   */
  function applyConfigToInputs(config) {
    if (portSelect) {
      // 端口列表可能晚于配置到达：记住目标端口，updatePorts 重建选项后再选中
      pendingPort = config.port || '';
      applyPortSelection(pendingPort);
    }
    if (baudrateInput) { baudrateInput.value = String(config.baudRate || 115200); }
    if (databitsSelect) { databitsSelect.value = String(config.dataBits || 8); }
    if (paritySelect) { paritySelect.value = config.parity || 'none'; }
    if (stopbitsSelect) { stopbitsSelect.value = String(config.stopBits || 1); }
    if (flowControlSelect) { flowControlSelect.value = config.flowControl || 'none'; }
    if (lineEndingSelect) { lineEndingSelect.value = config.lineEnding || 'none'; }
    if (optTimestamp) { optTimestamp.checked = !!config.showTimestamp; }
    if (optHex) { optHex.checked = !!config.hexMode; }
    if (encodingSelect) { encodingSelect.value = config.encoding === 'gbk' ? 'gbk' : 'utf8'; }
    if (rxIdleWrapInput) { rxIdleWrapInput.value = String(config.rxIdleWrapMs || 20); }
    if (typeof config.logBufferKB === 'number') {
      logBufferKB = Math.max(1, Math.min(10240, Math.floor(config.logBufferKB) || 1024));
    }
    syncBaudratePreset();
    updateMonitorConfigChips();
  }

  /** 将广播回来的显示选项应用到表单（不触发 change 事件） */
  function applySettingsToForm(settings) {
    if (settings.showTimestamp !== undefined && optTimestamp) { optTimestamp.checked = !!settings.showTimestamp; }
    if (settings.hexMode !== undefined && optHex) { optHex.checked = !!settings.hexMode; }
    if (settings.lineEnding !== undefined && lineEndingSelect) { lineEndingSelect.value = settings.lineEnding; }
    if (settings.encoding !== undefined && encodingSelect) { encodingSelect.value = settings.encoding === 'gbk' ? 'gbk' : 'utf8'; }
    if (settings.rxIdleWrapMs !== undefined && rxIdleWrapInput) {
      rxIdleWrapInput.value = String(Math.max(1, Math.min(60000, Math.floor(settings.rxIdleWrapMs) || 20)));
    }
    if (settings.port !== undefined) {
      // 宿主清空了端口（设备已不在）：表单同步清空，避免看起来还连着别的设备
      pendingPort = settings.port || '';
      applyPortSelection(settings.port || '');
    }
  }

  // ---- 跨视口 UI 状态同步（侧边栏 ↔ 编辑器面板）----
  /** 收集当前视口的完整 UI 状态（显示选项 + 发送选项 + 视图选项 + 串口配置表单 + 发送草稿） */
  function collectUiState() {
    return {
      showTimestamp: !!optTimestamp?.checked,
      hexMode: !!optHex?.checked,
      lineEnding: lineEndingSelect?.value || 'none',
      encoding: encodingSelect?.value || 'utf8',
      rxIdleWrapMs: Math.max(1, parseInt(rxIdleWrapInput?.value || '20', 10) || 20),
      hexSend: !!optHexSend?.checked,
      echo: !!optEcho?.checked,
      autoScroll: !!optAutoScroll?.checked,
      frozenLog,
      logFilter: logSearchInput?.value || '',
      sendDraft: sendInput?.value || '',
      periodicInterval: Math.max(10, parseInt(periodicIntervalInput?.value || '1000', 10) || 1000),
      config: collectCurrentConfig(),
    };
  }

  function broadcastUiState() {
    if (!activeMonitorId) { return; }
    const state = collectUiState();
    const bucket = bucketFor(activeMonitorId);
    bucket.ui = state; // 本视口即时入桶
    bucket.sendDraft = state.sendDraft;
    vscode.postMessage({ type: 'uiStateChange', monitorId: activeMonitorId, state });
  }

  /** 应用另一视口同步来的 UI 状态（程序赋值不触发事件，无回环） */
  function applyUiStateSync(state) {
    if (!state) { return; }
    const previousFrozen = frozenLog;
    const previousFilter = activeLogFilter;
    applySettingsToForm(state);
    if (optHexSend) { optHexSend.checked = !!state.hexSend; updateSendPlaceholder(); }
    // 周期发送勾选由宿主 periodicState 广播驱动（此处不处理，避免双视口各自启停）
    if (optEcho) { optEcho.checked = !!state.echo; }
    if (optAutoScroll) { optAutoScroll.checked = !!state.autoScroll; }
    frozenLog = !!state.frozenLog;
    updateFreezeButton();
    if (typeof state.logFilter === 'string' && logSearchInput) {
      logSearchInput.value = state.logFilter;
      activeLogFilter = state.logFilter.trim().toLowerCase();
    }
    // 周期数值：未运行时随另一视口同步（运行中由宿主 periodicState 广播）
    if (typeof state.periodicInterval === 'number' && periodicIntervalInput
      && document.activeElement !== periodicIntervalInput) {
      const interval = Math.max(10, Math.floor(state.periodicInterval) || 1000);
      periodicIntervalInput.value = String(interval);
      if (!activeBucket().periodic.enabled) {
        activeBucket().periodic.intervalMs = interval;
      }
    }
    // 发送框草稿跨视口同步（本框正被编辑时不覆盖，避免打断输入）
    if (typeof state.sendDraft === 'string' && sendInput && document.activeElement !== sendInput) {
      if (sendInput.value !== state.sendDraft) {
        sendInput.value = state.sendDraft;
        const bucket = bucketFor(activeMonitorId);
        bucket.sendDraft = state.sendDraft;
      }
    }
    if (state.config) {
      applyConfigToInputs(state.config);
      const bucket = activeBucket();
      bucket.config = { ...(bucket.config || {}), ...state.config };
    }
    saveState();
    // 仅在冻结/过滤确实变化时重建视图（打字等高频同步不重建日志 DOM）
    if (previousFrozen !== frozenLog || previousFilter !== activeLogFilter) {
      renderLogArea(true, { preserveScroll: true });
    }
  }

  function persistCurrentConfigDraft() {
    if (!activeMonitorId) { return; }
    vscode.postMessage({ type: 'saveConfig', monitorId: activeMonitorId, config: collectCurrentConfig() });
  }

  function persistQuickCommands() {
    vscode.postMessage({ type: 'saveQuickCommands', commands: quickCommands });
  }

  function renderQuickCommands() {
    renderQuickCommandButtons();
    renderQuickCommandManager();
  }

  function renderQuickCommandButtons() {
    if (!quickCommandList) {
      return;
    }

    quickCommandBar?.classList.toggle('hidden', quickCommands.length === 0);
    quickCommandList.innerHTML = '';
    if (quickCommands.length === 0) {
      return;
    }

    quickCommands.forEach((command) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'quick-command-chip';
      button.textContent = command.label;
      button.title = command.value;
      button.addEventListener('click', () => {
        sendData(command.value, !!command.hexSend);
      });
      button.disabled = !activeBucket().connected;
      quickCommandList.appendChild(button);
    });
    updateSendControlsDisabled();
  }

  function renderQuickCommandManager() {
    if (!quickCommandManageList) {
      return;
    }

    quickCommandManageList.innerHTML = '';

    quickCommands.forEach((command) => {
      const row = document.createElement('div');
      row.className = 'quick-command-manage-item';

      const meta = document.createElement('div');
      meta.className = 'quick-command-manage-meta';
      meta.textContent = `${command.label} · ${command.hexSend ? 'HEX' : 'Text'} · ${command.value}`;

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn-secondary btn-compact';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => {
        editingQuickCommandId = command.id;
        if (quickCommandLabelInput) { quickCommandLabelInput.value = command.label; }
        if (quickCommandValueInput) { quickCommandValueInput.value = command.value; }
        if (quickCommandHexInput) { quickCommandHexInput.checked = !!command.hexSend; }
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn-secondary btn-compact';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => {
        quickCommands = quickCommands.filter((item) => item.id !== command.id);
        persistQuickCommands();
        renderQuickCommands();
        if (editingQuickCommandId === command.id) {
          resetQuickCommandForm();
        }
      });

      row.appendChild(meta);
      row.appendChild(editBtn);
      row.appendChild(deleteBtn);
      quickCommandManageList.appendChild(row);
    });
  }

  function resetQuickCommandForm() {
    editingQuickCommandId = '';
    if (quickCommandLabelInput) { quickCommandLabelInput.value = ''; }
    if (quickCommandValueInput) { quickCommandValueInput.value = ''; }
    if (quickCommandHexInput) { quickCommandHexInput.checked = false; }
  }

  function createId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  }

  function updateSendPlaceholder() {
    if (!sendInput) {
      return;
    }
    sendInput.placeholder = optHexSend?.checked
      ? 'HEX: 41 42 0D 0A (Ctrl+Enter to send)'
      : 'Send data... (Ctrl+Enter to send)';
  }

  function doSend(selectAfterSend = true) {
    doSendFor(activeMonitorId, selectAfterSend);
    if (selectAfterSend) {
      sendInput?.select();
    }
  }

  function doSendFor(monitorId, selectAfterSend = true) {
    const bucket = bucketFor(monitorId);
    const text = (monitorId === activeMonitorId && sendInput) ? sendInput.value : bucket.sendDraft;
    if (!text || !text.trim()) {
      return;
    }
    if (!bucket.connected) {
      bucket.pendingSendAfterConnect = true;
      const config = bucket.config || collectCurrentConfig();
      vscode.postMessage({ type: 'connect', monitorId, ...config });
      return;
    }
    sendDataFor(monitorId, text, !!optHexSend?.checked);
    void selectAfterSend;
  }

  function sendData(text, hexSend) {
    sendDataFor(activeMonitorId, text, hexSend);
  }

  function sendDataFor(monitorId, text, hexSend) {
    const bucket = bucketFor(monitorId);
    if (!bucket.connected) {
      return;
    }
    const payload = hexSend ? text : unescapeSendText(text);
    vscode.postMessage({ type: 'sendData', monitorId, text: payload, hexSend });

    if (monitorId === activeMonitorId && optEcho?.checked) {
      const tsPrefix = optTimestamp?.checked ? `${formatLogTimestamp()} ` : '';
      if (hexSend) {
        appendLogEntry(`${tsPrefix}TX HEX>> ${normalizeHexInput(payload)}`, 'echo', monitorId);
      } else {
        const body = payload.split('\n').map((line) => `${tsPrefix}TX>> ${line}`).join('\n');
        appendLogEntry(body, 'echo', monitorId);
      }
    }

    const historyIndex = bucket.sendHistory.indexOf(text);
    if (historyIndex !== -1) {
      bucket.sendHistory.splice(historyIndex, 1);
    }
    bucket.sendHistory.unshift(text);
    if (bucket.sendHistory.length > MAX_HISTORY) {
      bucket.sendHistory.pop();
    }
    if (monitorId === activeMonitorId) {
      updateHistorySelect();
    }
    vscode.postMessage({ type: 'saveSendHistory', monitorId, history: bucket.sendHistory });
    saveState();
  }

  function updateHistorySelect() {
    if (!historyMenu) {
      return;
    }

    const sendHistory = activeBucket().sendHistory;
    historyMenu.innerHTML = '';
    if (sendHistory.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = 'No history';
      historyMenu.appendChild(empty);
      return;
    }

    sendHistory.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'history-item';

      const textSpan = document.createElement('span');
      textSpan.className = 'history-text';
      textSpan.textContent = item.length > 50 ? item.substring(0, 47) + '...' : item;
      textSpan.title = item;
      textSpan.addEventListener('click', () => {
        if (sendInput) {
          sendInput.value = item;
          sendInput.focus();
          saveState();
        }
        setHistoryOpen(false);
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'history-delete';
      deleteBtn.textContent = '\u00d7';
      deleteBtn.title = 'Delete this entry';
      deleteBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        sendHistory.splice(index, 1);
        updateHistorySelect();
        vscode.postMessage({ type: 'saveSendHistory', monitorId: activeMonitorId, history: sendHistory });
      });

      row.appendChild(textSpan);
      row.appendChild(deleteBtn);
      historyMenu.appendChild(row);
    });
  }

  /** 追加日志到指定监视器的桶（默认当前激活监视器） */
  function appendLogEntry(text, kind, monitorId) {
    const bucket = bucketFor(monitorId || activeMonitorId);
    bucket.logEntries.push({ text, kind });
    bucket.logEntriesBytes += utf8ByteLength(text);
    // 总字节数上限（Buffer KB 配置），从最旧端丢弃（至少保留最新一条）
    while (bucket.logEntries.length > 1 && bucket.logEntriesBytes > logRenderBytesLimit()) {
      bucket.logEntriesBytes -= utf8ByteLength(bucket.logEntries[0].text);
      bucket.logEntries.shift();
    }
    scheduleRender(); // 增量渲染（冻结/选中时内部跳过，数据静默累积）
  }

  /** 日志区内是否有未收起的文本选区（innerHTML 重建会摧毁选区） */
  function logAreaHasSelection() {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return false;
    }
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    return !!logArea && !!anchor && !!focus && logArea.contains(anchor) && logArea.contains(focus);
  }

  // 取消选中后立即补渲染选中期间累积的日志（不等下一次数据到达）；
  // 保留当前滚动位置：用户刚复制完不该被拉回最后一行
  let logAreaWasSelected = false;
  document.addEventListener('selectionchange', () => {
    const selected = logAreaHasSelection();
    if (logAreaWasSelected && !selected && !frozenLog) {
      renderLogArea(true, { preserveScroll: true });
    }
    logAreaWasSelected = selected;
  });

  // ---- 高频渲染路径：持久节点 + 增量追加 + rAF 合并 ----
  // 大流量下（数百 KB）每次全量 innerHTML 重建是 O(N) 卡顿来源：
  // 提交行放入持久容器只追加新行、字节淘汰时同步裁头；实时行独立更新；
  // 多次数据到达合并到一帧渲染。
  // DOM 渲染上限：只保留最近 RENDER_CAP 行（切回大日志标签时避免数千节点
  // 同步重建卡死主线程）；完整数据仍在桶中（Save/Copy/过滤不受影响）。
  const RENDER_CAP = 500;
  const logEntriesContainer = document.createElement('div');
  const liveLineDiv = document.createElement('div');
  liveLineDiv.className = 'log-line rx-live-line';
  let domRenderState = { bucketId: '', consumed: 0, filter: '' };
  let renderRafPending = false;

  function scheduleRender() {
    if (renderRafPending) { return; }
    renderRafPending = true;
    requestAnimationFrame(() => {
      renderRafPending = false;
      if (!logArea || frozenLog || logAreaHasSelection()) { return; }
      renderEntriesIncremental();
      updateLiveLine();
      if (optAutoScroll?.checked) { scrollLogToBottom(); }
    });
  }

  function renderEntriesIncremental() {
    const bucket = activeBucket();
    const entries = bucket.logEntries;
    if (
      domRenderState.bucketId !== activeMonitorId
      // 过滤视图必须走全量：增量路径直接追加原始条目，且 DOM 头节点与
      // 原始条目的淘汰差量不再一一对应（DOM 里是过滤后的子集）
      || !!activeLogFilter
      || domRenderState.filter !== activeLogFilter
      || !logEntriesContainer.isConnected
      || !liveLineDiv.isConnected
    ) {
      renderLogArea(true); // 桶切换 / 过滤 / 结构异常：退回全量（受 RENDER_CAP 保护）
      return;
    }
    // 字节上限淘汰最旧条目：按差量裁掉头部节点，无需全量重建
    const evicted = domRenderState.consumed - entries.length;
    if (evicted > 0) {
      let toRemove = Math.min(evicted, logEntriesContainer.children.length);
      while (toRemove-- > 0) {
        logEntriesContainer.removeChild(logEntriesContainer.firstChild);
      }
      domRenderState.consumed = entries.length;
    }
    if (domRenderState.consumed < entries.length) {
      const start = Math.max(domRenderState.consumed, entries.length - RENDER_CAP);
      const fragment = document.createDocumentFragment();
      for (let i = start; i < entries.length; i++) {
        const line = document.createElement('div');
        line.className = entries[i].kind === 'echo' ? 'log-line log-echo' : 'log-line';
        line.textContent = entries[i].text;
        fragment.appendChild(line);
      }
      logEntriesContainer.appendChild(fragment);
      domRenderState.consumed = entries.length;
    }
    // 渲染上限裁头
    while (logEntriesContainer.children.length > RENDER_CAP) {
      logEntriesContainer.removeChild(logEntriesContainer.firstChild);
    }
  }

  function updateLiveLine() {
    if (!logArea) { return; }
    const terminal = activeBucket().terminal;
    const liveLine = terminal.liveLine;
    const deviceLine = terminal.deviceLine;
    const before = terminal.buffer.slice(0, terminal.caret);
    const after = terminal.buffer.slice(terminal.caret);
    const caretText = `${before}\u258c${after}`;
    if (!liveLine) {
      liveLineDiv.textContent = `> ${caretText}`;
    } else if (deviceLine !== null && liveLine.endsWith(deviceLine)) {
      liveLineDiv.textContent = liveLine.slice(0, -deviceLine.length) + caretText;
    } else if (deviceLine !== null) {
      // 同步态但实时行与同步命令不匹配（罕见分片）：信任设备行，光标置于行尾
      liveLineDiv.textContent = `${liveLine}\u258c`;
    } else {
      liveLineDiv.textContent = liveLine + caretText;
    }
    if (!liveLineDiv.isConnected) {
      logArea.appendChild(liveLineDiv);
    }
  }

  function renderLogArea(force, options) {
    if (!logArea) {
      return;
    }
    // 冻结或正在选中日志文本时跳过重建：冻结应完全停住视图（数据仍持续累积，
    // 解冻后一次性刷新）；选中期间重建会丢失选区，导致 Ctrl+C 复制不到内容
    if (!force && (frozenLog || logAreaHasSelection())) {
      return;
    }

    // 保留阅读位置：取消选中/同步状态触发的重建不该把视图拉回最后一行
    const preserveScroll = !!(options && options.preserveScroll);
    const previousScrollTop = logArea.scrollTop;
    const wasAtBottom = logArea.scrollHeight - logArea.scrollTop - logArea.clientHeight <= 4;

    logArea.innerHTML = '';
    logEntriesContainer.innerHTML = '';

    // 只渲染最近 RENDER_CAP 行（过滤后），完整数据在桶中
    const visibleEntries = getVisibleEntries();
    const renderEntries = visibleEntries.slice(-RENDER_CAP);
    const fragment = document.createDocumentFragment();
    renderEntries.forEach((entry) => {
      const line = document.createElement('div');
      line.className = entry.kind === 'echo' ? 'log-line log-echo' : 'log-line';
      line.textContent = entry.text;
      fragment.appendChild(line);
    });
    logEntriesContainer.appendChild(fragment);
    logArea.appendChild(logEntriesContainer);
    updateLiveLine();

    domRenderState = {
      bucketId: activeMonitorId,
      consumed: activeBucket().logEntries.length,
      filter: activeLogFilter,
    };
    updateEmptyState();

    if (preserveScroll && !wasAtBottom) {
      logArea.scrollTop = previousScrollTop; // 原本在看历史：原地不动，忽略 AutoScroll
    } else if (optAutoScroll?.checked && !frozenLog) {
      scrollLogToBottom();
    }
  }

  function getVisibleEntries() {
    const logEntries = activeBucket().logEntries;
    if (!activeLogFilter) {
      return logEntries;
    }
    return logEntries.filter((entry) => entry.text.toLowerCase().includes(activeLogFilter));
  }

  function getVisibleLogText() {
    return getVisibleEntries().map((entry) => entry.text).join('\n');
  }

  function updateEmptyState() {
    if (!logEmptyState) {
      return;
    }
    logEmptyState.classList.add('hidden');
  }

  function updateFreezeButton() {
    if (!freezeBtn) {
      return;
    }
    freezeBtn.textContent = frozenLog ? 'Resume' : 'Freeze';
    freezeBtn.classList.toggle('btn-primary', frozenLog);
    freezeBtn.classList.toggle('btn-secondary', !frozenLog);
  }

  function scrollLogToBottom() {
    if (!logArea) {
      return;
    }
    logArea.scrollTop = logArea.scrollHeight;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) { return bytes + ' B'; }
    if (bytes < 1048576) { return (bytes / 1024).toFixed(1) + ' KB'; }
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function formatPortLabel(port) {
    const driverLabel = normalizeDriverLabel(port.driverLabel || port.friendlyName);
    if (driverLabel) {
      return `${port.path} ${driverLabel}`;
    }

    let label = port.path;
    if (port.manufacturer) { label += ' - ' + port.manufacturer; }
    if (port.vendorId) { label += ' (VID:' + port.vendorId + ')'; }
    return label;
  }

  function buildPortTooltip(port) {
    return [port.friendlyName, port.manufacturer, port.pnpId].filter(Boolean).join('\n');
  }

  function normalizeDriverLabel(label) {
    if (!label) {
      return '';
    }
    return String(label)
      .replace(/\s*\((COM\d+)\)\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  window.addEventListener('message', (event) => {
    const message = event.data;

    switch (message.type) {
      case 'updatePorts': {
        if (!portSelect) { break; }
        // 优先用恢复的/待选端口，其次保持当前选择（重建选项会丢失 selection）
        const previousValue = pendingPort || portSelect.value || '';
        pendingPort = '';
        portSelect.innerHTML = '';

        const ports = message.ports || [];
        if (ports.length === 0) {
          const option = document.createElement('option');
          option.value = '';
          option.textContent = '-- No ports found --';
          portSelect.appendChild(option);
          portSelect.value = '';
          break;
        }
        ports.forEach((port) => {
          const option = document.createElement('option');
          option.value = port.path;
          const label = formatPortLabel(port);
          option.textContent = label;
          option.title = buildPortTooltip(port);
          portSelect.appendChild(option);
        });

        applyPortSelection(previousValue || ports[0].path);
        break;
      }

      case 'updateStatus': {
        const id = message.monitorId;
        if (!id) { break; }
        const bucket = bucketFor(id);
        const wasConnected = bucket.connected;
        bucket.connected = !!message.connected;
        bucket.statusConnected = bucket.connected;
        bucket.statusPort = message.port || '';
        bucket.statusBaud = message.baudRate || 0;
        bucket.statusParity = message.parity || 'none';
        bucket.statusText = bucket.connected
          ? `${bucket.statusPort} @ ${bucket.statusBaud} ${PARITY_LABELS[bucket.statusParity] ?? PARITY_LABELS.none}`
          : '';
        if (!bucket.connected) {
          bucket.pendingSendAfterConnect = false;
          bucket.terminal = { liveLine: '', buffer: '', caret: 0, deviceLine: null };
          // 周期发送随断开停止：宿主侧停表并广播 periodicState（此处无需处理）
        }
        // 连接状态即时同步到标签（圆点）
        const meta = monitors.find((m) => m.id === id);
        if (meta) { meta.connected = bucket.connected; }
        renderMonitors();
        if (id !== activeMonitorId) { break; }

        if (statusDot) {
          statusDot.className = bucket.connected
            ? 'status-indicator status-connected'
            : 'status-indicator status-disconnected';
        }
        applyStatusText(bucket.statusText);
        updateConnectionButtons();
        [portSelect, baudratePresetSelect, baudrateInput, databitsSelect, paritySelect, stopbitsSelect, flowControlSelect].forEach((element) => {
          if (element) { element.disabled = bucket.connected; }
        });
        if (bucket.connected && bucket.pendingSendAfterConnect) {
          bucket.pendingSendAfterConnect = false;
          doSend();
        }
        updateSendControlsDisabled();
        updateEmptyState();
        // 连接成功钩子（可配置，默认关闭）：仅在断开→连接时收起配置抽屉
        if (!wasConnected && bucket.connected && collapseConfigOnConnect) {
          setConfigDrawerOpen(false);
          saveState();
        }
        break;
      }

      case 'logLines': {
        if (!message.monitorId || !Array.isArray(message.lines)) { break; }
        // 时间戳跟随"该行所属监视器"的配置（而非当前标签的复选框）：
        // 周期发送在后台监视器上运行时，切走标签也能正确盖时间戳
        const cfg = bucketFor(message.monitorId).config;
        const useTs = cfg ? !!cfg.showTimestamp : !!optTimestamp?.checked;
        for (const line of message.lines) {
          const text = useTs ? `${formatLogTimestamp()} ${line}` : line;
          appendLogEntry(text, message.kind === 'echo' ? 'echo' : 'text', message.monitorId);
        }
        break;
      }

      case 'settingsSync': {
        // 任一视口（侧边栏/编辑器面板）修改显示选项后，扩展广播同步所有视口
        if (!message.monitorId || !message.settings) { break; }
        const bucket = bucketFor(message.monitorId);
        bucket.config = { ...(bucket.config || {}), ...message.settings };
        if (message.monitorId === activeMonitorId) {
          applySettingsToForm(message.settings);
        }
        break;
      }

      case 'uiStateSync': {
        // 另一视口的完整 UI 状态（显示/发送/视图选项 + 串口配置表单）
        if (!message.monitorId || !message.state) { break; }
        const bucket = bucketFor(message.monitorId);
        bucket.ui = message.state;
        bucket.config = { ...(bucket.config || {}), ...(message.state.config || {}) };
        if (message.monitorId === activeMonitorId) {
          applyUiStateSync(message.state);
        }
        break;
      }

      case 'quickCommandsSync': {
        // 另一视口增删改快捷指令后同步
        if (Array.isArray(message.commands)) {
          quickCommands = message.commands;
          renderQuickCommands();
        }
        break;
      }

      case 'terminalState': {
        if (!message.monitorId || !message.state) { break; }
        bucketFor(message.monitorId).terminal = message.state;
        if (message.monitorId === activeMonitorId) {
          scheduleRender(); // 大流量下终端快照频繁，rAF 合并到每帧一次
        }
        break;
      }

      case 'clearScreen': {
        if (!message.monitorId) { break; }
        const bucket = bucketFor(message.monitorId);
        bucket.logEntries = [];
        bucket.logEntriesBytes = 0;
        // 仅当清屏发生在当前显示的监视器时才重建视图（否则只是静默清桶）
        if (message.monitorId === activeMonitorId) {
          renderLogArea(true);
        }
        break;
      }

      case 'appendError': {
        if (message.monitorId && message.message) {
          appendLogEntry(`[ERROR] ${message.message}`, 'echo', message.monitorId);
        }
        break;
      }

      case 'monitorsChanged': {
        if (!Array.isArray(message.monitors)) { break; }
        applyMonitors(message.monitors);
        break;
      }

      case 'periodicState': {
        // 宿主侧周期发送状态（启停/周期变化）广播：所有视口的勾选与数值一致
        if (!message.monitorId) { break; }
        const bucket = bucketFor(message.monitorId);
        bucket.periodic = {
          enabled: !!message.enabled,
          intervalMs: Math.max(10, Math.floor(message.intervalMs) || 1000),
        };
        if (message.monitorId === activeMonitorId) {
          if (optPeriodicSend && optPeriodicSend.checked !== bucket.periodic.enabled) {
            optPeriodicSend.checked = bucket.periodic.enabled;
          }
          if (periodicIntervalInput && document.activeElement !== periodicIntervalInput) {
            periodicIntervalInput.value = String(bucket.periodic.intervalMs);
          }
        }
        break;
      }

      case 'periodicTick': {
        // 宿主定时器的一拍：回显（历史由宿主统一维护后经 sendHistorySync 广播）
        const id = message.monitorId;
        if (!id || typeof message.text !== 'string') { break; }
        if (message.echo) {
          const payload = typeof message.payload === 'string' ? message.payload : message.text;
          const cfg = bucketFor(id).config;
          const useTs = cfg ? !!cfg.showTimestamp : !!optTimestamp?.checked;
          const tsPrefix = useTs ? `${formatLogTimestamp()} ` : '';
          const body = message.hexSend
            ? `${tsPrefix}TX HEX>> ${normalizeHexInput(payload)}`
            : `${tsPrefix}TX>> ${payload}`;
          appendLogEntry(body, 'echo', id);
        }
        break;
      }

      case 'sendHistorySync': {
        // 另一视口/宿主更新了发送历史（内容变化时才重建下拉 DOM）
        if (!message.monitorId || !Array.isArray(message.history)) { break; }
        const bucket = bucketFor(message.monitorId);
        const changed = bucket.sendHistory.length !== message.history.length
          || bucket.sendHistory[0] !== message.history[0];
        bucket.sendHistory = message.history;
        if (changed && message.monitorId === activeMonitorId) { updateHistorySelect(); }
        break;
      }

      case 'monitorSnapshot': {
        // 宿主回放该监视器已产生的日志与终端状态：两个视口显示一致
        const id = message.monitorId;
        if (!id) { break; }
        const bucket = bucketFor(id);
        const entries = Array.isArray(message.entries) ? message.entries : [];
        bucket.logEntries = entries
          .filter((entry) => entry && typeof entry.text === 'string')
          .map((entry) => ({ text: entry.text, kind: entry.kind === 'echo' ? 'echo' : 'text' }));
        bucket.logEntriesBytes = bucket.logEntries.reduce((sum, entry) => sum + utf8ByteLength(entry.text), 0);
        if (message.terminal && typeof message.terminal === 'object') {
          bucket.terminal = message.terminal;
        }
        if (id === activeMonitorId) {
          renderLogArea(true);
        }
        break;
      }

      case 'activateMonitor': {
        // 编辑器面板初始绑定的监视器（restoreState 后切换激活标签）
        if (typeof message.monitorId === 'string' && message.monitorId) {
          switchMonitor(message.monitorId, { force: true });
        }
        break;
      }

      case 'renameResult': {
        // 失败时在状态栏短暂提示，并恢复标签/标题行显示（失败不会触发 monitorsChanged）
        if (!message.ok) {
          if (message.error) { applyStatusText(message.error); }
          titleRenameActive = false;
          renderMonitors();
        }
        break;
      }

      case 'monitorLimitReached': {
        applyStatusText(message.message || 'Monitor limit reached');
        break;
      }

      case 'clearLog': {
        const id = message.monitorId || activeMonitorId;
        const bucket = bucketFor(id);
        bucket.logEntries = [];
        bucket.logEntriesBytes = 0;
        bucket.rxCount = 0;
        bucket.txCount = 0;
        // 实时行也属于日志显示内容：不带换行的 RX 不能残留
        bucket.terminal = { liveLine: '', buffer: '', caret: 0, deviceLine: null };
        if (id === activeMonitorId) {
          renderLogArea(true);
          if (rxCountEl) { rxCountEl.textContent = 'RX: 0'; }
          if (txCountEl) { txCountEl.textContent = 'TX: 0'; }
        }
        break;
      }

      case 'updateLogBuffer': {
        // 后台配置项 serialagent-plus.logBufferKB 变化时由扩展推送
        if (typeof message.logBufferKB === 'number') {
          logBufferKB = Math.max(1, Math.min(10240, Math.floor(message.logBufferKB) || 1024));
        }
        break;
      }

      case 'updateCounters': {
        const bucket = message.monitorId ? bucketFor(message.monitorId) : null;
        if (bucket) {
          bucket.rxCount = message.rx || 0;
          bucket.txCount = message.tx || 0;
        }
        if (!message.monitorId || message.monitorId === activeMonitorId) {
          if (rxCountEl) { rxCountEl.textContent = 'RX: ' + formatBytes(message.rx || 0); }
          if (txCountEl) { txCountEl.textContent = 'TX: ' + formatBytes(message.tx || 0); }
        }
        break;
      }

      case 'restoreState': {
        if (Array.isArray(message.monitors) && message.monitors.length > 0) {
          // 每个监视器的配置与发送历史入桶
          for (const info of message.monitors) {
            const bucket = bucketFor(info.id);
            bucket.config = info.config || null;
            bucket.ui = info.ui || null;
            bucket.sendHistory = Array.isArray(info.sendHistory) ? info.sendHistory : [];
            if (info.connected) {
              bucket.connected = true;
              bucket.statusConnected = true;
              bucket.statusPort = info.port || '';
              bucket.statusBaud = info.baudRate || 0;
              bucket.statusParity = info.parity || 'none';
              bucket.statusText = `${bucket.statusPort} @ ${bucket.statusBaud} ${PARITY_LABELS[bucket.statusParity] ?? PARITY_LABELS.none}`;
            }
          }
          applyMonitors(message.monitors, { restore: true });
        }
        if (Array.isArray(message.quickCommands)) {
          quickCommands = message.quickCommands;
          renderQuickCommands();
        } else {
          renderQuickCommands();
        }
        if (message.options && typeof message.options === 'object') {
          applyUiOptions(message.options);
        }
        applyUiState(message.uiState || {});
        updateEmptyState();
        break;
      }

      case 'uiOptions': {
        applyUiOptions(message);
        break;
      }

    }
  });

  /** 应用后台 UI 行为开关（连接后自动收起配置抽屉等） */
  function applyUiOptions(options) {
    if (typeof options.collapseConfigOnConnect === 'boolean') {
      collapseConfigOnConnect = options.collapseConfigOnConnect;
    }
  }

  // ---- 多监视器标签栏 ----
  // 编辑器面板视图（无标签栏）：不跟随新建切换激活标签，只在绑定监视器消失时回退
  const isPanelView = !!window.__isPanelView;

  function applyMonitors(nextMonitors, options) {
    const restore = !!(options && options.restore);
    const previousActiveId = activeMonitorId;
    const previousIds = new Set(monitors.map((m) => m.id));
    // 在替换前列表前记录激活标签的旧位置（删除后按原位钳制选邻居）
    const oldPos = [...monitors]
      .sort((a, b) => a.index - b.index)
      .findIndex((m) => m.id === previousActiveId);
    monitors = nextMonitors;

    if (!monitors.some((m) => m.id === activeMonitorId)) {
      // 激活监视器被删除（或首次恢复）：原位停留（钳制到新列表，删最右则落到新最右）。
      // force：activeMonitorId 即便恰好等于目标也必须完整切换（旧 UI 属于已删除的标签）
      const sortedNew = [...monitors].sort((a, b) => a.index - b.index);
      const targetPos = Math.max(0, Math.min(oldPos < 0 ? 0 : oldPos, sortedNew.length - 1));
      const targetId = (sortedNew[targetPos] || monitors[0]).id;
      switchMonitor(targetId, { restore, force: true });
    } else if (!restore && !isPanelView) {
      // 新建监视器：仅标签管理视口（侧边栏）自动切换到它；编辑器面板保持绑定不变
      const created = monitors.find((m) => !previousIds.has(m.id));
      if (created) {
        switchMonitor(created.id);
      } else {
        renderMonitors();
      }
    } else {
      renderMonitors();
    }
  }

  function switchMonitor(id, options) {
    const restore = !!(options && options.restore);
    const force = !!(options && options.force);
    if (!restore && !force && id === activeMonitorId) { return; }
    // 切换标签时放弃标题行未完成的重命名（输入框属于上一个监视器）
    titleRenameActive = false;
    // 保存当前发送框草稿与表单配置到旧桶
    if (activeMonitorId) {
      const oldBucket = bucketFor(activeMonitorId);
      if (sendInput) { oldBucket.sendDraft = sendInput.value; }
      oldBucket.config = collectCurrentConfig();
    }
    // 周期发送定时器在宿主侧跨标签继续跑；勾选状态由宿主 periodicState 广播到所有视口
    activeMonitorId = id;
    const bucket = bucketFor(id);
    // 首次恢复时不覆盖 restoreWebviewState 恢复的发送框内容（桶草稿为空则保持现状）
    if (sendInput && (bucket.sendDraft || !restore)) {
      sendInput.value = bucket.sendDraft || '';
    }
    if (bucket.config) {
      applyConfigToInputs(bucket.config); // 表单切换为该监视器的配置
    }
    if (bucket.ui) {
      applyUiStateSync(bucket.ui); // 恢复该监视器上次的完整 UI 状态（含视图选项）
    }
    // 周期发送定时器在宿主侧跨标签继续跑；勾选/数值按桶内 periodic 状态恢复
    if (optPeriodicSend) { optPeriodicSend.checked = bucket.periodic.enabled; }
    if (periodicIntervalInput) { periodicIntervalInput.value = String(bucket.periodic.intervalMs || 1000); }
    if (statusDot) {
      statusDot.className = bucket.connected
        ? 'status-indicator status-connected'
        : 'status-indicator status-disconnected';
    }
    if (statusText) { applyStatusText(bucket.statusText); }
    if (rxCountEl) { rxCountEl.textContent = 'RX: ' + formatBytes(bucket.rxCount); }
    if (txCountEl) { txCountEl.textContent = 'TX: ' + formatBytes(bucket.txCount); }
    [portSelect, baudratePresetSelect, baudrateInput, databitsSelect, paritySelect, stopbitsSelect, flowControlSelect].forEach((element) => {
      if (element) { element.disabled = bucket.connected; }
    });
    updateConnectionButtons();
    updateHistorySelect();
    updateSendControlsDisabled();
    renderLogArea(true);
    renderMonitors();
    requestMonitorSnapshot(id);
  }

  /** 首次查看某监视器时向宿主请求日志/终端快照（保证两个视口的日志区一致） */
  function requestMonitorSnapshot(id) {
    if (!id) { return; }
    const bucket = bucketFor(id);
    if (bucket.snapshotRequested) { return; }
    bucket.snapshotRequested = true;
    vscode.postMessage({ type: 'requestMonitorSnapshot', monitorId: id });
  }

  function renderMonitors() {
    if (!monitorTabs) { return; }
    monitorTabs.innerHTML = '';
    for (const meta of monitors) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'monitor-tab' + (meta.id === activeMonitorId ? ' active' : '');
      tab.title = `${meta.index}=${meta.name}`;

      const dot = document.createElement('span');
      dot.className = 'status-indicator ' + (meta.connected ? 'status-connected' : 'status-disconnected');
      tab.appendChild(dot);

      const label = document.createElement('span');
      label.className = 'monitor-tab-label';
      label.textContent = `${meta.index}=${meta.name}`;
      tab.appendChild(label);

      // 仅剩一个监视器时不可删除（注册表最少保留 1 个）——不渲染删除按钮
      if (monitors.length > 1) {
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'monitor-tab-close';
        close.textContent = '\u00d7';
        close.title = 'Delete this monitor';
        close.addEventListener('click', (event) => {
          event.stopPropagation();
          vscode.postMessage({ type: 'deleteMonitor', monitorId: meta.id });
        });
        tab.appendChild(close);
      }

      tab.addEventListener('click', () => {
        switchMonitor(meta.id);
      });
      tab.addEventListener('dblclick', () => {
        startTabRename(tab, meta);
      });
      monitorTabs.appendChild(tab);
    }
    updateTabsSlider();
    // 标题行与标签一致显示 `序号=名称`（序号不可改）；重命名编辑中不覆盖输入框
    if (monitorNameTitle) {
      if (titleRenameActive) {
        // 编辑中：保留 `序号=` + 输入框
      } else {
        const meta = activeMeta();
        monitorNameTitle.classList.remove('is-renaming');
        if (meta) {
          monitorNameTitle.textContent = `${meta.index}=${meta.name}`;
          monitorNameTitle.title = `${meta.index}=${meta.name} (double-click to rename)`;
        }
      }
    }
  }

  // 标签栏滚轮横向滚动（原生滚动条隐藏，顶部用自绘滑块）
  monitorTabs?.addEventListener('wheel', (event) => {
    if (monitorTabs.scrollWidth <= monitorTabs.clientWidth) { return; }
    event.preventDefault();
    monitorTabs.scrollLeft += event.deltaY !== 0 ? event.deltaY : event.deltaX;
  }, { passive: false });

  /** 自绘滑块：跟随滚动位置，可拖拽/点击跳转（VS Code 选项卡风格，无箭头） */
  function updateTabsSlider() {
    if (!monitorTabs || !monitorTabsSlider || !monitorTabsThumb) { return; }
    const overflow = monitorTabs.scrollWidth - monitorTabs.clientWidth;
    if (overflow <= 0) {
      monitorTabsSlider.classList.remove('visible');
      return;
    }
    monitorTabsSlider.classList.add('visible');
    const trackWidth = monitorTabsSlider.clientWidth;
    const thumbWidth = Math.max(24, (monitorTabs.clientWidth / monitorTabs.scrollWidth) * trackWidth);
    const maxLeft = Math.max(0, trackWidth - thumbWidth);
    const left = (monitorTabs.scrollLeft / overflow) * maxLeft;
    monitorTabsThumb.style.width = `${thumbWidth}px`;
    monitorTabsThumb.style.left = `${left}px`;
  }

  monitorTabs?.addEventListener('scroll', updateTabsSlider, { passive: true });
  window.addEventListener('resize', updateTabsSlider);

  if (monitorTabsSlider && monitorTabs) {
    let sliderDragging = false;
    const scrollBySlider = (clientX) => {
      const rect = monitorTabsSlider.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      monitorTabs.scrollLeft = ratio * (monitorTabs.scrollWidth - monitorTabs.clientWidth);
    };
    monitorTabsSlider.addEventListener('mousedown', (event) => {
      sliderDragging = true;
      monitorTabsSlider.classList.add('force-visible');
      if (monitorTabsThumb) { monitorTabsThumb.classList.add('dragging'); }
      scrollBySlider(event.clientX);
      event.preventDefault();
    });
    document.addEventListener('mousemove', (event) => {
      if (sliderDragging) { scrollBySlider(event.clientX); }
    });
    document.addEventListener('mouseup', () => {
      if (sliderDragging) {
        sliderDragging = false;
        monitorTabsSlider.classList.remove('force-visible');
        if (monitorTabsThumb) { monitorTabsThumb.classList.remove('dragging'); }
      }
    });
  }

  monitorAddBtn?.addEventListener('click', () => {
    vscode.postMessage({ type: 'addMonitor' });
  });

  // 将当前选定的监视器展开到编辑器区
  monitorExpandBtn?.addEventListener('click', () => {
    vscode.postMessage({ type: 'openMonitorInEditor', monitorId: activeMonitorId });
  });

  // 标题行双击重命名（与标签一致；`序号=` 前缀固定不可改）
  monitorNameTitle?.addEventListener('dblclick', () => {
    startTitleRename();
  });

  /** 提交重命名：未变化/为空只恢复显示；变化交给扩展广播（所有视口与标签页同步） */
  function submitRename(meta, value) {
    const next = String(value || '').trim();
    if (next && next !== meta.name) {
      vscode.postMessage({ type: 'renameMonitor', monitorId: meta.id, name: next });
      return;
    }
    renderMonitors();
  }

  /** 标题行内联重命名：仅编辑名称部分 */
  function startTitleRename() {
    const meta = activeMeta();
    if (!meta || !monitorNameTitle || titleRenameActive) { return; }

    titleRenameActive = true;
    monitorNameTitle.classList.add('is-renaming');
    monitorNameTitle.textContent = '';

    const index = document.createElement('span');
    index.className = 'monitor-title-index';
    index.textContent = `${meta.index}=`;

    const input = document.createElement('input');
    input.className = 'monitor-title-rename-input';
    input.type = 'text';
    input.value = meta.name;
    input.maxLength = 64;
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Monitor name');

    monitorNameTitle.appendChild(index);
    monitorNameTitle.appendChild(input);
    input.focus();
    input.select();

    let settled = false;
    const close = () => {
      settled = true;
      titleRenameActive = false;
      monitorNameTitle.classList.remove('is-renaming');
      renderMonitors();
    };
    const finish = () => {
      if (settled) { return; }
      const value = input.value;
      close();
      submitRename(meta, value);
    };

    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        finish();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        if (!settled) { close(); }
      }
    });
    input.addEventListener('blur', finish);
  }

  /** 标签内联重命名：Enter 确认 / Esc 取消 / 失焦回退 */
  function startTabRename(tab, meta) {
    if (tab.querySelector('.monitor-tab-rename-input')) { return; }
    const label = tab.querySelector('.monitor-tab-label');
    if (!label) { return; }
    const input = document.createElement('input');
    input.className = 'monitor-tab-rename-input';
    input.type = 'text';
    input.value = meta.name;
    input.maxLength = 64;
    label.replaceWith(input);
    input.focus();
    input.select();

    const commit = () => {
      submitRename(meta, input.value);
    };

    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        renderMonitors();
      }
    });
    input.addEventListener('blur', () => {
      commit();
    });
  }

  renderQuickCommands();
  updateHistorySelect();
  updateConnectionButtons();
  updateFreezeButton();
  updateEmptyState();
  renderMonitors();

  // 消息监听已就绪：请求扩展补发初始状态（早于脚本就绪的 postMessage 会丢失，
  // 表现为重启后标签栏空白、快捷指令不显示）
  vscode.postMessage({ type: 'ready' });
})();
