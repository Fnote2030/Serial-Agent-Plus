/**
 * Bridge Server — HTTP REST API for MCP Server
 *
 * 在扩展进程中内嵌 HTTP Server，暴露 REST API 供 MCP Server 调用。
 * - 仅绑定 127.0.0.1（安全要求）
 * - Token 认证（每次激活生成新 Token）
 * - 服务发现文件 (~/.serialagent-plus/bridge.json)
 *
 * 独立模块：不依赖 vscode，使用 ISerialManager + ILogger 接口，
 * 支持在单元测试中使用 MockSerialManager 替代真实串口。
 *
 * 对应 spec.md §3.1.2
 */

import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ISerialManager, ILogger, SerialConfig } from './types';
import { encodeSerialText } from './text-codec';

/** Bridge 使用的监视器运行时（MonitorHost 结构性满足，测试可用桩实现） */
export interface BridgeMonitorRuntime {
  meta: { id: string; index: number; name: string; config: SerialConfig };
  manager: ISerialManager;
}

/** 多监视器宿主接口：bridge 按监视器路由与管理的全部依赖 */
export interface BridgeHost {
  list(): Array<{ id: string; index: number; name: string; connected: boolean; port: string; baudRate: number }>;
  runtimeByRef(ref: number | string): BridgeMonitorRuntime | undefined;
  primary(): BridgeMonitorRuntime;
  createMonitor(name?: string): { id: string; index: number; name: string };
  deleteMonitor(id: string): void;
  renameMonitor(id: string, name: string): { id: string; index: number; name: string };
  updateMonitorConfig(id: string, partial: Partial<SerialConfig>): SerialConfig;
  connect(id: string, config: SerialConfig): Promise<{ ok: boolean; error?: string }>;
}

export class BridgeServer {
  private _server: http.Server | null = null;
  private _token = '';
  private _port = 0;
  private _instanceId = '';
  private _host: BridgeHost;
  private _logger: ILogger;
  private _onUiClear: ((monitorId: string) => void) | null = null;

  /** 进行中的 wait 请求取消函数列表（S2.05: 优雅关闭用） */
  private _activeWaiters: Set<() => void> = new Set();

  /** 是否启用 Token 认证（默认关闭，仅本地使用无需认证） */
  private _authEnabled: boolean;
  private _version: string;
  /** 服务发现文件目录（默认 ~/.serialagent-plus；测试传入临时目录避免覆盖真实实例） */
  private readonly _bridgeDir: string;

  constructor(
    host: BridgeHost,
    logger: ILogger,
    authEnabled = true,
    version = '0.0.0',
    bridgeDir?: string,
  ) {
    this._host = host;
    this._logger = logger;
    this._authEnabled = authEnabled;
    this._version = version;
    this._bridgeDir = bridgeDir ?? path.join(os.homedir(), '.serialagent-plus');
  }

  /** 设置 UI 同步回调：Bridge API 清空日志时通知 Webview（携带监视器 id） */
  setOnUiClear(cb: (monitorId: string) => void): void { this._onUiClear = cb; }

  get port(): number { return this._port; }
  get token(): string { return this._token; }

