#!/usr/bin/env node

/**
 * Serial Agent Plus MCP Server
 *
 * 为 AI（Windsurf / Cursor / Claude 等 MCP Client）提供串口调试能力。
 * 通过 MCP 协议暴露 Tool，内部转换为 HTTP 请求发给 Bridge Server（VS Code 扩展内嵌）。
 *
 * Tool 列表：
 *   - get_serial_status   获取连接状态
 *   - list_serial_ports    列出可用串口
 *   - connect_serial       连接串口
 *   - disconnect_serial    断开串口
 *   - read_serial_log      读取串口日志
 *   - send_serial_data     向串口发送数据
 *   - clear_serial_log     清空日志缓冲区
 *   - wait_for_output      等待特定输出
 *   - send_and_wait        原子性发送+等待响应
 *
 * 传输方式：stdio（标准输入输出）
 *
 * 对应 spec.md §3.2 + §4.2
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============================================================
// Bridge HTTP Client (S1.11)
// ============================================================

/** 发现文件内容 */
interface BridgeConfig {
  port: number;
  pid: number;
  token: string;
  instanceId: string;
  version: string;
  startedAt: string;
}

interface BridgeErrorObject {
  code?: string;
  message?: string;
  details?: unknown;
}

interface BridgeErrorPayload {
  success?: boolean;
  error?: string | BridgeErrorObject;
}

function formatBridgeError(method: 'GET' | 'POST' | 'DELETE', apiPath: string, status: number, parsed: unknown): string {
  if (typeof parsed === 'string') {
    return `Bridge API ${method} ${apiPath} failed with status ${status}: ${parsed}`;
  }

  if (parsed && typeof parsed === 'object') {
    const payload = parsed as BridgeErrorPayload;
    const rawError = payload.error;

    if (typeof rawError === 'string') {
      return `Bridge API ${method} ${apiPath} failed with status ${status}: ${rawError}`;
    }

    if (rawError && typeof rawError === 'object') {
      const code = rawError.code || `HTTP_${status}`;
      const message = rawError.message || 'Unknown Bridge error';
      const detailsText = rawError.details === undefined ? '' : ` details=${JSON.stringify(rawError.details)}`;
      return `Bridge API ${method} ${apiPath} failed [${code}]: ${message}${detailsText}`;
    }
  }

  return `Bridge API ${method} ${apiPath} failed with status ${status}: ${JSON.stringify(parsed)}`;
}

/**
 * 读取发现文件获取 Bridge Server 连接信息
 * 每次调用都重新读取，以应对扩展重启产生的新端口/token
 */
function readBridgeConfig(): BridgeConfig {
  const bridgePath = path.join(os.homedir(), '.serialagent-plus', 'bridge.json');
  if (!fs.existsSync(bridgePath)) {
    throw new Error(
      'Bridge server not running. Please open VS Code with Serial Agent Plus extension activated.\n' +
      `Expected discovery file at: ${bridgePath}`
    );
  }
  return JSON.parse(fs.readFileSync(bridgePath, 'utf8')) as BridgeConfig;
}

/**
 * 向 Bridge Server 发送 HTTP 请求（S1.11）
 *
 * 所有 MCP Tool 共用此函数：
 * - 自动读取发现文件获取端口和 token
 * - 自动携带 Authorization header
 * - 统一错误处理
 */
