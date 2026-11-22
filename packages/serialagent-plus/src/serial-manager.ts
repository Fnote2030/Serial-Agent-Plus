import { execFile } from 'child_process';
import { ListPortsOptions, PortInfo, SerialConfig, DEFAULT_CONFIG, ISerialManager } from './types';
import { decodeSerialText, encodeSerialText } from './text-codec';

type SerialPortClass = import('serialport').SerialPort;
type SerialPortStatic = typeof import('serialport').SerialPort;

let cachedSerialPort: SerialPortStatic | null = null;
let serialportError: string | null = null;

// 日志缓冲上限按 总字节数 限制（Save Log / MCP read_serial_log 的回看量），
// 大小由 logBufferKB 配置（默认 1024KB，最大 10240KB），超限从最旧端丢弃
const LOG_BUFFER_KB_LIMIT = 10240;
const MAX_RX_BUFFER = 1024 * 1024;
const RECONNECT_INTERVAL_MS = 2000;
const PORT_METADATA_TIMEOUT_MS = 3000;
const DEFAULT_METADATA_CACHE_MS = 30_000;
// Unterminated RX (prompt / redraw output) is flushed after this idle delay so
// terminal redraws reach the UI immediately instead of waiting for a newline.
const RX_PARTIAL_FLUSH_MS = 20;

let cachedWindowsMetadata: Map<string, WindowsPortMetadata> | null = null;
let cachedWindowsMetadataAt = 0;

interface RawSerialPortInfo {
  path: string;
  manufacturer?: string;
  productId?: string;
  vendorId?: string;
  serialNumber?: string;
  pnpId?: string;
  friendlyName?: string;
}

interface WindowsPortMetadata {
  path: string;
  friendlyName?: string;
  driverLabel?: string;
  pnpId?: string;
}

export interface SerialManagerCallbacks {
  onLog: (text: string) => void;
  onStatus: (connected: boolean, portPath?: string, baudRate?: number) => void;
  onError: (msg: string) => void;
  onCounterUpdate?: (rx: number, tx: number) => void;
}

export interface SerialRuntime extends ISerialManager {
  setCallbacks(opts: SerialManagerCallbacks): void;
  updateSettings(partial: Partial<SerialConfig>): void;
}

function requireSerialPort(): SerialPortStatic | null {
  if (cachedSerialPort) { return cachedSerialPort; }
  if (serialportError) { return null; }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sp = require('serialport') as { SerialPort: SerialPortStatic };
    cachedSerialPort = sp.SerialPort;
    return cachedSerialPort;
  } catch (error: unknown) {
    serialportError = error instanceof Error ? error.message : String(error);
    return null;
  }
}

export class SerialManager implements SerialRuntime {
  private _port: SerialPortClass | null = null;
  private _logBuffer: string[] = [];
  private _logBufferBytes = 0;
  private _rxBuffer: Buffer = Buffer.alloc(0);
  private _config: SerialConfig = { ...DEFAULT_CONFIG };
  private _rxFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private _rxWrapTimer: ReturnType<typeof setTimeout> | null = null;
  // HEX 空闲换行的累积状态（文本模式不换行，保持实时行）
  private _hexPending = '';
  private _hexSentLen = 0;

  private _rxBytes = 0;
  private _txBytes = 0;

  private _onLog: ((text: string) => void) | null = null;
  private _onStatus: ((connected: boolean, portPath?: string, baudRate?: number) => void) | null = null;
  private _onError: ((msg: string) => void) | null = null;
  private _onCounterUpdate: ((rx: number, tx: number) => void) | null = null;

  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _autoReconnect = false;
  private _reconnecting = false;
  private _lastConfig: SerialConfig | null = null;

  private _newLogSubscribers: Array<(line: string) => void> = [];

  setCallbacks(opts: SerialManagerCallbacks): void {
    this._onLog = opts.onLog;
    this._onStatus = opts.onStatus;
    this._onError = opts.onError;
    this._onCounterUpdate = opts.onCounterUpdate ?? null;
  }

