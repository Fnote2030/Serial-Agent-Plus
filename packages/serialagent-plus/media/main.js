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
  // 显示缓冲上限按 UTF-8 总字节数限制，大小来自后台配置项 serialagent.logBufferKB
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

  let quickCommands = /** @type {QuickCommand[]} */ ([]);
  let editingQuickCommandId = '';
  let frozenLog = false;
  let activeLogFilter = '';
  let normalSendHeight;
  let periodicTimer = null;

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
      statusText: 'Disconnected',
      statusConnected: false,
      statusPort: '',
      statusBaud: 0,
      statusParity: 'none',
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
    updateSendPlaceholder();
  }

  function saveState() {
    vscode.setState({
      sendText: sendInput?.value || '',
      hexSend: optHexSend?.checked || false,
      autoScroll: optAutoScroll?.checked || false,
      logFilter: logSearchInput?.value || '',
      frozenLog,
    });
  }

  function bindSerialActions() {
    refreshBtn?.addEventListener('click', () => {
      vscode.postMessage({ type: 'refreshPorts' });
    });

    monitorConnectBtn?.addEventListener('click', handleConnectionToggle);

    configToggleBtn?.addEventListener('click', () => {
      const collapsed = configDrawer?.classList.toggle('hidden');
      if (configToggleBtn) {
        // aria-expanded 驱动 .config-toggle-icon 的 ▸/▾ 两态（纯 CSS）
        configToggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      }
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
      handlePeriodicSendToggle();
      saveState();
      broadcastUiState();
    });

    // Echo 开关：跨视口同步
    optEcho?.addEventListener('change', () => {
      saveState();
      broadcastUiState();
    });

    periodicIntervalInput?.addEventListener('change', () => {
      clampPeriodicInterval();
      if (periodicTimer) {
        stopPeriodicSend();
        startPeriodicSend();
      }
      saveState();
      broadcastUiState();
    });

    // 滚轮微调数值只触发 input（无 change/blur），需 input 级防抖提交才能跨视口同步
    let cycleWheelTimer = null;
    periodicIntervalInput?.addEventListener('input', () => {
      if (cycleWheelTimer) { clearTimeout(cycleWheelTimer); }
      cycleWheelTimer = setTimeout(() => {
        clampPeriodicInterval();
        if (periodicTimer) {
          stopPeriodicSend();
          startPeriodicSend();
        }
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
        syncBaudratePreset();
        persistCurrentConfigDraft();
        updateMonitorConfigChips();
        broadcastUiState();
      });
    });
  }

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
      vscode.postMessage({
        type: 'saveLogToFile',
        lines: activeBucket().logEntries.map((entry) => entry.text.trimEnd()),
      });
    });
  }

  function bindSendActions() {
    optHexSend?.addEventListener('change', () => {
      updateSendPlaceholder();
      saveState();
      broadcastUiState();
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

    sendInput?.addEventListener('input', saveState);

    historyToggle?.addEventListener('click', () => {
      historyDropdown?.classList.toggle('open');
    });

    document.addEventListener('click', (event) => {
      if (historyDropdown && !historyDropdown.contains(/** @type {Node} */ (event.target))) {
        historyDropdown.classList.remove('open');
      }
    });
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

  function clampPeriodicInterval() {
    if (!periodicIntervalInput) {
      return;
    }
    const value = parseInt(periodicIntervalInput.value, 10);
    const clamped = Number.isFinite(value) ? Math.max(10, value) : 1000;
    periodicIntervalInput.value = String(clamped);
  }

  function handlePeriodicSendToggle() {
    if (!optPeriodicSend) {
      return;
    }
    if (optPeriodicSend.checked) {
      if (!activeBucket().connected) {
        optPeriodicSend.checked = false;
        return;
      }
      clampPeriodicInterval();
      startPeriodicSend();
    } else {
      stopPeriodicSend();
    }
  }

  // 周期发送绑定发起它的监视器：切换标签页不中断，回切时复选框恢复勾选
  let periodicMonitorId = null;

  function startPeriodicSend() {
    if (periodicTimer) {
      return;
    }
    periodicMonitorId = activeMonitorId;
    const interval = Math.max(10, parseInt(periodicIntervalInput?.value || '1000', 10) || 1000);
    periodicTimer = setInterval(() => {
      const bucket = bucketFor(periodicMonitorId);
      if (!bucket.connected) {
        stopPeriodicSend();
        syncPeriodicCheckbox();
        return;
      }
      doSendFor(periodicMonitorId, false);
    }, interval);
  }

  function stopPeriodicSend() {
    if (periodicTimer) {
      clearInterval(periodicTimer);
      periodicTimer = null;
    }
    periodicMonitorId = null;
  }

  function syncPeriodicCheckbox() {
    if (optPeriodicSend) {
      optPeriodicSend.checked = periodicTimer !== null && periodicMonitorId === activeMonitorId;
    }
  }

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
   * @param {{ port: string; baudRate: number; dataBits: number; parity: string; stopBits: number; flowControl?: string; lineEnding: string; showTimestamp: boolean; hexMode: boolean; encoding?: string; rxIdleWrapMs?: number }} config
   */
  function applyConfigToInputs(config) {
    if (portSelect) { portSelect.value = config.port || ''; }
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
  }

  // ---- 跨视口 UI 状态同步（侧边栏 ↔ 编辑器面板）----
  /** 收集当前视口的完整 UI 状态（显示选项 + 发送选项 + 视图选项 + 串口配置表单） */
  function collectUiState() {
    return {
      showTimestamp: !!optTimestamp?.checked,
      hexMode: !!optHex?.checked,
      lineEnding: lineEndingSelect?.value || 'none',
      encoding: encodingSelect?.value || 'utf8',
      rxIdleWrapMs: Math.max(1, parseInt(rxIdleWrapInput?.value || '20', 10) || 20),
      hexSend: !!optHexSend?.checked,
      periodicEnabled: !!optPeriodicSend?.checked,
      periodicInterval: Math.max(10, parseInt(periodicIntervalInput?.value || '1000', 10) || 1000),
      echo: !!optEcho?.checked,
      autoScroll: !!optAutoScroll?.checked,
      frozenLog,
      logFilter: logSearchInput?.value || '',
      config: collectCurrentConfig(),
    };
  }

  function broadcastUiState() {
    if (!activeMonitorId) { return; }
    const state = collectUiState();
    bucketFor(activeMonitorId).ui = state; // 本视口即时入桶
    vscode.postMessage({ type: 'uiStateChange', monitorId: activeMonitorId, state });
  }

  /** 应用另一视口同步来的 UI 状态（程序赋值不触发事件，无回环） */
  function applyUiStateSync(state) {
    if (!state) { return; }
    applySettingsToForm(state);
    if (optHexSend) { optHexSend.checked = !!state.hexSend; updateSendPlaceholder(); }
    // 周期发送只同步勾选/数值显示；定时器仅在发起视口运行（避免双发）
    if (optPeriodicSend) { optPeriodicSend.checked = !!state.periodicEnabled; }
    if (periodicIntervalInput && typeof state.periodicInterval === 'number') {
      periodicIntervalInput.value = String(state.periodicInterval);
    }
    if (optEcho) { optEcho.checked = !!state.echo; }
    if (optAutoScroll) { optAutoScroll.checked = !!state.autoScroll; }
    frozenLog = !!state.frozenLog;
    updateFreezeButton();
    if (typeof state.logFilter === 'string' && logSearchInput) {
      logSearchInput.value = state.logFilter;
      activeLogFilter = state.logFilter.trim().toLowerCase();
    }
    if (state.config) {
      applyConfigToInputs(state.config);
      const bucket = activeBucket();
      bucket.config = { ...(bucket.config || {}), ...state.config };
    }
    saveState();
    renderLogArea(true);
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
      const body = optTimestamp?.checked
        ? payload.split('\n').map((line) => `${formatLogTimestamp()} ${line}`).join('\n')
        : payload;
      appendLogEntry(`TX>> ${body}`, 'echo', monitorId);
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
        historyDropdown?.classList.remove('open');
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
    renderLogArea(); // 冻结/选中时内部自动跳过；非激活桶静默累积
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

  // 取消选中后立即补渲染选中期间累积的日志（不等下一次数据到达）
  let logAreaWasSelected = false;
  document.addEventListener('selectionchange', () => {
    const selected = logAreaHasSelection();
    if (logAreaWasSelected && !selected && !frozenLog) {
      renderLogArea();
    }
    logAreaWasSelected = selected;
  });

  function renderLogArea(force) {
    if (!logArea) {
      return;
    }
    // 冻结或正在选中日志文本时跳过重建：冻结应完全停住视图（数据仍持续累积，
    // 解冻后一次性刷新）；选中期间重建会丢失选区，导致 Ctrl+C 复制不到内容
    if (!force && (frozenLog || logAreaHasSelection())) {
      return;
    }

    logArea.innerHTML = '';

    const visibleEntries = getVisibleEntries();
    visibleEntries.forEach((entry) => {
      const line = document.createElement('div');
      line.className = entry.kind === 'echo' ? 'log-line log-echo' : 'log-line';
      line.textContent = entry.text;
      logArea.appendChild(line);
    });

    // 终端输入行与设备实时行合并为同一行：本地输入直接接在设备提示符后
    // （如 "msh > ls▌"）；状态来自扩展侧 TerminalSession 快照。
    // 设备实时行为空时回退 "> " 前缀
    const terminal = activeBucket().terminal;
    const liveLine = terminal.liveLine;
    const deviceLine = terminal.deviceLine;
    const before = terminal.buffer.slice(0, terminal.caret);
    const after = terminal.buffer.slice(terminal.caret);
    const caretText = `${before}\u258c${after}`;
    const liveDiv = document.createElement('div');
    liveDiv.className = 'log-line rx-live-line';
    if (!liveLine) {
      liveDiv.textContent = `> ${caretText}`;
    } else if (deviceLine !== null && liveLine.endsWith(deviceLine)) {
      liveDiv.textContent = liveLine.slice(0, -deviceLine.length) + caretText;
    } else if (deviceLine !== null) {
      // 同步态但实时行与同步命令不匹配（罕见分片）：信任设备行，光标置于行尾
      liveDiv.textContent = `${liveLine}\u258c`;
    } else {
      liveDiv.textContent = liveLine + caretText;
    }
    logArea.appendChild(liveDiv);

    updateEmptyState();
    if (optAutoScroll?.checked && !frozenLog) {
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
        const previousValue = portSelect.value || pendingPort;
        portSelect.innerHTML = '';

        const ports = message.ports || [];
        if (ports.length === 0) {
          const option = document.createElement('option');
          option.value = '';
          option.textContent = '-- No ports found --';
          portSelect.appendChild(option);
        } else {
          ports.forEach((port) => {
            const option = document.createElement('option');
            option.value = port.path;
            const label = formatPortLabel(port);
            option.textContent = label;
            option.title = buildPortTooltip(port);
            portSelect.appendChild(option);
          });
        }

        if (previousValue) {
          portSelect.value = previousValue;
          pendingPort = '';
        }
        break;
      }

      case 'updateStatus': {
        const id = message.monitorId;
        if (!id) { break; }
        const bucket = bucketFor(id);
        bucket.connected = !!message.connected;
        bucket.statusConnected = bucket.connected;
        bucket.statusPort = message.port || '';
        bucket.statusBaud = message.baudRate || 0;
        bucket.statusParity = message.parity || 'none';
        bucket.statusText = bucket.connected
          ? `${bucket.statusPort} @ ${bucket.statusBaud} ${PARITY_LABELS[bucket.statusParity] ?? PARITY_LABELS.none}`
          : 'Disconnected';
        if (!bucket.connected) {
          bucket.pendingSendAfterConnect = false;
          bucket.terminal = { liveLine: '', buffer: '', caret: 0, deviceLine: null };
          if (periodicTimer && periodicMonitorId === id) {
            // 周期发送的发起监视器断开：停止并同步复选框
            stopPeriodicSend();
            syncPeriodicCheckbox();
          }
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
        if (statusText) {
          statusText.textContent = bucket.statusText;
        }
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
        if (optAutoScroll?.checked && !frozenLog && message.monitorId === activeMonitorId) {
          scrollLogToBottom();
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
          renderLogArea();
          if (optAutoScroll?.checked && !frozenLog) {
            scrollLogToBottom();
          }
        }
        break;
      }

      case 'clearScreen': {
        if (!message.monitorId) { break; }
        const bucket = bucketFor(message.monitorId);
        bucket.logEntries = [];
        bucket.logEntriesBytes = 0;
        renderLogArea(true);
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

      case 'renameResult': {
        if (!message.ok && message.error) {
          vscode.postMessage({ type: 'monitorLimitReached', message: message.error });
        }
        // 成功时 monitorsChanged 会带新名称重渲染标签
        break;
      }

      case 'monitorLimitReached': {
        const text = message.message || 'Monitor limit reached';
        if (statusText) { statusText.textContent = text; }
        break;
      }

      case 'clearLog': {
        const id = message.monitorId || activeMonitorId;
        const bucket = bucketFor(id);
        bucket.logEntries = [];
        bucket.logEntriesBytes = 0;
        bucket.rxCount = 0;
        bucket.txCount = 0;
        if (id === activeMonitorId) {
          renderLogArea(true);
          if (rxCountEl) { rxCountEl.textContent = 'RX: 0'; }
          if (txCountEl) { txCountEl.textContent = 'TX: 0'; }
        }
        break;
      }

      case 'updateLogBuffer': {
        // 后台配置项 serialagent.logBufferKB 变化时由扩展推送
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
        applyUiState(message.uiState || {});
        updateEmptyState();
        break;
      }

    }
  });

  // ---- 多监视器标签栏 ----
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
    } else if (!restore) {
      // 新建监视器：自动切换到它
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
    // 保存当前发送框草稿与表单配置到旧桶
    if (activeMonitorId) {
      const oldBucket = bucketFor(activeMonitorId);
      if (sendInput) { oldBucket.sendDraft = sendInput.value; }
      oldBucket.config = collectCurrentConfig();
    }
    // 周期发送继续跑在原监视器上（切换不中断），复选框按"当前标签是否为发起者"显示
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
    if (statusDot) {
      statusDot.className = bucket.connected
        ? 'status-indicator status-connected'
        : 'status-indicator status-disconnected';
    }
    if (statusText) { statusText.textContent = bucket.statusText; }
    if (rxCountEl) { rxCountEl.textContent = 'RX: ' + formatBytes(bucket.rxCount); }
    if (txCountEl) { txCountEl.textContent = 'TX: ' + formatBytes(bucket.txCount); }
    [portSelect, baudratePresetSelect, baudrateInput, databitsSelect, paritySelect, stopbitsSelect, flowControlSelect].forEach((element) => {
      if (element) { element.disabled = bucket.connected; }
    });
    updateConnectionButtons();
    updateHistorySelect();
    updateSendControlsDisabled();
    syncPeriodicCheckbox();
    renderLogArea(true);
    renderMonitors();
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
      const next = input.value.trim();
      if (next && next !== meta.name) {
        vscode.postMessage({ type: 'renameMonitor', monitorId: meta.id, name: next });
        return; // 失败时 renameResult → statusText 提示，monitorsChanged 重渲染恢复标签
      }
      renderMonitors();
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
})();