async function bridgeRequest(
  method: 'GET' | 'POST' | 'DELETE',
  apiPath: string,
  body?: object,
  timeoutMs = 5000,
): Promise<unknown> {
  const config = readBridgeConfig();

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: config.port,
        path: apiPath,
        method,
        headers: {
          'Authorization': `Bearer ${config.token}`,
          'Content-Type': 'application/json',
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          let parsed: unknown = data;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          const status = res.statusCode ?? 0;
          if (status >= 400) {
            reject(new Error(formatBridgeError(method, apiPath, status, parsed)));
            return;
          }
          resolve(parsed);
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Bridge request timed out after ${timeoutMs}ms: ${method} ${apiPath}`));
    });

    req.on('error', (err) => {
      reject(new Error(
        `Bridge server unreachable (${err.message}). ` +
        'Please ensure VS Code is running with Serial Agent Plus extension activated.'
      ));
    });

    if (body) { req.write(JSON.stringify(body)); }
    req.end();
  });
}

/** MCP Tool 响应类型 */
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
type ToolBridgeRequester = (
  method: 'GET' | 'POST' | 'DELETE',
  apiPath: string,
  body?: object,
  timeoutMs?: number,
) => Promise<ToolResult>;

/**
 * 封装 bridgeRequest 为 MCP Tool 响应格式
 * 成功时返回 JSON 文本；失败时返回 isError: true
 */
async function toolBridgeRequest(
  method: 'GET' | 'POST' | 'DELETE',
  apiPath: string,
  body?: object,
  timeoutMs?: number,
): Promise<ToolResult> {
  try {
    const result = await bridgeRequest(method, apiPath, body, timeoutMs);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text' as const, text: msg }],
      isError: true,
    };
  }
}

// ============================================================
// MCP Server
// ============================================================

const server = new McpServer({
  name: 'serialagent-plus-mcp',
  version: '1.0.1',
});

export function registerTools(
  targetServer: Pick<McpServer, 'tool'>,
  requester: ToolBridgeRequester = toolBridgeRequest,
): void {
  // ============================================================
  // Tool 定义 (S1.12 ~ S1.18)
  // ============================================================

  /** monitor 参数的统一描述（多监视器场景按 index 或唯一名寻址） */
  const monitorParam = z.string().optional().describe('Target monitor: index (e.g. "2") or unique name (e.g. "RTT"). Defaults to the only monitor; required when several exist');

  /** GET 查询附加 monitor */
  const withMonitor = (base: string, monitor?: string) =>
    monitor ? `${base}${base.includes('?') ? '&' : '?'}monitor=${encodeURIComponent(monitor)}` : base;

  /**
   * S1.17: get_serial_status — 获取当前串口连接状态
   * AI 使用场景：在操作前先确认串口是否已连接
   */
  targetServer.tool(
  'get_serial_status',
  'Read-only. Returns current serial connection status, reconnect state, byte counters, and buffered log metrics. Does not modify device or toolchain state.',
  { monitor: monitorParam },
  async ({ monitor }) => requester('GET', withMonitor('/api/status', monitor)),
  );

/**
 * S1.12: list_serial_ports — 列出可用串口设备
 * AI 使用场景：在连接串口前，先查看有哪些可用的串口
 */
  targetServer.tool(
  'list_serial_ports',
  'Read-only. Lists available serial port devices on the host system, including path and vendor information. Does not open ports or modify device state.',
  {},
  async () => requester('GET', '/api/ports'),
  );

/**
 * S1.13: connect_serial — 连接到指定串口
 * AI 使用场景：用户确认串口后，AI 调用此 Tool 建立连接
 */
  targetServer.tool(
  'connect_serial',
  'Device interaction. Opens a serial connection to the specified port with optional serial settings. May change host/device communication state. A port already opened by another monitor is rejected with the owner named in the error.',
  {
    port: z.string().describe('Serial port path, e.g. COM3 or /dev/ttyUSB0'),
    baudRate: z.number().optional().default(115200).describe('Baud rate, default 115200'),
    dataBits: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).optional().default(8).describe('Data bits, default 8'),
    stopBits: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).optional().default(1).describe('Stop bits, default 1'),
    parity: z.enum(['none', 'even', 'odd', 'mark', 'space']).optional().default('none').describe('Parity, default none'),
    monitor: monitorParam,
  },
  async ({ port, baudRate, dataBits, stopBits, parity, monitor }) => {
    const body: Record<string, unknown> = { port, baudRate, dataBits, stopBits, parity };
    if (monitor !== undefined) { body.monitor = monitor; }
    return requester('POST', '/api/connect', body);
  },
  );

/**
 * S1.14: disconnect_serial — 断开当前串口连接
 */
  targetServer.tool(
  'disconnect_serial',
  'Device interaction. Closes the currently connected serial port. Safe to call even if not connected, but it changes host/device communication state.',
  { monitor: monitorParam },
  async ({ monitor }) => requester('POST', '/api/disconnect', monitor ? { monitor } : {}),
  );

/**
 * S1.15: read_serial_log — 读取串口日志
 * AI 使用场景：设备上电/运行后，AI 调用此 Tool 获取最新日志进行分析
 */
  targetServer.tool(
  'read_serial_log',
  'Read-only. Returns recent serial log lines from the bridge buffer, including total buffered count. Does not modify device state.',
  {
    lines: z.number().optional().default(50).describe('Number of recent lines to return, default 50'),
    monitor: monitorParam,
  },
  async ({ lines, monitor }) => requester('GET', withMonitor(`/api/log?lines=${lines}`, monitor)),
  );

/**
 * S1.16: send_serial_data — 向串口发送数据
 * AI 使用场景：发送调试命令、AT 指令、重启指令等
 */
  targetServer.tool(
  'send_serial_data',
  'Side-effectful device interaction. Sends text or HEX bytes to the connected serial device and may trigger device behavior changes.',
  {
    data: z.string().describe('Data to send'),
    hexMode: z.boolean().optional().default(false).describe('Send as HEX bytes (e.g. "41 42 0D 0A"), default false'),
    lineEnding: z.enum(['lf', 'crlf', 'cr', 'none']).optional().describe('Line ending to append. Uses current config if omitted'),
    monitor: monitorParam,
  },
  async ({ data, hexMode, lineEnding, monitor }) => {
    const body: Record<string, unknown> = { data, hexMode };
    if (lineEnding !== undefined) { body.lineEnding = lineEnding; }
    if (monitor !== undefined) { body.monitor = monitor; }
    return requester('POST', '/api/send', body);
  },
  );

/**
 * S1.18: clear_serial_log — 清空日志缓冲区
 * AI 使用场景：在等待新输出前先清空旧日志，确保 read_serial_log 只返回新内容
 */
  targetServer.tool(
  'clear_serial_log',
  'Local bridge state reset. Clears buffered serial logs and RX/TX counters. Does not flash firmware, but it removes locally buffered evidence.',
  { monitor: monitorParam },
  async ({ monitor }) => requester('POST', '/api/clear', monitor ? { monitor } : {}),
  );

/**
 * S2.03: wait_for_output — 等待串口输出匹配指定 pattern
 * AI 使用场景：提示用户烧录后，调用此 Tool 阻塞等待设备输出 "Ready" 等关键词
 * 默认先扫描现有缓冲区（配合 clear_serial_log 消除烧录后时序竞态），再订阅新日志
 */
  targetServer.tool(
  'wait_for_output',
  'Read-mostly wait operation. Waits for serial output matching a pattern using buffered logs and future output. Does not send data or modify device state.',
  {
    pattern: z.string().describe('Regex or text pattern to match in serial output'),
    timeout: z.number().optional().default(30).describe('Timeout in seconds (1-120), default 30'),
    scanBuffer: z.boolean().optional().default(true).describe('Scan existing log buffer before subscribing for new logs (default true). Use with clear_serial_log to catch output that arrived between clear and wait. Set false to only wait for future output.'),
    monitor: monitorParam,
  },
  async ({ pattern, timeout, scanBuffer, monitor }) => {
    const httpTimeoutMs = (timeout + 5) * 1000;
    const queryParams = `?pattern=${encodeURIComponent(pattern)}&timeout=${timeout}&scanBuffer=${scanBuffer}`;
    return requester('GET', withMonitor(`/api/log/wait${queryParams}`, monitor), undefined, httpTimeoutMs);
  },
  );

/**
 * send_and_wait — 原子性发送数据并等待匹配输出
 * AI 使用场景：发送命令后需要等待设备响应（如 AT → OK）
 * 优势：先订阅日志再发送数据，彻底消除 send + wait 的竞态条件
 */
  targetServer.tool(
  'send_and_wait',
  'Side-effectful device interaction. Sends data to the connected serial device, then waits for matching output. Preferred over separate send + wait when device state may change.',
  {
    data: z.string().describe('Data to send'),
    pattern: z.string().describe('Regex or text pattern to match in response'),
    timeout: z.number().optional().default(10).describe('Timeout in seconds (1-120), default 10'),
    hexMode: z.boolean().optional().default(false).describe('Send as HEX bytes (e.g. "41 42 0D 0A"), default false'),
    lineEnding: z.enum(['lf', 'crlf', 'cr', 'none']).optional().describe('Line ending to append. Uses current config if omitted'),
    monitor: monitorParam,
  },
  async ({ data, pattern, timeout, hexMode, lineEnding, monitor }) => {
    const httpTimeoutMs = (timeout + 5) * 1000;
    const body: Record<string, unknown> = { data, pattern, timeout, hexMode };
    if (lineEnding !== undefined) { body.lineEnding = lineEnding; }
    if (monitor !== undefined) { body.monitor = monitor; }
    return requester('POST', '/api/send-and-wait', body, httpTimeoutMs);
  },
  );

  // ============================================================
  // 多监视器管理工具 (P3)
  // ============================================================

  targetServer.tool(
    'list_monitors',
    'Read-only. Lists all Serial Monitors with index, name, connection state (port/baud when connected), RX/TX counters, buffered line count, and full config. Call this first to decide: reuse an existing monitor, update its config, create one, or delete then recreate.',
    {},
    async () => requester('GET', '/api/monitors'),
  );

  targetServer.tool(
    'create_monitor',
    'Local state change. Creates a new Serial Monitor (max 10). Index and default name (Serial MonitorN) are auto-assigned by smallest free slot; both are unique and addressable. Does not open any port.',
    { name: z.string().optional().describe('Optional unique display name; defaults to Serial MonitorN') },
    async ({ name }) => requester('POST', '/api/monitors', name !== undefined ? { name } : {}),
  );

  targetServer.tool(
    'delete_monitor',
    'Local state change. Deletes a Serial Monitor, silently disconnecting it first if connected. The last remaining monitor cannot be deleted. Its index/name become reusable for future creates.',
    { monitor: z.string().describe('Monitor to delete: index (e.g. "2") or unique name') },
    async ({ monitor }) => requester('DELETE', `/api/monitors/${encodeURIComponent(monitor)}`),
  );

  targetServer.tool(
    'rename_monitor',
    'Local state change. Renames a Serial Monitor (names must be unique, case-insensitive). The index never changes, so index-based references stay valid.',
    {
      monitor: z.string().describe('Monitor to rename: index or unique name'),
      name: z.string().describe('New unique name (1-64 chars)'),
    },
    async ({ monitor, name }) => requester('POST', `/api/monitors/${encodeURIComponent(monitor)}/rename`, { name }),
  );

  targetServer.tool(
    'get_monitor_config',
    'Read-only. Returns the serial/display config of a monitor (port, baud, dataBits, parity, stopBits, flowControl, lineEnding, encoding, hexMode, rxIdleWrapMs, logBufferKB).',
    { monitor: z.string().describe('Monitor: index or unique name') },
    async ({ monitor }) => requester('GET', `/api/monitors/${encodeURIComponent(monitor)}/config`),
  );

  targetServer.tool(
    'update_monitor_config',
    'Local state change. Updates display-level config of a monitor (lineEnding, encoding, hexMode, showTimestamp, rxIdleWrapMs, flowControl, logBufferKB). Connection parameters (port/baud/...) are set at connect time, not here.',
    {
      monitor: z.string().describe('Monitor: index or unique name'),
      lineEnding: z.enum(['lf', 'crlf', 'cr', 'none']).optional().describe('Default send line ending'),
      encoding: z.enum(['utf8', 'gbk']).optional().describe('RX decode / TX encode charset'),
      hexMode: z.boolean().optional().describe('HEX display mode for received data'),
      showTimestamp: z.boolean().optional().describe('Timestamp prefix on committed log lines'),
      rxIdleWrapMs: z.number().optional().describe('HEX idle-gap wrap threshold in ms (min 1)'),
      flowControl: z.enum(['none', 'rtscts', 'xon', 'xoff']).optional().describe('Flow control'),
      logBufferKB: z.number().optional().describe('Log buffer cap in KB (max 10240), shared by log view and Save/MCP readback'),
    },
    async ({ monitor, ...rest }) => {
      const body: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rest)) {
        if (value !== undefined) { body[key] = value; }
      }
      return requester('POST', `/api/monitors/${encodeURIComponent(monitor)}/config`, body);
    },
  );
}

// ============================================================
// 启动 MCP Server
// ============================================================

async function main() {
  registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP Server 通过 stdio 与 AI Client 通信，启动后等待请求
  // 注意：不要在 stdout 输出任何非 MCP 协议内容，否则会破坏通信
  console.error('[Serial Agent Plus MCP] Started, waiting for MCP Client connection...');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[Serial Agent Plus MCP] Failed to start:', error);
    process.exit(1);
  });
} else if (process.env.SERIALAGENT_PLUS_MCP_AUTOSTART !== '0') {
  // postbuild 的兼容入口（dist/index.js）通过本变量标记直接运行场景：
  // bundle 被 require 时若标记存在则同样启动服务器（bin / 全局安装 / npx 启动）。
  main().catch((error) => {
    console.error('[Serial Agent Plus MCP] Failed to start:', error);
    process.exit(1);
  });
}