  private _resolveAllowedOrigin(origin: string | undefined): string | null {
    if (!origin) { return null; }
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
      return origin;
    }
    return null;
  }

  // ---- 生命周期 ----

  async start(): Promise<void> {
    // H2: 重复调用保护，先关闭旧 server
    if (this._server) { await this.stop(); }

    this._token = crypto.randomUUID();
    this._instanceId = crypto.randomUUID();

    this._server = http.createServer((req, res) => this._handleRequest(req, res));

    return new Promise<void>((resolve, reject) => {
      this._server!.listen(0, '127.0.0.1', () => {
        const addr = this._server!.address() as { port: number };
        this._port = addr.port;
        this._logger.appendLine(`[Serial Agent Plus Bridge] Started on 127.0.0.1:${this._port}`);
        this._writeBridgeFile();
        resolve();
      });
      this._server!.on('error', (err) => {
        this._logger.appendLine(`[Serial Agent Plus Bridge] Failed to start: ${err.message}`);
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    // S2.05: 取消所有进行中的 wait 请求
    for (const cancel of this._activeWaiters) { cancel(); }
    this._activeWaiters.clear();

    this._deleteBridgeFile();
    return new Promise<void>((resolve) => {
      if (this._server) {
        this._server.close(() => { this._server = null; resolve(); });
      } else {
        resolve();
      }
    });
  }

  // ---- 服务发现文件 (S1.02) ----

  private _getBridgeFilePath(): string {
    return path.join(this._bridgeDir, 'bridge.json');
  }

  private _writeBridgeFile(): void {
    const filePath = this._getBridgeFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data = {
      port: this._port,
      pid: process.pid,
      token: this._token,
      instanceId: this._instanceId,
      version: this._version,
      startedAt: new Date().toISOString(),
    };
    // Windows 不支持 mode 参数，跳过权限设置；macOS/Linux 设置 0o600
    const writeOpts: fs.WriteFileOptions = process.platform === 'win32' ? 'utf8' : { encoding: 'utf8', mode: 0o600 };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), writeOpts);
    this._logger.appendLine(`[Serial Agent Plus Bridge] Discovery file written: ${filePath}`);
  }

  private _deleteBridgeFile(): void {
    try {
      const filePath = this._getBridgeFilePath();
      if (!fs.existsSync(filePath)) { return; }
      // 只删除本实例写出的发现文件：另一实例（如多窗口/测试）覆盖后不能误删
      let owner: { instanceId?: unknown; pid?: unknown } = {};
      try {
        owner = JSON.parse(fs.readFileSync(filePath, 'utf8')) as typeof owner;
      } catch {
        return; // 内容不可解析：保留，避免误删他人文件
      }
      const isOwn = typeof owner.instanceId === 'string'
        ? owner.instanceId === this._instanceId
        : owner.pid === process.pid;
      if (!isOwn) { return; }
      fs.unlinkSync(filePath);
      this._logger.appendLine('[Serial Agent Plus Bridge] Discovery file deleted');
    } catch { /* ignore */ }
  }

  // ---- Token 认证中间件 (S1.10) ----

  private _checkAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!this._authEnabled) { return true; }
    const auth = req.headers.authorization;
    if (!auth) {
      this._jsonError(res, 401, 'AUTH_REQUIRED', 'Missing Authorization header');
      return false;
    }
    if (auth !== `Bearer ${this._token}`) {
      this._jsonError(res, 401, 'AUTH_INVALID_TOKEN', 'Invalid bearer token');
      return false;
    }
    return true;
  }

  // ---- 请求路由 ----

  private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS headers: only echo trusted local origins.
    const allowedOrigin = this._resolveAllowedOrigin(req.headers.origin);
    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!this._checkAuth(req, res)) { return; }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this._port}`);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';
    // 失败请求的错误码要能在 Output 面板（Serial Agent Plus Bridge）里看到，
    // 便于排查浏览器/脚本调用失败（错误码本身不进 HTTP 响应以外的通道）
    (res as unknown as { __bridgeRequestLabel?: string }).__bridgeRequestLabel = `${method} ${pathname}`;

    try {
      // 多监视器管理路由：/api/monitors[/{ref}[/rename|/config]]
      // 路径段是百分号编码的（MCP 侧 encodeURIComponent）：先解码再按 index/name 寻址
      const monitorMatch = pathname.match(/^\/api\/monitors(?:\/([^/]+))?(?:\/(rename|config))?$/);
      if (monitorMatch) {
        let monitorRef: string | undefined;
        if (monitorMatch[1]) {
          try {
            monitorRef = decodeURIComponent(monitorMatch[1]);
          } catch {
            monitorRef = undefined; // 非法转义序列：按找不到处理
          }
          if (monitorRef === '') { monitorRef = undefined; }
        }
        if (method === 'GET' && !monitorRef) { await this._handleMonitorsList(res); }
        else if (method === 'POST' && !monitorRef) { await this._handleMonitorCreate(req, res); }
        else if (method === 'DELETE' && monitorRef && !monitorMatch[2]) { await this._handleMonitorDelete(res, monitorRef); }
        else if (method === 'POST' && monitorRef && monitorMatch[2] === 'rename') { await this._handleMonitorRename(req, res, monitorRef); }
        else if (method === 'GET' && monitorRef && monitorMatch[2] === 'config') { await this._handleMonitorConfigGet(res, monitorRef); }
        else if (method === 'POST' && monitorRef && monitorMatch[2] === 'config') { await this._handleMonitorConfigSet(req, res, monitorRef); }
        else {
          this._jsonError(res, 404, 'NOT_FOUND', `Not found: ${method} ${pathname}`, { method, path: pathname });
        }
        return;
      }

      if      (method === 'GET'  && pathname === '/api/status')     { await this._handleStatus(res, url); }
      else if (method === 'GET'  && pathname === '/api/ports')      { await this._handlePorts(res); }
      else if (method === 'POST' && pathname === '/api/connect')    { await this._handleConnect(req, res); }
      else if (method === 'POST' && pathname === '/api/disconnect') { await this._handleDisconnect(req, res); }
      else if (method === 'GET'  && pathname === '/api/log')        { await this._handleLog(res, url); }
      else if (method === 'POST' && pathname === '/api/send')       { await this._handleSend(req, res); }
      else if (method === 'GET'  && pathname === '/api/log/wait')   { await this._handleLogWait(res, url); }
      else if (method === 'POST' && pathname === '/api/send-and-wait') { await this._handleSendAndWait(req, res); }
      else if (method === 'POST' && pathname === '/api/clear')      { await this._handleClear(req, res); }
      else {
        this._jsonError(res, 404, 'NOT_FOUND', `Not found: ${method} ${pathname}`, {
          method,
          path: pathname,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._logger.appendLine(`[Serial Agent Plus Bridge] Error: ${method} ${pathname} -> ${msg}`);
      if (msg === 'Invalid JSON body') {
        this._jsonError(res, 400, 'INVALID_JSON_BODY', msg);
        return;
      }
      if (msg === 'Request body too large') {
        this._jsonError(res, 413, 'REQUEST_BODY_TOO_LARGE', msg, { maxBytes: BridgeServer.MAX_BODY_SIZE });
        return;
      }
      const mapped = this._mapUnexpectedError(msg);
      this._jsonError(res, mapped.status, mapped.code, msg, {
        method,
        path: pathname,
      });
    }
  }

  // ---- 工具方法 ----

  /** 最大 body 大小 1MB（防止恶意大请求） */
  private static readonly MAX_BODY_SIZE = 1024 * 1024;

  private _readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > BridgeServer.MAX_BODY_SIZE) {
          req.destroy();
          reject(new Error('Request body too large'));
        }
      });
      req.on('end', () => {
        try { resolve(body ? JSON.parse(body) : {}); }
        catch { reject(new Error('Invalid JSON body')); }
      });
      req.on('error', reject);
    });
  }

  private _json(res: http.ServerResponse, status: number, data: object): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private _jsonError(
    res: http.ServerResponse,
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    const payload: Record<string, unknown> = {
      success: false,
      error: {
        code,
        message,
      },
    };
    if (details) {
      payload.error = {
        code,
        message,
        details,
      };
    }
    const label = (res as unknown as { __bridgeRequestLabel?: string }).__bridgeRequestLabel;
    this._logger.appendLine(
      `[Serial Agent Plus Bridge] ${status} ${code}${label ? ` (${label})` : ''}: ${message}`,
    );
    this._json(res, status, payload);
  }

  private _mapUnexpectedError(message: string): { status: number; code: string } {
    const text = message.toLowerCase();
    if (text.includes('timeout') || text.includes('timed out')) {
      return { status: 504, code: 'NETWORK_TIMEOUT' };
    }
    if (
      text.includes('serial') ||
      text.includes('port') ||
      text.includes('connect') ||
      text.includes('disconnect') ||
      text.includes('send')
    ) {
      return { status: 500, code: 'SERIAL_EXCEPTION' };
    }
    return { status: 500, code: 'INTERNAL_SERVER_ERROR' };
  }

  // ---- API Handlers (S1.03 ~ S1.09) ----

  /** 可用监视器摘要（错误响应中帮助 Agent 自选择） */
  private _monitorSummaries(): string[] {
    return this._host.list().map((m) => `${m.index}=${m.name}${m.connected ? ` (${m.port} @ ${m.baudRate})` : ''}`);
  }

  /**
   * 解析请求目标监视器：显式 monitor 参数（index/name）→ 对应运行时；
   * 缺省时恰有一个监视器则默认它，多个则报错并列出候选。
   * 失败时已写入错误响应，返回 null。
   */
  private _resolveMonitor(res: http.ServerResponse, monitor?: unknown): BridgeMonitorRuntime | null {
    const raw = monitor === undefined || monitor === null ? '' : String(monitor).trim();
    if (raw !== '') {
      const rt = this._host.runtimeByRef(raw);
      if (!rt) {
        this._jsonError(res, 404, 'MONITOR_NOT_FOUND', `Monitor not found: ${raw}`, {
          monitor: raw,
          monitors: this._monitorSummaries(),
        });
        return null;
      }
      return rt;
    }
    const list = this._host.list();
    if (list.length > 1) {
      this._jsonError(res, 400, 'MONITOR_REQUIRED', 'Multiple monitors exist; specify "monitor" (index or name)', {
        monitors: this._monitorSummaries(),
      });
      return null;
    }
    return this._host.primary();
  }

  /** S1.03: GET /api/status?monitor= */
  private async _handleStatus(res: http.ServerResponse, url: URL): Promise<void> {
    const rt = this._resolveMonitor(res, url.searchParams.get('monitor'));
    if (!rt) { return; }
    const sm = rt.manager;
    const connected = sm.isConnected;
    const rxBytes = sm.rxBytes;
    const txBytes = sm.txBytes;
    const bufferedLines = sm.getLogBuffer().length;

    // 当 connected=false 但有历史活动数据时，附加提示帮助 AI 判断
    let statusHint: string | undefined;
    if (!connected && (rxBytes > 0 || txBytes > 0 || bufferedLines > 0)) {
      statusHint = 'Port reports disconnected but has historical activity (rxBytes/txBytes/bufferedLines > 0). '
        + 'It may have experienced a transient disconnect. Try connect_serial to re-establish.';
    }

    const result: Record<string, unknown> = {
      monitor: `${rt.meta.index}=${rt.meta.name}`,
      connected,
      port: sm.currentPath,
      baudRate: sm.currentBaudRate,
      rxBytes,
      txBytes,
      bufferedLines,
      isReconnecting: sm.isReconnecting,
    };
    if (statusHint) { result.statusHint = statusHint; }
    this._json(res, 200, result);
  }

  /** S1.04: GET /api/ports */
  private async _handlePorts(res: http.ServerResponse): Promise<void> {
    const ports = await this._host.primary().manager.listPorts();
    this._json(res, 200, { ports });
  }

  /** S1.05: POST /api/connect { port, ..., monitor? } */
  private async _handleConnect(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this._readBody(req);
    const rt = this._resolveMonitor(res, body.monitor);
    if (!rt) { return; }
    if (!body.port || typeof body.port !== 'string') {
      this._jsonError(res, 400, 'MISSING_REQUIRED_FIELD', 'Missing required field: port', { field: 'port' });
      return;
    }
    const baudRateRaw = body.baudRate;
    if (
      baudRateRaw !== undefined &&
      (typeof baudRateRaw !== 'number' || !Number.isFinite(baudRateRaw) || !Number.isInteger(baudRateRaw) || baudRateRaw <= 0)
    ) {
      this._jsonError(res, 400, 'INVALID_ARGUMENT', 'Invalid baudRate: must be a positive integer', { field: 'baudRate' });
      return;
    }
    const dataBitsRaw = body.dataBits;
    if (dataBitsRaw !== undefined && dataBitsRaw !== 5 && dataBitsRaw !== 6 && dataBitsRaw !== 7 && dataBitsRaw !== 8) {
      this._jsonError(res, 400, 'INVALID_ARGUMENT', 'Invalid dataBits: must be one of 5,6,7,8', { field: 'dataBits' });
      return;
    }
    const parityRaw = body.parity;
    if (parityRaw !== undefined && parityRaw !== 'none' && parityRaw !== 'even' && parityRaw !== 'odd' && parityRaw !== 'mark' && parityRaw !== 'space') {
      this._jsonError(res, 400, 'INVALID_ARGUMENT', 'Invalid parity: must be one of none/even/odd/mark/space', { field: 'parity' });
      return;
    }
    const stopBitsRaw = body.stopBits;
    if (stopBitsRaw !== undefined && stopBitsRaw !== 1 && stopBitsRaw !== 1.5 && stopBitsRaw !== 2) {
      this._jsonError(res, 400, 'INVALID_ARGUMENT', 'Invalid stopBits: must be one of 1/1.5/2', { field: 'stopBits' });
      return;
    }
    const flowControlRaw = body.flowControl;
    if (flowControlRaw !== undefined && flowControlRaw !== 'none' && flowControlRaw !== 'rtscts' && flowControlRaw !== 'xon' && flowControlRaw !== 'xoff') {
      this._jsonError(res, 400, 'INVALID_ARGUMENT', 'Invalid flowControl: must be one of none/rtscts/xon/xoff', { field: 'flowControl' });
      return;
    }

    const baudRate = typeof baudRateRaw === 'number' ? baudRateRaw : 115200;
    const dataBits: 5 | 6 | 7 | 8 = dataBitsRaw === 5 || dataBitsRaw === 6 || dataBitsRaw === 7 || dataBitsRaw === 8 ? dataBitsRaw : 8;
    const parity: SerialConfig['parity'] = parityRaw === 'none' || parityRaw === 'even' || parityRaw === 'odd' || parityRaw === 'mark' || parityRaw === 'space' ? parityRaw : 'none';
    const stopBits: 1 | 1.5 | 2 = stopBitsRaw === 1 || stopBitsRaw === 1.5 || stopBitsRaw === 2 ? stopBitsRaw : 1;
    const flowControl: SerialConfig['flowControl'] = flowControlRaw === 'rtscts' || flowControlRaw === 'xon' || flowControlRaw === 'xoff' ? flowControlRaw : 'none';

    const config: SerialConfig = {
      port: body.port,
      baudRate,
      dataBits,
      parity,
      stopBits,
      flowControl,
      // 保留该监视器当前显示设置
      lineEnding: rt.manager.config.lineEnding,
      showTimestamp: rt.manager.config.showTimestamp,
      hexMode: rt.manager.config.hexMode,
      rxIdleWrapMs: rt.manager.config.rxIdleWrapMs,
      logBufferKB: rt.manager.config.logBufferKB,
      encoding: rt.manager.config.encoding,
    };
    // 走宿主连接：含端口占用冲突检测（错误信息指明占用者）
    const result = await this._host.connect(rt.meta.id, config);
    if (result.ok) {
      this._json(res, 200, { success: true, message: `Connected to ${config.port} @ ${config.baudRate}`, monitor: `${rt.meta.index}=${rt.meta.name}` });
    } else {
      this._jsonError(res, 400, 'SERIAL_CONNECT_FAILED', result.error ?? `Failed to connect to ${config.port}`, { port: config.port });
    }
  }

  /** S1.06: POST /api/disconnect { monitor? } */
  private async _handleDisconnect(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this._readBody(req);
    const rt = this._resolveMonitor(res, body.monitor);
    if (!rt) { return; }
    await rt.manager.disconnect();
    this._json(res, 200, { success: true, monitor: `${rt.meta.index}=${rt.meta.name}` });
  }

  /** S1.07: GET /api/log?lines=50&monitor= */
  private async _handleLog(res: http.ServerResponse, url: URL): Promise<void> {
    const rt = this._resolveMonitor(res, url.searchParams.get('monitor'));
    if (!rt) { return; }
    const linesParam = url.searchParams.get('lines');
    const lines = linesParam ? Math.max(1, parseInt(linesParam, 10) || 50) : 50;
    const buffer = rt.manager.getLogBuffer();
    this._json(res, 200, {
      monitor: `${rt.meta.index}=${rt.meta.name}`,
      lines: buffer.slice(-lines),
      totalBuffered: buffer.length,
    });
  }

  /** S1.08: POST /api/send { data, ..., monitor? } */
  private async _handleSend(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this._readBody(req);
    const rt = this._resolveMonitor(res, body.monitor);
    if (!rt) { return; }
    if (body.data === undefined || body.data === null) {
      this._jsonError(res, 400, 'MISSING_REQUIRED_FIELD', 'Missing required field: data', { field: 'data' });
      return;
    }
    if (!rt.manager.isConnected) {
      this._jsonError(res, 400, 'SERIAL_NOT_CONNECTED', 'Not connected to any serial port');
      return;
    }
    const data = String(body.data);
    const hexMode = (body.hexMode as boolean) ?? false;
    const lineEnding = (body.lineEnding as string) ?? rt.manager.config.lineEnding;
    const result = await this._sendAndEcho(rt, data, hexMode, lineEnding);
    if (result.ok) {
      this._json(res, 200, { success: true, bytesSent: result.bytesSent, monitor: `${rt.meta.index}=${rt.meta.name}` });
    } else {
      this._jsonError(res, 400, 'SERIAL_SEND_FAILED', 'Send failed (check HEX format or connection)');
    }
  }

  /**
   * S2.02: GET /api/log/wait
   *
   * 阻塞等待串口输出匹配指定 pattern。
   * - pattern: 正则表达式或纯文本匹配模式（必填）
   * - timeout: 等待超时秒数，默认 30，范围 1-120
   * - scanBuffer: 是否先扫描现有缓冲区（默认 true）
   *
   * scanBuffer=true 时先扫描已有日志（配合 clear_serial_log 使用，
   * 可捕获 clear 之后、wait 之前到达的数据，消除烧录后等待的时序竞态）。
   * scanBuffer=false 时仅监听调用之后的新日志（旧行为）。
   * 如需原子性 send+wait，使用 POST /api/send-and-wait。
   */
  private async _handleLogWait(res: http.ServerResponse, url: URL): Promise<void> {
    const rt = this._resolveMonitor(res, url.searchParams.get('monitor'));
    if (!rt) { return; }
    const pattern = url.searchParams.get('pattern');
    if (!pattern) {
      this._jsonError(res, 400, 'MISSING_REQUIRED_PARAMETER', 'Missing required parameter: pattern', { parameter: 'pattern' });
      return;
    }

    const timeoutSec = Math.min(120, Math.max(1, parseInt(url.searchParams.get('timeout') ?? '30', 10) || 30));
    const scanBuffer = url.searchParams.get('scanBuffer') !== 'false'; // default true

    const regex = this._buildRegex(pattern);
    const startTime = Date.now();
    const recentLogs: string[] = [];

    // Buffer Pre-scan：先扫描现有缓冲区，捕获 clear 之后、wait 之前到达的日志
    if (scanBuffer) {
      const existingBuffer = rt.manager.getLogBuffer();
      recentLogs.push(...existingBuffer.slice(-50));
      for (const line of existingBuffer) {
        if (regex.test(line)) {
          this._json(res, 200, {
            found: true,
            matchedLine: line,
            matchedAt: new Date().toISOString(),
            waitedMs: Date.now() - startTime,
            recentLogs: recentLogs.slice(-20),
          });
          return;
        }
      }
    }

    // 缓冲区未匹配（或 scanBuffer=false），订阅新日志等待
    return this._waitForPattern(rt, res, regex, timeoutSec, startTime, recentLogs);
  }

  /**
   * POST /api/send-and-wait
   *
   * 原子操作：先订阅日志 → 发送数据 → 等待匹配输出。
   * 彻底消除 send_serial_data + wait_for_output 之间的竞态条件。
   *
   * body: { data, pattern, timeout?, hexMode?, lineEnding? }
   */
  private async _handleSendAndWait(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this._readBody(req);
    const rt = this._resolveMonitor(res, body.monitor);
    if (!rt) { return; }

    if (body.data === undefined || body.data === null) {
      this._jsonError(res, 400, 'MISSING_REQUIRED_FIELD', 'Missing required field: data', { field: 'data' });
      return;
    }
    if (!body.pattern || typeof body.pattern !== 'string') {
      this._jsonError(res, 400, 'MISSING_REQUIRED_FIELD', 'Missing required field: pattern', { field: 'pattern' });
      return;
    }
    if (!rt.manager.isConnected) {
      this._jsonError(res, 400, 'SERIAL_NOT_CONNECTED', 'Not connected to any serial port');
      return;
    }

    const data = String(body.data);
    const pattern = body.pattern as string;
    const timeoutSec = Math.min(120, Math.max(1, Number(body.timeout) || 10));
    const hexMode = (body.hexMode as boolean) ?? false;
    const lineEnding = (body.lineEnding as string) ?? rt.manager.config.lineEnding;
    const regex = this._buildRegex(pattern);
    const startTime = Date.now();
    const recentLogs: string[] = [];

    // 关键顺序：先订阅，再发送，确保不丢失快速响应
    rt.manager.onNewLog(onLineCollector);

    // 临时收集器：在 _waitForPattern 建立之前先收集日志
    let earlyLines: string[] = [];
    let earlyMatch: string | null = null;
    function onLineCollector(line: string) {
      earlyLines.push(line);
      if (!earlyMatch && regex.test(line)) { earlyMatch = line; }
    }

    const sendResult = await this._sendAndEcho(rt, data, hexMode, lineEnding);
    rt.manager.offNewLog(onLineCollector);

    if (!sendResult.ok) {
      this._jsonError(res, 400, 'SERIAL_SEND_FAILED', 'Send failed (check HEX format or connection)', {
        sendSuccess: false,
      });
      return;
    }

    // 发送成功后检查：在 send 期间是否已匹配
    recentLogs.push(...earlyLines);
    if (earlyMatch) {
      this._json(res, 200, {
        sendSuccess: true,
        found: true,
        matchedLine: earlyMatch,
        matchedAt: new Date().toISOString(),
        waitedMs: Date.now() - startTime,
        recentLogs: recentLogs.slice(-20),
      });
      return;
    }

    // 未立即匹配，进入正常等待流程
    return this._waitForPattern(rt, res, regex, timeoutSec, startTime, recentLogs, true);
  }

  // ---- 共享工具方法 ----

  /** 构建正则匹配器（无效正则退化为纯文本包含匹配） */
  private _buildRegex(pattern: string): RegExp {
    try {
      return new RegExp(pattern);
    } catch {
      return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
  }

  /** 执行发送 + Echo 注入，返回发送结果和字节数（_handleSend 和 _handleSendAndWait 共用） */
  private async _sendAndEcho(
    rt: BridgeMonitorRuntime,
    data: string, hexMode: boolean, lineEnding: string,
  ): Promise<{ ok: boolean; bytesSent: number }> {
    const ok = await rt.manager.send(data, hexMode, lineEnding);
    if (!ok) { return { ok: false, bytesSent: 0 }; }

    let bytesSent: number;
    if (hexMode) {
      bytesSent = data.replace(/\s+/g, '').length / 2;
    } else {
      const suffixes: Record<string, string> = { lf: '\n', crlf: '\r\n', cr: '\r', none: '' };
      bytesSent = encodeSerialText(data + (suffixes[lineEnding] ?? '\n'), rt.manager.config.encoding).length;
    }
    rt.manager.injectTxLog(data, hexMode);
    return { ok: true, bytesSent };
  }

  /** 订阅新日志并等待 pattern 匹配（wait_for_output 和 send_and_wait 共用） */
  private _waitForPattern(
    rt: BridgeMonitorRuntime,
    res: http.ServerResponse,
    regex: RegExp,
    timeoutSec: number,
    startTime: number,
    recentLogs: string[],
    sendAndWait = false,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const timeoutMs = timeoutSec * 1000;

      const cleanup = () => {
        if (settled) { return; }
        settled = true;
        rt.manager.offNewLog(onLine);
        clearTimeout(timer);
        this._activeWaiters.delete(cancel);
      };

      const onLine = (line: string) => {
        recentLogs.push(line);
        if (recentLogs.length > 50) { recentLogs.shift(); }

        if (regex.test(line)) {
          cleanup();
          const result: Record<string, unknown> = {
            found: true,
            matchedLine: line,
            matchedAt: new Date().toISOString(),
            waitedMs: Date.now() - startTime,
            recentLogs: recentLogs.slice(-20),
          };
          if (sendAndWait) { result.sendSuccess = true; }
          this._json(res, 200, result);
          resolve();
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        const result: Record<string, unknown> = {
          found: false,
          waitedMs: Date.now() - startTime,
          recentLogs: recentLogs.slice(-20),
          hint: 'Device may not have been flashed yet, or the expected pattern was not printed.',
        };
        if (sendAndWait) { result.sendSuccess = true; }
        this._json(res, 200, result);
        resolve();
      }, timeoutMs);

      const cancel = () => {
        cleanup();
        const result: Record<string, unknown> = {
          found: false,
          waitedMs: Date.now() - startTime,
          recentLogs: recentLogs.slice(-20),
          hint: 'Wait cancelled: Bridge Server shutting down.',
        };
        if (sendAndWait) { result.sendSuccess = true; }
        this._json(res, 200, result);
        resolve();
      };

      this._activeWaiters.add(cancel);
      rt.manager.onNewLog(onLine);
    });
  }

  /** S1.09: POST /api/clear { monitor? } */
  private async _handleClear(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this._readBody(req);
    const rt = this._resolveMonitor(res, body.monitor);
    if (!rt) { return; }
    rt.manager.clearLog();
    rt.manager.resetCounters();
    this._onUiClear?.(rt.meta.id);
    this._json(res, 200, { success: true, monitor: `${rt.meta.index}=${rt.meta.name}` });
  }

  // ---- 多监视器管理端点 ----

  /** GET /api/monitors：列表 + 连接状态 + 配置 + 计数 */
  private async _handleMonitorsList(res: http.ServerResponse): Promise<void> {
    const monitors = this._host.list().map((info) => {
      const rt = this._host.runtimeByRef(info.index);
      return {
        id: info.id,
        index: info.index,
        name: info.name,
        label: `${info.index}=${info.name}`,
        connected: info.connected,
        port: info.connected ? info.port : rt?.meta.config.port ?? '',
        baudRate: info.connected ? info.baudRate : rt?.meta.config.baudRate ?? 0,
        rxBytes: rt?.manager.rxBytes ?? 0,
        txBytes: rt?.manager.txBytes ?? 0,
        bufferedLines: rt?.manager.getLogBuffer().length ?? 0,
        config: rt?.meta.config ?? undefined,
      };
    });
    this._json(res, 200, { monitors, count: monitors.length });
  }

  /** POST /api/monitors { name? } */
  private async _handleMonitorCreate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this._readBody(req);
    try {
      const created = this._host.createMonitor(typeof body.name === 'string' ? body.name : undefined);
      this._json(res, 201, { success: true, monitor: created, label: `${created.index}=${created.name}` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = /limit reached/i.test(msg) ? 'MONITOR_LIMIT_REACHED' : 'INVALID_ARGUMENT';
      this._jsonError(res, /limit reached/i.test(msg) ? 409 : 400, code, msg);
    }
  }

  /** DELETE /api/monitors/{ref}：静默断开后删除 */
  private async _handleMonitorDelete(res: http.ServerResponse, ref: string): Promise<void> {
    const rt = this._resolveMonitor(res, ref);
    if (!rt) { return; }
    try {
      this._host.deleteMonitor(rt.meta.id);
      this._json(res, 200, { success: true, deleted: `${rt.meta.index}=${rt.meta.name}` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._jsonError(res, /must remain/i.test(msg) ? 409 : 500, /must remain/i.test(msg) ? 'MONITOR_MINIMUM' : 'INTERNAL_SERVER_ERROR', msg);
    }
  }

  /** POST /api/monitors/{ref}/rename { name } */
  private async _handleMonitorRename(req: http.IncomingMessage, res: http.ServerResponse, ref: string): Promise<void> {
    const rt = this._resolveMonitor(res, ref);
    if (!rt) { return; }
    const body = await this._readBody(req);
    if (!body.name || typeof body.name !== 'string') {
      this._jsonError(res, 400, 'MISSING_REQUIRED_FIELD', 'Missing required field: name', { field: 'name' });
      return;
    }
    try {
      const renamed = this._host.renameMonitor(rt.meta.id, body.name);
      this._json(res, 200, { success: true, monitor: renamed, label: `${renamed.index}=${renamed.name}` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._jsonError(res, 400, 'INVALID_ARGUMENT', msg);
    }
  }

  /** GET /api/monitors/{ref}/config */
  private async _handleMonitorConfigGet(res: http.ServerResponse, ref: string): Promise<void> {
    const rt = this._resolveMonitor(res, ref);
    if (!rt) { return; }
    this._json(res, 200, { monitor: `${rt.meta.index}=${rt.meta.name}`, config: rt.manager.config });
  }

  /** POST /api/monitors/{ref}/config { partial }：更新显示类配置（连接参数在 connect 时指定） */
  private async _handleMonitorConfigSet(req: http.IncomingMessage, res: http.ServerResponse, ref: string): Promise<void> {
    const rt = this._resolveMonitor(res, ref);
    if (!rt) { return; }
    const body = await this._readBody(req);
    const allowed: Array<keyof SerialConfig> = ['lineEnding', 'showTimestamp', 'hexMode', 'encoding', 'rxIdleWrapMs', 'logBufferKB', 'flowControl'];
    const partial: Partial<SerialConfig> = {};
    for (const key of allowed) {
      if (body[key] !== undefined) {
        (partial as Record<string, unknown>)[key] = body[key];
      }
    }
    if (Object.keys(partial).length === 0) {
      this._jsonError(res, 400, 'INVALID_ARGUMENT', `No updatable fields; allowed: ${allowed.join(', ')}`);
      return;
    }
    rt.manager.updateSettings(partial);
    const config = this._host.updateMonitorConfig(rt.meta.id, partial);
    this._json(res, 200, { success: true, monitor: `${rt.meta.index}=${rt.meta.name}`, config });
  }
}
