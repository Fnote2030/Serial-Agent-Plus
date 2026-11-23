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

  // @ts-ignore -- 由 media/terminal-device-line.js 提供（在本脚本之前加载）
  const TerminalDeviceLine = globalThis.TerminalDeviceLine;

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

  let connected = false;
  let pendingPort = '';
  let sendHistory = /** @type {string[]} */ ([]);
  let quickCommands = /** @type {QuickCommand[]} */ ([]);
  let editingQuickCommandId = '';
  let frozenLog = false;
  let logEntries = /** @type {LogEntry[]} */ ([]);
  let logEntriesBytes = 0;
  let activeLogFilter = '';
  let normalSendHeight;
  let periodicTimer = null;
  let pendingSendAfterConnect = false;
  let pendingTerminalLine = null;
  let terminalBuffer = '';
  let terminalCaret = 0;
  // 设备 shell 编辑缓冲当前持有的行（↑/↓ 历史或 Tab 补全 redraw 同步后非空，null 表示为空）。
  // Enter/Tab 发送前按它对齐，避免整行重发被设备追加成 "lsls"。
  let terminalDeviceLine = /** @type {string | null} */ (null);
  const rxSim = TerminalDeviceLine.createRxLineSimulator();
  const rxLine = rxSim.line;
  let tabSync = { active: false, sent: '' };
  let terminalHistory = [];
  let historySync = false;
  let historyRestore = null; // ↑/↓ 后等待 redraw 的快照；设备在历史边界不再重绘，超时恢复
  let historyRestoreTimer = null;
  const syncTimers = { tab: null, history: null };

  function cancelHistoryRestore() {
    if (historyRestoreTimer) { clearTimeout(historyRestoreTimer); historyRestoreTimer = null; }
    historyRestore = null;
  }

  // msh 在最旧历史条目再按 ↑ 时不再重绘（设备编辑行保持原内容，本地已清空）：
  // 200ms 内没有 redraw 同步则恢复按键前的本地输入行与设备行状态
  function restorePendingHistoryLine() {
    historyRestoreTimer = null;
    if (!historyRestore) { return; }
    terminalBuffer = historyRestore.buffer;
    terminalCaret = historyRestore.caret;
    terminalDeviceLine = historyRestore.deviceLine;
    historyRestore = null;
    renderLogArea();
  }

  // 同步去激活采用防抖：设备回显/redraw 分片多次到达，最后一次匹配后 200ms 才失效，
  // 避免回显分片触发过早同步后、redraw 分片再也无法修正。
  function scheduleSyncDeactivate(kind) {
    if (syncTimers[kind]) { clearTimeout(syncTimers[kind]); }
    syncTimers[kind] = setTimeout(() => {
      if (kind === 'tab') { tabSync.active = false; } else { historySync = false; }
      syncTimers[kind] = null;
    }, 200);
  }

  function clearSyncTimers() {
    if (syncTimers.tab) { clearTimeout(syncTimers.tab); syncTimers.tab = null; }
    if (syncTimers.history) { clearTimeout(syncTimers.history); syncTimers.history = null; }
    cancelHistoryRestore();
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
        terminalBuffer = '';
        terminalCaret = 0;
        terminalDeviceLine = null; // 设备收到 ^C 会丢弃编辑行
        cancelHistoryRestore();
        renderLogArea();
        sendTerminalBytes('\x03');
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      if (key === 'Enter') {
        event.preventDefault();
        handleTerminalEnter();
        return;
      }

      if (key === 'Tab') {
        event.preventDefault();
        handleTerminalTab();
        return;
      }

      if (key === 'Backspace') {
        event.preventDefault();
        terminalBackspace();
        return;
      }

      if (key === 'Delete') {
        event.preventDefault();
        terminalDelete();
        return;
      }

      if (key === 'ArrowLeft') {
        event.preventDefault();
        terminalMoveCaret(-1);
        return;
      }

      if (key === 'ArrowRight') {
        event.preventDefault();
        terminalMoveCaret(1);
        return;
      }

      if (key === 'Home') {
        event.preventDefault();
        terminalMoveCaretTo(0);
        return;
      }

      if (key === 'End') {
        event.preventDefault();
        terminalMoveCaretTo(terminalBuffer.length);
        return;
      }

      // ??????????
      const passthrough = terminalPassthroughBytes(key);
      if (passthrough !== null) {
        event.preventDefault();
        if (key === 'ArrowUp' || key === 'ArrowDown') {
          // 历史切换由设备 shell 接管：清空本地缓冲并等待 redraw 同步。
          // 连续按键且尚无 redraw 时保留最初的快照（最后一次稳定状态）
          if (!historyRestore) {
            historyRestore = { buffer: terminalBuffer, caret: terminalCaret, deviceLine: terminalDeviceLine };
          }
          if (historyRestoreTimer) { clearTimeout(historyRestoreTimer); }
          historyRestoreTimer = setTimeout(restorePendingHistoryLine, 200);
          terminalBuffer = '';
          terminalCaret = 0;
          tabSync.active = false;
          historySync = true;
          terminalDeviceLine = null; // 设备即将用历史条目替换编辑行，redraw 同步后再更新
          if (syncTimers.tab) { clearTimeout(syncTimers.tab); syncTimers.tab = null; }
          if (syncTimers.history) { clearTimeout(syncTimers.history); syncTimers.history = null; }
          renderLogArea();
        } else if (key === 'Escape') {
          terminalBuffer = '';
          terminalCaret = 0;
          renderLogArea();
        }
        sendTerminalBytes(passthrough);
        return;
      }

      // ????????????????????
      if (key.length === 1) {
        event.preventDefault();
        insertTerminalChar(key);
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
    });

    periodicIntervalInput?.addEventListener('change', () => {
      clampPeriodicInterval();
      if (periodicTimer) {
        stopPeriodicSend();
        startPeriodicSend();
      }
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

    optTimestamp?.addEventListener('change', () => {
      vscode.postMessage({ type: 'updateSettings', showTimestamp: optTimestamp.checked });
    });
    optHex?.addEventListener('change', () => {
      vscode.postMessage({ type: 'updateSettings', hexMode: optHex.checked });
    });
    lineEndingSelect?.addEventListener('change', () => {
      vscode.postMessage({ type: 'updateSettings', lineEnding: lineEndingSelect.value });
    });
    encodingSelect?.addEventListener('change', () => {
      vscode.postMessage({ type: 'updateSettings', encoding: encodingSelect.value });
    });

    rxIdleWrapInput?.addEventListener('change', () => {
      const value = Math.max(1, Math.min(60000, parseInt(rxIdleWrapInput.value, 10) || 20));
      rxIdleWrapInput.value = String(value);
      vscode.postMessage({ type: 'updateSettings', rxIdleWrapMs: value });
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
      });
    });
  }

  function updateMonitorConfigChips() {
    if (connected) {
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
    });

    optAutoScroll?.addEventListener('change', () => {
      if (optAutoScroll.checked && !frozenLog) {
        scrollLogToBottom();
      }
      saveState();
    });

    freezeBtn?.addEventListener('click', () => {
      frozenLog = !frozenLog;
      updateFreezeButton();
      if (!frozenLog) {
        renderLogArea(true); // 解冻：强制刷新，补上冻结期间累积的日志
      }
      saveState();
    });

    clearBtn?.addEventListener('click', () => {
      vscode.postMessage({ type: 'clearLog' });
      logEntries = [];
      logEntriesBytes = 0;
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
        lines: logEntries.map((entry) => entry.text.trimEnd()),
      });
    });
  }

  function bindSendActions() {
    optHexSend?.addEventListener('change', () => {
      updateSendPlaceholder();
      saveState();
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
    if (connected) {
      vscode.postMessage({ type: 'disconnect' });
      return;
    }

    const config = collectCurrentConfig();
    vscode.postMessage({ type: 'connect', ...config });
    vscode.postMessage({ type: 'saveConfig', config });
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
    if (monitorConnectBtn) {
      monitorConnectBtn.textContent = connected ? 'Close' : 'Open';
      monitorConnectBtn.classList.toggle('status-action-primary', !connected);
      monitorConnectBtn.classList.toggle('status-action-danger', connected);
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

  // ???????????????
  function terminalPassthroughBytes(key) {
    switch (key) {
      case 'Escape': return '\x1b';
      case 'ArrowUp': return '\x1b[A';
      case 'ArrowDown': return '\x1b[B';
      case 'PageUp': return '\x1b[5~';
      case 'PageDown': return '\x1b[6~';
    }
    return null;
  }

  function sendTerminalBytes(bytes) {
    if (!connected) {
      pendingTerminalLine = bytes;
      const config = collectCurrentConfig();
      vscode.postMessage({ type: 'connect', ...config });
      vscode.postMessage({ type: 'saveConfig', config });
      return;
    }
    // Terminal manages its own line endings (already included in bytes).
    vscode.postMessage({ type: 'sendData', text: bytes, hexSend: false, lineEnding: 'none' });
  }

  function insertTerminalChar(ch) {
    terminalBuffer = terminalBuffer.slice(0, terminalCaret) + ch + terminalBuffer.slice(terminalCaret);
    terminalCaret += ch.length;
    renderLogArea();
  }

  function terminalBackspace() {
    if (terminalCaret > 0) {
      terminalBuffer = terminalBuffer.slice(0, terminalCaret - 1) + terminalBuffer.slice(terminalCaret);
      terminalCaret -= 1;
      renderLogArea();
    }
  }

  function terminalDelete() {
    if (terminalCaret < terminalBuffer.length) {
      terminalBuffer = terminalBuffer.slice(0, terminalCaret) + terminalBuffer.slice(terminalCaret + 1);
      renderLogArea();
    }
  }

  function terminalMoveCaret(delta) {
    const next = terminalCaret + delta;
    if (next >= 0 && next <= terminalBuffer.length) {
      terminalCaret = next;
      renderLogArea();
    }
  }

  function terminalMoveCaretTo(position) {
    const clamped = Math.max(0, Math.min(terminalBuffer.length, position));
    if (clamped !== terminalCaret) {
      terminalCaret = clamped;
      renderLogArea();
    }
  }

  // Tab = 本地输入行 + \t 原子发送；随后监听设备 redraw，把补全结果同步回本地输入行。
  // 发送前按设备行对齐：设备已持有该行时只发 \t，本地改过则先退格清空设备行。
  function handleTerminalTab() {
    const line = terminalBuffer;
    if (line) {
      tabSync.active = true;
      tabSync.sent = line;
    }
    // 必须清掉上一次补全留下的去激活定时器：否则快速再按 Tab 时，
    // 旧定时器会把 tabSync 提前关闭，本次 redraw 同步失效，输入行永久为空
    if (syncTimers.tab) { clearTimeout(syncTimers.tab); syncTimers.tab = null; }
    historySync = false;
    cancelHistoryRestore();
    if (syncTimers.history) { clearTimeout(syncTimers.history); syncTimers.history = null; }
    terminalBuffer = '';
    terminalCaret = 0;
    renderLogArea();
    sendTerminalBytes(TerminalDeviceLine.reconcileBytes(terminalDeviceLine, line, '\t'));
    // 发送后设备编辑行持有本地行，等补全 redraw 到达再由 tabSync 覆盖
    terminalDeviceLine = line || null;
  }

  function pushTerminalHistory(line) {
    if (terminalHistory[0] === line) {
      return;
    }
    terminalHistory.unshift(line);
    if (terminalHistory.length > 50) {
      terminalHistory.pop();
    }
  }

  function handleTerminalEnter() {
    const line = terminalBuffer;
    terminalBuffer = '';
    terminalCaret = 0;
    tabSync.active = false;
    historySync = false;
    clearSyncTimers();
    renderLogArea();
    if (line.trim()) {
      pushTerminalHistory(line);
    }
    // 终端回车固定发送 CR（串口 shell 惯例，不受发送框 End 设置影响）。
    // 设备行已同步（↑/↓ 历史、Tab 补全 redraw）时不再整行重发，否则设备会把
    // 整行追加到自己的编辑缓冲，出现 "ls" -> "lsls" -> "lslsls"；本地改过则先清空设备行。
    sendTerminalBytes(TerminalDeviceLine.reconcileBytes(terminalDeviceLine, line, '\r'));
    terminalDeviceLine = null;
  }

  // RX 行模拟器：设备回显/重绘中的控制字符与 CSI 序列由共享模块的模拟器按语义解释
  // （\b/\r/\n、ESC[2K 整行擦除、ESC[K 行尾擦除、ESC[nD/C 光标移动等），
  // 详见 media/terminal-device-line.js。
  function feedRx(raw) {
    for (const text of rxSim.feed(raw)) {
      // Timestamp 选项由 webview 在显示行提交时统一加前缀；
      // manager 侧的时间戳只进日志缓冲/MCP 通道，不再混入数据流
      appendLogEntry(optTimestamp?.checked ? `${formatLogTimestamp()} ${text}` : text, 'text');
    }

    // Tab 补全同步：设备 redraw 行包含发送前的缓冲时，把补全后的完整行同步回本地输入行
    if (tabSync.active && rxLine.text.includes(tabSync.sent)) {
      terminalBuffer = rxLine.text.slice(rxLine.text.indexOf(tabSync.sent));
      terminalCaret = terminalBuffer.length;
      terminalDeviceLine = terminalBuffer; // 设备编辑缓冲此刻持有补全后的整行
      scheduleSyncDeactivate('tab');
      renderLogArea();
    }

    // 上下键历史同步：设备 redraw 行以历史命令结尾时（最长匹配），同步回本地输入行
    if (historySync) {
      let best = null;
      for (const cmd of terminalHistory) {
        if (cmd && rxLine.text.endsWith(cmd) && (best === null || cmd.length > best.length)) {
          best = cmd;
        }
      }
      if (best !== null) {
        cancelHistoryRestore(); // redraw 已确认，不需要边界恢复
        terminalBuffer = best;
        terminalCaret = best.length;
        terminalDeviceLine = best; // 设备编辑缓冲此刻持有召回的历史行
        scheduleSyncDeactivate('history');
        renderLogArea();
      }
    }

    renderLogArea();
    if (optAutoScroll?.checked && !frozenLog) {
      scrollLogToBottom();
    }
  }

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
      if (!connected) {
        optPeriodicSend.checked = false;
        return;
      }
      clampPeriodicInterval();
      startPeriodicSend();
    } else {
      stopPeriodicSend();
    }
  }

  function startPeriodicSend() {
    if (periodicTimer) {
      return;
    }
    const interval = Math.max(10, parseInt(periodicIntervalInput?.value || '1000', 10) || 1000);
    periodicTimer = setInterval(() => {
      if (connected) {
        doSend(false);
      }
    }, interval);
  }

  function stopPeriodicSend() {
    if (periodicTimer) {
      clearInterval(periodicTimer);
      periodicTimer = null;
    }
  }

  function updateSendControlsDisabled() {
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

  function persistCurrentConfigDraft() {
    vscode.postMessage({ type: 'saveConfig', config: collectCurrentConfig() });
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
      button.disabled = !connected;
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
    const text = sendInput?.value || '';
    if (!text.trim()) {
      return;
    }
    if (!connected) {
      pendingSendAfterConnect = true;
      const config = collectCurrentConfig();
      vscode.postMessage({ type: 'connect', ...config });
      vscode.postMessage({ type: 'saveConfig', config });
      return;
    }
    sendData(text, !!optHexSend?.checked);
    if (selectAfterSend) {
      sendInput?.select();
    }
  }

  function sendData(text, hexSend) {
    if (!connected) {
      return;
    }
    const payload = hexSend ? text : unescapeSendText(text);
    vscode.postMessage({ type: 'sendData', text: payload, hexSend });

    if (optEcho?.checked) {
      const body = optTimestamp?.checked
        ? payload.split('\n').map((line) => `${formatLogTimestamp()} ${line}`).join('\n')
        : payload;
      appendLogEntry(`TX>> ${body}`, 'echo');
    }

    const historyIndex = sendHistory.indexOf(text);
    if (historyIndex !== -1) {
      sendHistory.splice(historyIndex, 1);
    }
    sendHistory.unshift(text);
    if (sendHistory.length > MAX_HISTORY) {
      sendHistory.pop();
    }
    updateHistorySelect();
    vscode.postMessage({ type: 'saveSendHistory', history: sendHistory });
    saveState();
  }

  function updateHistorySelect() {
    if (!historyMenu) {
      return;
    }

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
        vscode.postMessage({ type: 'saveSendHistory', history: sendHistory });
      });

      row.appendChild(textSpan);
      row.appendChild(deleteBtn);
      historyMenu.appendChild(row);
    });
  }

  function appendLogEntry(text, kind) {
    logEntries.push({ text, kind });
    logEntriesBytes += utf8ByteLength(text);
    // 总字节数上限（Buffer KB 配置），从最旧端丢弃（至少保留最新一条）
    while (logEntries.length > 1 && logEntriesBytes > logRenderBytesLimit()) {
      logEntriesBytes -= utf8ByteLength(logEntries[0].text);
      logEntries.shift();
    }
    renderLogArea(); // 冻结/选中时内部自动跳过
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
    // （如 "msh > ls▌"）；历史/Tab 同步后设备行已包含命令，只在剩余部分上
    // 叠加输入与光标，避免出现两条内容不一致的行。设备实时行为空时回退 "> " 前缀
    const before = terminalBuffer.slice(0, terminalCaret);
    const after = terminalBuffer.slice(terminalCaret);
    const caretText = `${before}\u258c${after}`;
    const liveDiv = document.createElement('div');
    liveDiv.className = 'log-line rx-live-line';
    if (!rxLine.text) {
      liveDiv.textContent = `> ${caretText}`;
    } else if (terminalDeviceLine !== null && rxLine.text.endsWith(terminalDeviceLine)) {
      liveDiv.textContent = rxLine.text.slice(0, -terminalDeviceLine.length) + caretText;
    } else if (terminalDeviceLine !== null) {
      // 同步态但实时行与同步命令不匹配（罕见分片）：信任设备行，光标置于行尾
      liveDiv.textContent = `${rxLine.text}\u258c`;
    } else {
      liveDiv.textContent = rxLine.text + caretText;
    }
    logArea.appendChild(liveDiv);

    updateEmptyState();
    if (optAutoScroll?.checked && !frozenLog) {
      scrollLogToBottom();
    }
  }

  function getVisibleEntries() {
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
        connected = !!message.connected;
        if (statusDot) {
          statusDot.className = connected
            ? 'status-indicator status-connected'
            : 'status-indicator status-disconnected';
        }
        if (statusText) {
          statusText.textContent = connected
            ? `${message.port} @ ${message.baudRate} ${PARITY_LABELS[message.parity] ?? PARITY_LABELS.none}`
            : 'Disconnected';
        }
        updateConnectionButtons();

        [portSelect, baudratePresetSelect, baudrateInput, databitsSelect, paritySelect, stopbitsSelect, flowControlSelect].forEach((element) => {
          if (element) { element.disabled = connected; }
        });
        if (!connected) {
          pendingSendAfterConnect = false;
          pendingTerminalLine = null;
          tabSync.active = false;
          historySync = false;
          terminalDeviceLine = null; // 断开后设备编辑行状态未知，按为空处理
          clearSyncTimers();
          stopPeriodicSend();
          if (optPeriodicSend) { optPeriodicSend.checked = false; }
        }
        if (connected && pendingSendAfterConnect) {
          pendingSendAfterConnect = false;
          doSend();
        }
        if (!connected) {
          pendingTerminalLine = null;
        }
        if (connected && pendingTerminalLine !== null) {
          const bytes = pendingTerminalLine;
          pendingTerminalLine = null;
          // 终端字节自带行尾，与立即发送路径一致显式 none，避免 End 选项追加换行
          vscode.postMessage({ type: 'sendData', text: bytes, hexSend: false, lineEnding: 'none' });
        }
        updateSendControlsDisabled();
        updateEmptyState();
        break;
      }

      case 'appendLog': {
        const raw = String(message.text || '');
        // ANSI clear screen (device response to commands like `clear`)
        if (/\u001b\[2J/.test(raw)) {
          logEntries = [];
          logEntriesBytes = 0;
          rxSim.reset();
        }
        // 只剥 OSC（窗口标题等）；CSI 序列保留给行模拟器按语义应用——
        // 若像之前一样全部剥掉，msh 历史切换的 ESC[2K 会被丢弃，redraw 覆盖后
        // 日志行残留旧命令尾巴（"help" 切 "ls" 显示成 "lsls"残迹/"lslp"）
        const cleaned = raw.replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, '');
        if (cleaned.includes('MCP TX>> ')) {
          appendLogEntry(cleaned.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trimEnd(), 'echo');
        } else {
          feedRx(cleaned);
        }
        break;
      }

      case 'clearLog': {
        logEntries = [];
        logEntriesBytes = 0;
        rxSim.reset();
        terminalBuffer = '';
        terminalCaret = 0;
        tabSync.active = false;
        historySync = false;
        terminalDeviceLine = null;
        clearSyncTimers();
        renderLogArea(true);
        if (rxCountEl) { rxCountEl.textContent = 'RX: 0'; }
        if (txCountEl) { txCountEl.textContent = 'TX: 0'; }
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
        if (rxCountEl) { rxCountEl.textContent = 'RX: ' + formatBytes(message.rx); }
        if (txCountEl) { txCountEl.textContent = 'TX: ' + formatBytes(message.tx); }
        break;
      }

      case 'restoreConfig': {
        const config = message.config;
        if (config) {
          applyConfigToInputs(config);
          if (config.port) {
            pendingPort = config.port;
          }
        }

        if (Array.isArray(message.sendHistory)) {
          sendHistory = message.sendHistory;
          updateHistorySelect();
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

  renderQuickCommands();
  updateHistorySelect();
  updateConnectionButtons();
  updateFreezeButton();
  updateEmptyState();
})();