  async listPorts(options?: ListPortsOptions): Promise<PortInfo[]> {
    const serialPort = requireSerialPort();
    if (!serialPort) {
      throw new Error(
        `serialport native module load failed: ${serialportError}\nPlease check extension is properly installed (with prebuilt binaries)`,
      );
    }
    const ports = await serialPort.list() as RawSerialPortInfo[];
    const metadataMode = options?.metadata ?? 'full';

    if (metadataMode === 'skip') {
      return mapRawPorts(ports, new Map());
    }

    const windowsMetadata = await loadWindowsPortMetadata({
      force: options?.forceMetadata === true,
    });
    return mapRawPorts(ports, windowsMetadata);
  }

  async connect(config: SerialConfig): Promise<boolean> {
    this._stopReconnect();
    if (this._port?.isOpen) { await this.disconnect(); }

    this._config = { ...config };
    this._lastConfig = { ...config };

    return new Promise<boolean>((resolve) => {
      try {
        const serialPort = requireSerialPort();
        if (!serialPort) {
          this._onError?.(`serialport native module load failed: ${serialportError}`);
          this._onStatus?.(false);
          resolve(false);
          return;
        }

        const flowControl = config.flowControl ?? 'none';
        this._port = new serialPort({
          path: config.port,
          baudRate: config.baudRate,
          dataBits: config.dataBits,
          stopBits: config.stopBits,
          parity: config.parity,
          rtscts: flowControl === 'rtscts',
          xon: flowControl === 'xon',
          xoff: flowControl === 'xoff',
          autoOpen: false,
        });

        this._port.on('data', (chunk: Buffer) => {
          this._rxBytes += chunk.length;
          this._onCounterUpdate?.(this._rxBytes, this._txBytes);
          this._processReceivedData(chunk);
        });

        this._port.on('error', (err: Error) => {
          this._onError?.(err.message);
        });

        this._port.on('close', () => {
          const wasAutoReconnect = this._autoReconnect;
          this._cleanupPort();
          this._onStatus?.(false);
          if (wasAutoReconnect && this._lastConfig) {
            this._startReconnect();
          }
        });

        this._port.open((err) => {
          if (err) {
            this._onError?.(`Open failed: ${err.message}`);
            this._cleanupPort();
            this._onStatus?.(false);
            resolve(false);
          } else {
            this._autoReconnect = true;
            this._onStatus?.(true, config.port, config.baudRate);
            resolve(true);
          }
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this._onError?.(`Connect error: ${message}`);
        this._cleanupPort();
        this._onStatus?.(false);
        resolve(false);
      }
    });
  }

  async disconnect(): Promise<void> {
    this._autoReconnect = false;
    this._stopReconnect();
    this._clearRxPartialFlush();
    return new Promise<void>((resolve) => {
      if (this._port?.isOpen) {
        this._port.removeAllListeners('close');
        this._port.close(() => {
          this._cleanupPort();
          this._onStatus?.(false);
          resolve();
        });
      } else {
        this._cleanupPort();
        this._onStatus?.(false);
        resolve();
      }
    });
  }

  async send(data: string, hexMode: boolean, lineEnding: string): Promise<boolean> {
    if (!this._port?.isOpen) { return false; }

    let buffer: Buffer;
    if (hexMode) {
      const hexStr = data.replace(/\s+/g, '');
      if (!hexStr.length || !/^[0-9a-fA-F]*$/.test(hexStr) || hexStr.length % 2 !== 0) {
        this._onError?.('Invalid HEX format (e.g. "41 42 0D 0A")');
        return false;
      }
      buffer = Buffer.from(hexStr, 'hex');
    } else {
      // Empty text is allowed so a terminal empty Enter still sends the line-ending suffix.
      const suffixes: Record<string, string> = { lf: '\n', crlf: '\r\n', cr: '\r', none: '' };
      buffer = encodeSerialText(data + (suffixes[lineEnding] ?? '\n'), this._config.encoding);
    }

    return new Promise<boolean>((resolve) => {
      this._port!.write(buffer, (err) => {
        if (err) {
          this._onError?.(err.message);
          resolve(false);
          return;
        }
        this._txBytes += buffer.length;
        this._onCounterUpdate?.(this._rxBytes, this._txBytes);
        resolve(true);
      });
    });
  }

  updateSettings(partial: Partial<SerialConfig>): void {
    if (partial.hexMode === true && !this._config.hexMode) {
      // 文本 → HEX：先按文本提交未完行
      this._clearRxWrap();
      if (this._rxBuffer.length > 0) {
        this._flushPendingRx();
        const flushed = this._logBuffer[this._logBuffer.length - 1] ?? '';
        if (flushed) {
          const popped = this._logBuffer.pop();
          if (popped !== undefined) { this._logBufferBytes -= Buffer.byteLength(popped, 'utf8'); }
          this._commitWrappedLine(flushed);
        }
      }
    } else if (partial.hexMode === false && this._config.hexMode) {
      // HEX → 文本：提交累积的 HEX 行
      this._clearRxWrap();
      this._clearRxPartialFlush();
      if (this._hexPending) {
        const line = this._hexPending;
        this._hexPending = '';
        this._hexSentLen = 0;
        this._commitWrappedLine(line);
      }
    }
    Object.assign(this._config, partial);
  }

  get isConnected(): boolean { return this._port !== null && this._port.isOpen; }
  get isReconnecting(): boolean { return this._reconnectTimer !== null || this._reconnecting; }
  get currentPath(): string { return this._config.port; }
  get currentBaudRate(): number { return this._config.baudRate; }
  get config(): SerialConfig { return { ...this._config }; }
  get rxBytes(): number { return this._rxBytes; }
  get txBytes(): number { return this._txBytes; }

  getLogBuffer(): string[] { return [...this._logBuffer]; }
  clearLog(): void { this._logBuffer = []; this._logBufferBytes = 0; }

  resetCounters(): void {
    this._rxBytes = 0;
    this._txBytes = 0;
    this._onCounterUpdate?.(0, 0);
  }

  injectLog(line: string): void {
    this._appendLogLine(line);
  }

  injectTxLog(data: string): void {
    const prefix = this._config.showTimestamp ? `${this._createLogTimestamp()} ` : '';
    const body = String(data).split('\n').map((line) => `${prefix}MCP TX>> ${line}`).join('\n');
    this._appendLogLine(body);
  }

  private _createLogTimestamp(): string {
    const now = new Date();
    return `[${now.toTimeString().split(' ')[0]}.${String(now.getMilliseconds()).padStart(3, '0')}]`;
  }

  onNewLog(callback: (line: string) => void): void {
    this._newLogSubscribers.push(callback);
  }

  offNewLog(callback: (line: string) => void): void {
    const idx = this._newLogSubscribers.indexOf(callback);
    if (idx !== -1) { this._newLogSubscribers.splice(idx, 1); }
  }

  /** 追加一条日志并按总字节数上限裁剪最旧条目（至少保留最新一条） */
  private _pushLogBuffer(line: string): void {
    this._logBuffer.push(line);
    this._logBufferBytes += Buffer.byteLength(line, 'utf8');
    while (this._logBuffer.length > 1 && this._logBufferBytes > this._logBufferLimitBytes()) {
      this._logBufferBytes -= Buffer.byteLength(this._logBuffer[0], 'utf8');
      this._logBuffer.shift();
    }
  }

  private _logBufferLimitBytes(): number {
    const kb = Math.floor(this._config.logBufferKB);
    return Math.max(1, Math.min(LOG_BUFFER_KB_LIMIT, kb || 1024)) * 1024;
  }

  private _appendLogLine(line: string, webviewLine?: string): void {
    this._pushLogBuffer(line);
    // webview 通道可携带无时间戳装饰的原始行（webview 自行在显示行提交时加时间戳）
    this._onLog?.((webviewLine ?? line) + '\n');
    for (const callback of this._newLogSubscribers) {
      callback(line);
    }
  }

  private _processReceivedData(chunk: Buffer): void {
    if (this._config.hexMode) {
      // HEX 模式：字节累积到当前行，空闲超过 rxIdleWrapMs 才换行提交，
      // 20ms 部分刷新先行送出增量（webview 实时行 / MCP 订阅可见）
      if (chunk.length > 0) {
        const hex = Array.from(chunk)
          .map((byte) => byte.toString(16).padStart(2, '0').toUpperCase())
          .join(' ');
        this._hexPending = this._hexPending ? `${this._hexPending} ${hex}` : hex;
      }
      // 单行保护：持续数据流会不断推迟空闲换行，超限时强制提交一行，
      // 与文本路径的 MAX_RX_BUFFER 兜底一致，避免 _hexPending 无限增长
      if (this._hexPending.length > MAX_RX_BUFFER) {
        this._clearRxWrap();
        this._wrapPendingRx();
        return;
      }
      this._scheduleRxPartialFlush();
      this._scheduleRxWrap();
      return;
    }

    this._rxBuffer = Buffer.concat([this._rxBuffer, chunk]);
    if (this._rxBuffer.length > MAX_RX_BUFFER) {
      const overflow = decodeSerialText(this._rxBuffer, this._config.encoding);
      this._appendLogLine(`[WARN] RX buffer overflow (${MAX_RX_BUFFER} bytes), force flushing`);
      this._appendLogLine(overflow);
      this._rxBuffer = Buffer.alloc(0);
    }

    // Schedule a partial-line flush: prompt/redraw output has no trailing newline,
    // without this it would sit in the buffer until the next newline arrives.
    this._scheduleRxPartialFlush();

    let idx: number;
    while ((idx = this._rxBuffer.indexOf(0x0A)) !== -1) {
      const lineBytes = this._rxBuffer.subarray(0, idx);
      this._rxBuffer = this._rxBuffer.subarray(idx + 1);

      let text = decodeSerialText(lineBytes, this._config.encoding);
      if (text.endsWith('\r')) { text = text.slice(0, -1); }

      if (this._config.showTimestamp) {
        // 时间戳只写入日志缓冲 / MCP 订阅通道；发给 webview 的是原始行。
        // webview 的行模拟器要把提示符、回显、redraw 拼接成同一显示行，
        // 若把 "[hh:mm:ss.mmm] " 混进数据流，回车后的空行也会带时间戳，
        // 恰好插在命令回显和输出之间（如 "msh > ls[04:36:06.078]"）。
        this._appendLogLine(`${this._createLogTimestamp()} ${text}`, text);
      } else {
        this._appendLogLine(text);
      }
    }

    // Everything drained by complete lines - cancel the pending partial flush.
    // 文本模式不做空闲换行：无 \r\n 的数据（提示符/回显/redraw）一直留在实时行，
    // 只有 HEX 显示模式使用 rxIdleWrapMs 空闲换行。
    if (this._rxBuffer.length === 0) {
      this._clearRxPartialFlush();
      this._clearRxWrap();
    }
  }

  private _scheduleRxPartialFlush(): void {
    if (this._rxFlushTimer) { clearTimeout(this._rxFlushTimer); }
    this._rxFlushTimer = setTimeout(() => this._flushPendingRx(), RX_PARTIAL_FLUSH_MS);
  }

  private _clearRxPartialFlush(): void {
    if (this._rxFlushTimer) {
      clearTimeout(this._rxFlushTimer);
      this._rxFlushTimer = null;
    }
  }

  private _scheduleRxWrap(): void {
    if (this._rxWrapTimer) { clearTimeout(this._rxWrapTimer); }
    this._rxWrapTimer = setTimeout(() => this._wrapPendingRx(), this._idleWrapMs());
  }

  private _clearRxWrap(): void {
    if (this._rxWrapTimer) {
      clearTimeout(this._rxWrapTimer);
      this._rxWrapTimer = null;
    }
  }

  private _idleWrapMs(): number {
    return Math.max(1, Math.floor(this._config.rxIdleWrapMs) || 20);
  }

  /** 分发缓冲中的未完行（无换行结尾）：webview 将其保留在实时显示行中继续拼接 */
  private _flushPendingRx(): void {
    this._rxFlushTimer = null;
    if (this._config.hexMode) {
      if (this._hexPending.length > this._hexSentLen) {
        const delta = this._hexPending.slice(this._hexSentLen);
        this._hexSentLen = this._hexPending.length;
        // 增量只发 webview/订阅通道，不进日志缓冲：提交时整行写入，
        // 避免分片与完整行并存（MCP 回显行插入分片间时）造成 Save/MCP 回看重复
        this._onLog?.(delta);
        for (const callback of this._newLogSubscribers) {
          callback(delta);
        }
      }
      return;
    }
    if (this._rxBuffer.length === 0) { return; }
    const text = decodeSerialText(this._rxBuffer, this._config.encoding);
    this._rxBuffer = Buffer.alloc(0);
    this._appendPartialLine(text);
  }

  /**
   * 空闲换行（仅 HEX 显示模式）：字节间隔超过 rxIdleWrapMs 时提交当前 HEX 行。
   * 文本模式不适用——无 \r\n 的行（提示符/回显）需保持实时显示。
   */
  private _wrapPendingRx(): void {
    this._rxWrapTimer = null;
    this._flushPendingRx(); // 先送出剩余增量，保证 webview 实时行完整
    if (this._config.hexMode && this._hexPending) {
      const line = this._hexPending;
      this._hexPending = '';
      this._hexSentLen = 0;
      this._commitWrappedLine(line);
    }
  }

  /** 提交一条空闲换行行：合并此前 partial 刷入的尾部缓冲条目，避免日志重复 */
  private _commitWrappedLine(line: string): void {
    // 尾部 partial 条目逐条拼接应恰为该行：替换为带时间戳的完整行
    let merged = '';
    let removeCount = 0;
    for (let i = this._logBuffer.length - 1; i >= 0 && merged.length < line.length; i--) {
      merged = this._logBuffer[i] + merged;
      removeCount++;
    }
    if (merged === line) {
      const removed = this._logBuffer.splice(this._logBuffer.length - removeCount, removeCount);
      for (const entry of removed) { this._logBufferBytes -= Buffer.byteLength(entry, 'utf8'); }
    }
    const tsLine = this._config.showTimestamp ? `${this._createLogTimestamp()} ${line}` : line;
    this._pushLogBuffer(tsLine);
    // webview 已通过 partial 收到全部文本，仅补一个换行提交显示行
    this._onLog?.('\n');
    for (const callback of this._newLogSubscribers) {
      callback(tsLine);
    }
  }

  private _appendPartialLine(text: string): void {
    this._pushLogBuffer(text);
    // 注意：不带结尾换行，webview 端将其保留在 in-progress 行中
    this._onLog?.(text);
    for (const callback of this._newLogSubscribers) {
      callback(text);
    }
  }

  private _cleanupPort(): void {
    this._clearRxPartialFlush();
    this._clearRxWrap();
    this._hexPending = '';
    this._hexSentLen = 0;
    if (this._port) {
      this._port.removeAllListeners();
      this._port = null;
    }
    this._rxBuffer = Buffer.alloc(0);
  }

  private _startReconnect(): void {
    if (this._reconnectTimer || this._reconnecting) { return; }
    this._onError?.('Connection lost, attempting to reconnect...');
    this._scheduleReconnect();
  }

  private _scheduleReconnect(): void {
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (!this._autoReconnect || !this._lastConfig) { return; }
      this._reconnecting = true;
      try {
        const ports = await this.listPorts();
        if (ports.some((port) => port.path === this._lastConfig!.port)) {
          const ok = await this.connect(this._lastConfig!);
          if (ok) {
            this._onLog?.('[Serial Agent Plus] Reconnected successfully\n');
            this._reconnecting = false;
            return;
          }
        }
      } catch {
        // Keep trying on the next reconnect tick.
      }
      this._reconnecting = false;
      if (this._autoReconnect && this._lastConfig) {
        this._scheduleReconnect();
      }
    }, RECONNECT_INTERVAL_MS);
  }

  private _stopReconnect(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnecting = false;
  }
}

export function portPathsFingerprint(ports: PortInfo[]): string {
  return ports
    .map((port) => port.path)
    .sort((a, b) => a.localeCompare(b))
    .join('\0');
}

export function portsContentFingerprint(ports: PortInfo[]): string {
  return ports
    .map((port) => [
      port.path,
      port.friendlyName ?? '',
      port.driverLabel ?? '',
      port.vendorId ?? '',
      port.productId ?? '',
      port.manufacturer ?? '',
    ].join('|'))
    .sort((a, b) => a.localeCompare(b))
    .join('\0');
}

function mapRawPorts(
  ports: RawSerialPortInfo[],
  windowsMetadata: Map<string, WindowsPortMetadata>,
): PortInfo[] {
  return ports.map((port) => {
    const metadata = windowsMetadata.get(port.path.toUpperCase());
    return {
      path: port.path,
      manufacturer: port.manufacturer,
      productId: port.productId,
      vendorId: port.vendorId,
      serialNumber: port.serialNumber,
      pnpId: port.pnpId ?? metadata?.pnpId,
      friendlyName: port.friendlyName ?? metadata?.friendlyName,
      driverLabel: metadata?.driverLabel ?? normalizeDriverLabel(port.friendlyName),
    };
  });
}

function normalizeDriverLabel(label?: string): string | undefined {
  if (!label) {
    return undefined;
  }

  const normalized = label
    .replace(/\s*\((COM\d+)\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized.length > 0 ? normalized : undefined;
}

async function loadWindowsPortMetadata(options?: {
  force?: boolean;
  maxAgeMs?: number;
}): Promise<Map<string, WindowsPortMetadata>> {
  if (process.platform !== 'win32') {
    return new Map();
  }

  const maxAgeMs = options?.maxAgeMs ?? DEFAULT_METADATA_CACHE_MS;
  if (
    !options?.force
    && cachedWindowsMetadata
    && Date.now() - cachedWindowsMetadataAt < maxAgeMs
  ) {
    return cachedWindowsMetadata;
  }

  const powershell = process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe';
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$items = Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match "\\((COM\\d+)\\)" } | ForEach-Object {',
    '  [pscustomobject]@{',
    '    path = $Matches[1].ToUpper()',
    '    friendlyName = $_.Name',
    '    driverLabel = ($_.Name -replace "\\s*\\(COM\\d+\\)\\s*$", "").Trim()',
    '    pnpId = $_.PNPDeviceID',
    '  }',
    '}',
    '$items | ConvertTo-Json -Compress',
  ].join('; ');

  const stdout = await new Promise<string>((resolve) => {
    execFile(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: PORT_METADATA_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, output) => {
        if (error || !output) {
          resolve('');
          return;
        }
        resolve(output.trim());
      },
    );
  });

  if (!stdout) {
    return cachedWindowsMetadata ?? new Map();
  }

  try {
    const parsed = JSON.parse(stdout) as WindowsPortMetadata | WindowsPortMetadata[];
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const metadata = new Map(
      items
        .filter((item) => typeof item.path === 'string' && item.path.length > 0)
        .map((item) => [item.path.toUpperCase(), item]),
    );
    cachedWindowsMetadata = metadata;
    cachedWindowsMetadataAt = Date.now();
    return metadata;
  } catch {
    return cachedWindowsMetadata ?? new Map();
  }
}
