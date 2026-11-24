/**
 * Bridge Server REST API 单元测试
 *
 * 测试 Bridge Server 对外暴露的 HTTP REST API 端点。
 * 使用 BridgeServer + MockSerialManager 进行真实 HTTP 请求测试。
 *
 * 对应 spec.md §8.2 Bridge Server API 测试用例 (T-B01 ~ T-B15)
 * 对应 Plan.md S1.20
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'http';
import { BridgeServer } from '../packages/serialagent-plus/src/bridge-server';
import { MockSerialManager } from './mocks/mock-serial-manager';
import { ILogger } from '../packages/serialagent-plus/src/types';

// ---- 测试工具 ----

/** 静默日志记录器（测试中不输出） */
class SilentLogger implements ILogger {
  readonly lines: string[] = [];
  appendLine(value: string): void { this.lines.push(value); }
}

/** 发送 HTTP 请求并返回解析后的响应 */
function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: object,
  headers?: Record<string, string>,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: string) => { raw += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode ?? 0, data: raw }); }
        });
      },
    );
    req.on('error', reject);
    if (body) { req.write(JSON.stringify(body)); }
    req.end();
  });
}

/** 发送原始 HTTP 请求（用于 OPTIONS/非法 JSON 等场景） */
function rawHttpRequest(
  port: number,
  method: string,
  path: string,
  rawBody?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: string) => { raw += chunk; });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            text: raw,
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    if (rawBody !== undefined) { req.write(rawBody); }
    req.end();
  });
}

// ---- 测试套件 ----

/** 单监视器 BridgeHost 适配器：把 MockSerialManager 包成 host（bridge 按监视器路由） */
class SingleMonitorHost {
  readonly id = 'm1';
  readonly index = 1;
  readonly name = 'Serial Monitor1';
  constructor(private readonly sm: MockSerialManager) {}
  list() {
    return [{
      id: this.id, index: this.index, name: this.name,
      connected: this.sm.isConnected, port: this.sm.currentPath, baudRate: this.sm.currentBaudRate,
    }];
  }
  runtimeByRef(ref: number | string) {
    const key = String(ref).toLowerCase();
    if (key === '1' || key === this.name.toLowerCase()) { return this.primary(); }
    return undefined;
  }
  primary() {
    return { meta: { id: this.id, index: this.index, name: this.name, config: this.sm.config }, manager: this.sm };
  }
  createMonitor(): never { throw new Error('Monitor limit reached (10)'); }
  deleteMonitor(): never { throw new Error('At least one monitor must remain'); }
  renameMonitor(): never { throw new Error('Rename not supported by stub'); }
  updateMonitorConfig(_id: string, partial: Partial<typeof MockSerialManager.prototype.config>) {
    this.sm.updateSettings(partial as never);
    return this.sm.config;
  }
  async connect(_id: string, config: Parameters<MockSerialManager['connect']>[0]) {
    const ok = await this.sm.connect(config);
    return ok ? { ok: true } : { ok: false, error: 'Failed to connect' };
  }
}

describe('Bridge Server API', () => {
  let mock: MockSerialManager;
  let logger: SilentLogger;
  let bridge: BridgeServer;
  let port: number;
  let token: string;

  /** 带 Token 的请求快捷方法 */
  function authRequest(method: string, path: string, body?: object) {
    return httpRequest(port, method, path, body, { 'Authorization': `Bearer ${token}` });
  }

  beforeAll(async () => {
    mock = new MockSerialManager();
    logger = new SilentLogger();
    bridge = new BridgeServer(new SingleMonitorHost(mock) as never, logger);
    await bridge.start();
    port = bridge.port;
    token = bridge.token;
  });

  afterAll(async () => {
    await bridge.stop();
  });

  beforeEach(() => {
    mock.reset();
  });

  // ======== 认证 (S1.10) ========

  describe('认证 (Token Auth)', () => {
    it('T-B01: 无 Token 请求任意 API 应返回 401', async () => {
      const res = await httpRequest(port, 'GET', '/api/status');
      expect(res.status).toBe(401);
      expect(res.data.success).toBe(false);
      expect(res.data.error.code).toBe('AUTH_REQUIRED');
      expect(res.data.error.message).toContain('Authorization');
    });

    it('T-B02: 错误 Token 请求应返回 401', async () => {
      const res = await httpRequest(port, 'GET', '/api/status', undefined, {
        'Authorization': 'Bearer wrong-token-12345',
      });
      expect(res.status).toBe(401);
      expect(res.data.success).toBe(false);
      expect(res.data.error.code).toBe('AUTH_INVALID_TOKEN');
    });

    it('T-B02b: 正确 Token 请求应返回 200', async () => {
      const res = await authRequest('GET', '/api/status');
      expect(res.status).toBe(200);
    });
  });

  // ======== GET /api/status (S1.03) ========

  describe('GET /api/status', () => {
    it('未连接时返回 connected: false', async () => {
      const res = await authRequest('GET', '/api/status');
      expect(res.status).toBe(200);
      expect(res.data.connected).toBe(false);
      expect(res.data.bufferedLines).toBe(0);
      expect(res.data.isReconnecting).toBe(false);
    });

    it('连接后返回 connected: true + 端口/波特率信息', async () => {
      mock.setMockPorts([{ path: 'COM3', manufacturer: 'Test' }]);
      await mock.connect({ port: 'COM3', baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1, lineEnding: 'lf', showTimestamp: false, hexMode: false });
      const res = await authRequest('GET', '/api/status');
      expect(res.status).toBe(200);
      expect(res.data.connected).toBe(true);
      expect(res.data.port).toBe('COM3');
      expect(res.data.baudRate).toBe(115200);
    });
  });

  // ======== GET /api/ports (S1.04) ========

  describe('GET /api/ports', () => {
    it('T-B03: 无设备插入时应返回空数组', async () => {
      const res = await authRequest('GET', '/api/ports');
      expect(res.status).toBe(200);
      expect(res.data.ports).toEqual([]);
    });

    it('T-B04: 有设备时应返回设备信息数组', async () => {
      mock.setMockPorts([
        { path: 'COM3', manufacturer: 'Silicon Labs', vendorId: '10C4', productId: 'EA60' },
        { path: 'COM5', manufacturer: 'FTDI' },
      ]);
      const res = await authRequest('GET', '/api/ports');
      expect(res.status).toBe(200);
      expect(res.data.ports).toHaveLength(2);
      expect(res.data.ports[0].path).toBe('COM3');
      expect(res.data.ports[0].manufacturer).toBe('Silicon Labs');
      expect(res.data.ports[1].path).toBe('COM5');
    });
  });

  // ======== POST /api/connect (S1.05) ========

  describe('POST /api/connect', () => {
    it('T-B05: 合法端口应连接成功', async () => {
      mock.setMockPorts([{ path: 'COM3' }]);
      const res = await authRequest('POST', '/api/connect', { port: 'COM3', baudRate: 115200 });
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.message).toContain('COM3');
      expect(mock.isConnected).toBe(true);
    });

    it('T-B06: 非法端口应返回错误', async () => {
      mock.setMockPorts([{ path: 'COM3' }]);
      mock.setPortFail('COM3');
      const res = await authRequest('POST', '/api/connect', { port: 'COM3' });
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('T-B06b: 缺少 port 字段应返回 400', async () => {
      const res = await authRequest('POST', '/api/connect', { baudRate: 115200 });
      expect(res.status).toBe(400);
      expect(res.data.error.code).toBe('MISSING_REQUIRED_FIELD');
      expect(res.data.error.message).toContain('port');
    });

    it('无效 baudRate 应返回 400', async () => {
      mock.setMockPorts([{ path: 'COM3' }]);
      const res = await authRequest('POST', '/api/connect', { port: 'COM3', baudRate: -9600 });
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
      expect(res.data.error.code).toBe('INVALID_ARGUMENT');
      expect(res.data.error.message).toContain('baudRate');
    });

    it('无效 parity 应返回 400', async () => {
      mock.setMockPorts([{ path: 'COM3' }]);
      const res = await authRequest('POST', '/api/connect', { port: 'COM3', parity: 'bad-parity' });
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
      expect(res.data.error.code).toBe('INVALID_ARGUMENT');
      expect(res.data.error.message).toContain('parity');
    });

    it('无效 flowControl 应返回 400', async () => {
      mock.setMockPorts([{ path: 'COM3' }]);
      const res = await authRequest('POST', '/api/connect', { port: 'COM3', flowControl: 'bad-flow' });
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
      expect(res.data.error.code).toBe('INVALID_ARGUMENT');
      expect(res.data.error.message).toContain('flowControl');
    });

    it('T-B07: 已连接时再连接应先断开旧连接', async () => {
      mock.setMockPorts([{ path: 'COM3' }, { path: 'COM5' }]);
      await authRequest('POST', '/api/connect', { port: 'COM3' });
      expect(mock.currentPath).toBe('COM3');
      await authRequest('POST', '/api/connect', { port: 'COM5' });
      expect(mock.currentPath).toBe('COM5');
      expect(mock.isConnected).toBe(true);
    });
  });

  // ======== POST /api/disconnect (S1.06) ========

  describe('POST /api/disconnect', () => {
    it('T-B08: 未连接时断开应返回 success（幂等）', async () => {
      const res = await authRequest('POST', '/api/disconnect');
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
    });

    it('连接后断开应成功', async () => {
      mock.setMockPorts([{ path: 'COM3' }]);
      await authRequest('POST', '/api/connect', { port: 'COM3' });
      expect(mock.isConnected).toBe(true);
      const res = await authRequest('POST', '/api/disconnect');
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(mock.isConnected).toBe(false);
    });
  });

  // ======== GET /api/log (S1.07) ========

  describe('GET /api/log', () => {
    it('T-B09: 缓冲区为空时应返回空数组', async () => {
      const res = await authRequest('GET', '/api/log');
      expect(res.status).toBe(200);
      expect(res.data.lines).toEqual([]);
      expect(res.data.totalBuffered).toBe(0);
    });

    it('T-B10: lines=5 且缓冲区有 100 行时应返回最后 5 行', async () => {
      for (let i = 0; i < 100; i++) {
        mock.simulateLog(`Line ${i}`);
      }
      const res = await authRequest('GET', '/api/log?lines=5');
      expect(res.status).toBe(200);
      expect(res.data.lines).toHaveLength(5);
      expect(res.data.lines[0]).toBe('Line 95');
      expect(res.data.lines[4]).toBe('Line 99');
      expect(res.data.totalBuffered).toBe(100);
    });

    it('默认返回 50 行', async () => {
      for (let i = 0; i < 80; i++) {
        mock.simulateLog(`Log ${i}`);
      }
      const res = await authRequest('GET', '/api/log');
      expect(res.status).toBe(200);
      expect(res.data.lines).toHaveLength(50);
      expect(res.data.lines[0]).toBe('Log 30');
    });
  });

  // ======== POST /api/send (S1.08) ========

  describe('POST /api/send', () => {
    it('T-B11: 未连接时发送应返回失败', async () => {
      const res = await authRequest('POST', '/api/send', { data: 'hello' });
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
      expect(res.data.error.code).toBe('SERIAL_NOT_CONNECTED');
      expect(res.data.error.message).toContain('Not connected');
    });

    it('T-B12: HEX 格式错误应返回错误提示', async () => {
      mock.setMockPorts([{ path: 'COM3' }]);
      await mock.connect({ port: 'COM3', baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1, lineEnding: 'lf', showTimestamp: false, hexMode: false });
      const res = await authRequest('POST', '/api/send', { data: 'ZZZZ', hexMode: true });
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('文本模式发送成功', async () => {
      mock.setMockPorts([{ path: 'COM3' }]);
      await mock.connect({ port: 'COM3', baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1, lineEnding: 'lf', showTimestamp: false, hexMode: false });
      const res = await authRequest('POST', '/api/send', { data: 'AT+RST', lineEnding: 'crlf' });
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.bytesSent).toBeGreaterThan(0);
    });

    it('缺少 data 字段应返回 400', async () => {
      mock.setMockPorts([{ path: 'COM3' }]);
      await mock.connect({ port: 'COM3', baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1, lineEnding: 'lf', showTimestamp: false, hexMode: false });
      const res = await authRequest('POST', '/api/send', {});
      expect(res.status).toBe(400);
      expect(res.data.error.code).toBe('MISSING_REQUIRED_FIELD');
      expect(res.data.error.message).toContain('data');
    });
  });

  // ======== POST /api/clear (S1.09) ========

  describe('POST /api/clear', () => {
    it('清空后日志缓冲区为空', async () => {
      mock.simulateLogs(['line1', 'line2', 'line3']);
      expect(mock.getLogBuffer()).toHaveLength(3);
      const res = await authRequest('POST', '/api/clear');
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      // 验证缓冲区已清空
      const logRes = await authRequest('GET', '/api/log');
      expect(logRes.data.lines).toEqual([]);
      expect(logRes.data.totalBuffered).toBe(0);
    });
  });

  // ======== GET /api/log/wait (S2.02) ========

  describe('GET /api/log/wait', () => {
    it('缺少 pattern 参数应返回 400', async () => {
      const res = await authRequest('GET', '/api/log/wait');
      expect(res.status).toBe(400);
      expect(res.data.error.code).toBe('MISSING_REQUIRED_PARAMETER');
      expect(res.data.error.message).toContain('pattern');
    });

    it('T-B13: pattern 匹配成功应立即返回 found: true', async () => {
      // 延迟 100ms 后模拟设备输出
      setTimeout(() => {
        mock.simulateLog('Booting...');
        mock.simulateLog('System Ready');
      }, 100);

      const res = await authRequest('GET', '/api/log/wait?pattern=Ready&timeout=5');
      expect(res.status).toBe(200);
      expect(res.data.found).toBe(true);
      expect(res.data.matchedLine).toContain('Ready');
      expect(res.data.waitedMs).toBeLessThan(3000);
      expect(res.data.recentLogs).toBeInstanceOf(Array);
    });

    it('T-B14: 超时应返回 found: false', async () => {
      const res = await authRequest('GET', '/api/log/wait?pattern=NeverMatch&timeout=1');
      expect(res.status).toBe(200);
      expect(res.data.found).toBe(false);
      expect(res.data.waitedMs).toBeGreaterThanOrEqual(900);
      expect(res.data.hint).toBeTruthy();
    });

    it('缓冲区已有匹配数据时立即返回（修复竞态条件）', async () => {
      mock.simulateLog('Old log: System Ready');
      const res = await authRequest('GET', '/api/log/wait?pattern=Ready&timeout=1');
      expect(res.status).toBe(200);
      expect(res.data.found).toBe(true);
      expect(res.data.matchedLine).toContain('Ready');
      expect(res.data.waitedMs).toBeLessThan(100);
    });

    it('fromNow 参数已废弃，始终先检查缓冲区', async () => {
      mock.simulateLog('Buffered: Boot OK');
      // 即使传 fromNow=true，也应该先检查缓冲区
      const res = await authRequest('GET', '/api/log/wait?pattern=Boot%20OK&timeout=1&fromNow=true');
      expect(res.status).toBe(200);
      expect(res.data.found).toBe(true);
      expect(res.data.matchedLine).toContain('Boot OK');
    });

    it('正则表达式 pattern 支持', async () => {
      setTimeout(() => {
        mock.simulateLog('[ERROR] GPIO5: invalid pin');
      }, 50);

      const res = await authRequest('GET', `/api/log/wait?pattern=${encodeURIComponent('\\[ERROR\\].*GPIO')}&timeout=3`);
      expect(res.status).toBe(200);
      expect(res.data.found).toBe(true);
      expect(res.data.matchedLine).toContain('GPIO5');
    });
  });

  // ======== POST /api/send-and-wait ========

  describe('POST /api/send-and-wait', () => {
    it('缺少 data 字段应返回 400', async () => {
      const res = await authRequest('POST', '/api/send-and-wait', { pattern: 'OK' });
      expect(res.status).toBe(400);
      expect(res.data.error.code).toBe('MISSING_REQUIRED_FIELD');
      expect(res.data.error.message).toContain('data');
    });

    it('缺少 pattern 字段应返回 400', async () => {
      const res = await authRequest('POST', '/api/send-and-wait', { data: 'AT' });
      expect(res.status).toBe(400);
      expect(res.data.error.code).toBe('MISSING_REQUIRED_FIELD');
      expect(res.data.error.message).toContain('pattern');
    });

    it('未连接时应返回 400', async () => {
      const res = await authRequest('POST', '/api/send-and-wait', { data: 'AT', pattern: 'OK' });
      expect(res.status).toBe(400);
      expect(res.data.error.code).toBe('SERIAL_NOT_CONNECTED');
      expect(res.data.error.message).toContain('Not connected');
    });

    it('原子性发送并匹配响应（自动响应模拟）', async () => {
      mock.setMockPorts([{ path: 'COM3' }]);
      await mock.connect({ port: 'COM3', baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1, lineEnding: 'lf', showTimestamp: false, hexMode: false });
      mock.setAutoResponse('AT', 'OK', 10);

      const res = await authRequest('POST', '/api/send-and-wait', {
        data: 'AT',
        pattern: 'OK',
        timeout: 5,
        lineEnding: 'crlf',
      });
      expect(res.status).toBe(200);
      expect(res.data.sendSuccess).toBe(true);
      expect(res.data.found).toBe(true);
      expect(res.data.matchedLine).toBe('OK');
      expect(res.data.waitedMs).toBeLessThan(3000);
    });

    it('响应超时时返回 found: false', async () => {
      mock.setMockPorts([{ path: 'COM3' }]);
      await mock.connect({ port: 'COM3', baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1, lineEnding: 'lf', showTimestamp: false, hexMode: false });
      // 不设置 auto-response，设备不会响应

      const res = await authRequest('POST', '/api/send-and-wait', {
        data: 'AT',
        pattern: 'OK',
        timeout: 1,
      });
      expect(res.status).toBe(200);
      expect(res.data.sendSuccess).toBe(true);
      expect(res.data.found).toBe(false);
      expect(res.data.waitedMs).toBeGreaterThanOrEqual(900);
      expect(res.data.hint).toBeTruthy();
    });

    it('发送失败时返回 sendSuccess: false', async () => {
      mock.setMockPorts([{ path: 'COM3' }]);
      await mock.connect({ port: 'COM3', baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1, lineEnding: 'lf', showTimestamp: false, hexMode: false });

      // HEX 格式错误导致发送失败
      const res = await authRequest('POST', '/api/send-and-wait', {
        data: 'ZZZZ',
        pattern: 'OK',
        hexMode: true,
      });
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
      expect(res.data.error.code).toBe('SERIAL_SEND_FAILED');
    });

    it('Echo 注入到日志缓冲区', async () => {
      mock.setMockPorts([{ path: 'COM3' }]);
      await mock.connect({ port: 'COM3', baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1, lineEnding: 'lf', showTimestamp: false, hexMode: false });
      mock.setAutoResponse('ver', 'Firmware v1.0.0', 10);

      await authRequest('POST', '/api/send-and-wait', {
        data: 'ver',
        pattern: 'Firmware',
        timeout: 5,
      });

      // 检查 Echo 和响应都在缓冲区中
      const logRes = await authRequest('GET', '/api/log');
      expect(logRes.data.lines).toContain('MCP TX>> ver');
      expect(logRes.data.lines).toContain('Firmware v1.0.0');
    });

    it('并发 send-and-wait 请求应各自匹配到对应响应', async () => {
      mock.setMockPorts([{ path: 'COM3' }]);
      await mock.connect({ port: 'COM3', baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1, lineEnding: 'lf', showTimestamp: false, hexMode: false });
      mock.setAutoResponse('CMD1', 'RSP1', 20);
      mock.setAutoResponse('CMD2', 'RSP2', 10);

      const [res1, res2] = await Promise.all([
        authRequest('POST', '/api/send-and-wait', { data: 'CMD1', pattern: 'RSP1', timeout: 3 }),
        authRequest('POST', '/api/send-and-wait', { data: 'CMD2', pattern: 'RSP2', timeout: 3 }),
      ]);

      expect(res1.status).toBe(200);
      expect(res1.data.sendSuccess).toBe(true);
      expect(res1.data.found).toBe(true);
      expect(res1.data.matchedLine).toBe('RSP1');

      expect(res2.status).toBe(200);
      expect(res2.data.sendSuccess).toBe(true);
      expect(res2.data.found).toBe(true);
      expect(res2.data.matchedLine).toBe('RSP2');
    });
  });

  // ======== GET /api/status 状态提示 ========

  describe('GET /api/status (statusHint)', () => {
    it('未连接且无历史数据时无 statusHint', async () => {
      const res = await authRequest('GET', '/api/status');
      expect(res.status).toBe(200);
      expect(res.data.connected).toBe(false);
      expect(res.data.statusHint).toBeUndefined();
    });

    it('未连接但有历史数据时附带 statusHint', async () => {
      // 模拟曾经有数据但当前断开的场景
      mock.simulateLog('Some old log');
      const res = await authRequest('GET', '/api/status');
      expect(res.status).toBe(200);
      expect(res.data.connected).toBe(false);
      expect(res.data.rxBytes).toBeGreaterThan(0);
      expect(res.data.statusHint).toBeTruthy();
      expect(res.data.statusHint).toContain('historical activity');
    });

    it('已连接时无 statusHint', async () => {
      mock.setMockPorts([{ path: 'COM3' }]);
      await mock.connect({ port: 'COM3', baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1, lineEnding: 'lf', showTimestamp: false, hexMode: false });
      const res = await authRequest('GET', '/api/status');
      expect(res.status).toBe(200);
      expect(res.data.connected).toBe(true);
      expect(res.data.statusHint).toBeUndefined();
    });
  });

  // ======== 404 处理 ========

  describe('路由错误', () => {
    it('不存在的路径应返回 404', async () => {
      const res = await authRequest('GET', '/api/nonexistent');
      expect(res.status).toBe(404);
      expect(res.data.error.code).toBe('NOT_FOUND');
      expect(res.data.error.message).toContain('Not found');
    });
  });

  describe('协议与格式一致性', () => {
    it('OPTIONS 预检请求：本地 Origin 应回显允许源', async () => {
      const res = await rawHttpRequest(port, 'OPTIONS', '/api/status', undefined, {
        Origin: 'http://localhost:3000',
      });
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
      expect(String(res.headers['access-control-allow-methods'])).toContain('GET');
      expect(String(res.headers['access-control-allow-methods'])).toContain('POST');
      expect(String(res.headers['access-control-allow-headers'])).toContain('Authorization');
    });

    it('OPTIONS 预检请求：非本地 Origin 不应返回 Access-Control-Allow-Origin', async () => {
      const res = await rawHttpRequest(port, 'OPTIONS', '/api/status', undefined, {
        Origin: 'https://evil.example.com',
      });
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(String(res.headers['access-control-allow-methods'])).toContain('GET');
      expect(String(res.headers['access-control-allow-headers'])).toContain('Authorization');
    });

    it('非法 JSON body 应返回 400 且包含统一错误信息', async () => {
      const res = await rawHttpRequest(
        port,
        'POST',
        '/api/connect',
        '{"port":"COM3"',
        {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      );
      expect(res.status).toBe(400);
      const parsed = JSON.parse(res.text) as { success: boolean; error: { code: string; message: string } };
      expect(parsed.success).toBe(false);
      expect(parsed.error.code).toBe('INVALID_JSON_BODY');
      expect(parsed.error.message).toContain('Invalid JSON body');
    });
  });
});

// ======== 多监视器管理 (P3) ========

/** 可编程假宿主：内存态增删改名，manager 复用同一个 Mock */
class FakeHost {
  private seq = 0;
  private monitors = new Map<string, { id: string; index: number; name: string }>();
  constructor(private readonly sm: MockSerialManager) {
    this.monitors.set('m1', { id: 'm1', index: 1, name: 'Serial Monitor1' });
  }
  private sorted() { return [...this.monitors.values()].sort((a, b) => a.index - b.index); }
  list() {
    return this.sorted().map((m) => ({
      id: m.id, index: m.index, name: m.name,
      connected: this.sm.isConnected, port: this.sm.currentPath, baudRate: this.sm.currentBaudRate,
    }));
  }
  runtimeByRef(ref: number | string) {
    const key = String(ref).toLowerCase();
    const found = this.sorted().find((m) => String(m.index) === key || m.name.toLowerCase() === key);
    if (!found) { return undefined; }
    return { meta: { ...found, config: this.sm.config }, manager: this.sm };
  }
  primary() { return this.runtimeByRef(1)!; }
  createMonitor(name?: string) {
    if (this.monitors.size >= 10) { throw new Error('Monitor limit reached (10)'); }
    const usedIndexes = new Set(this.sorted().map((m) => m.index));
    const usedNames = new Set(this.sorted().map((m) => m.name.toLowerCase()));
    let index = 1; while (usedIndexes.has(index)) { index++; }
    let finalName = (name ?? '').trim() || `Serial Monitor${(() => { let i = 1; while (usedNames.has(`serial monitor${i}`)) { i++; } return i; })()}`;
    if (usedNames.has(finalName.toLowerCase())) { throw new Error(`Name already in use: ${finalName}`); }
    const id = `m${++this.seq + 1}`;
    const created = { id, index, name: finalName };
    this.monitors.set(id, created);
    return created;
  }
  deleteMonitor(id: string) {
    if (this.monitors.size <= 1) { throw new Error('At least one monitor must remain'); }
    if (!this.monitors.has(id)) { throw new Error(`Monitor not found: ${id}`); }
    this.monitors.delete(id);
  }
  renameMonitor(id: string, name: string) {
    const m = this.monitors.get(id);
    if (!m) { throw new Error(`Monitor not found: ${id}`); }
    const taken = this.sorted().some((o) => o.id !== id && o.name.toLowerCase() === name.toLowerCase());
    if (taken) { throw new Error(`Name already in use: ${name}`); }
    m.name = name;
    return { ...m };
  }
  updateMonitorConfig(_id: string, partial: Partial<MockSerialManager['config']>) {
    this.sm.updateSettings(partial as never);
    return this.sm.config;
  }
  async connect(_id: string, config: Parameters<MockSerialManager['connect']>[0]) {
    const ok = await this.sm.connect(config);
    return ok ? { ok: true } : { ok: false, error: 'Failed to connect' };
  }
}

describe('Bridge Server multi-monitor management (P3)', () => {
  let bridge2: BridgeServer;
  let port2: number;
  let token2: string;
  let host: FakeHost;

  function req(method: string, path: string, body?: object) {
    return httpRequest(port2, method, path, body, { 'Authorization': `Bearer ${token2}` });
  }

  beforeAll(async () => {
    host = new FakeHost(new MockSerialManager());
    bridge2 = new BridgeServer(host as never, new SilentLogger());
    await bridge2.start();
    port2 = bridge2.port;
    token2 = bridge2.token;
  });
  afterAll(async () => { await bridge2.stop(); });

  it('M1: lists monitors with labels and config', async () => {
    const res = await req('GET', '/api/monitors');
    expect(res.status).toBe(200);
    expect(res.data.count).toBe(1);
    expect(res.data.monitors[0].label).toBe('1=Serial Monitor1');
    expect(res.data.monitors[0].config).toBeTruthy();
  });

  it('M2: create assigns smallest free index/name and they are addressable', async () => {
    const res = await req('POST', '/api/monitors', { name: 'RTT' });
    expect(res.status).toBe(201);
    expect(res.data.monitor.index).toBe(2);
    expect(res.data.monitor.name).toBe('RTT');

    // 多监视器存在时缺省 target 报错并列出候选
    const err = await req('GET', '/api/status');
    expect(err.status).toBe(400);
    expect(err.data.error.code).toBe('MONITOR_REQUIRED');
    expect(err.data.error.details.monitors).toContain('2=RTT');

    // 按 name 路由
    const byName = await req('GET', '/api/status?monitor=RTT');
    expect(byName.status).toBe(200);
    expect(byName.data.monitor).toBe('2=RTT');

    // 按 index 路由
    const byIndex = await req('GET', '/api/log?monitor=2&lines=5');
    expect(byIndex.status).toBe(200);
    expect(byIndex.data.monitor).toBe('2=RTT');

    // 未知引用
    const missing = await req('GET', '/api/status?monitor=9');
    expect(missing.status).toBe(404);
    expect(missing.data.error.code).toBe('MONITOR_NOT_FOUND');
  });

  it('M3: rename enforces uniqueness', async () => {
    const ok = await req('POST', '/api/monitors/RTT/rename', { name: 'Debug UART' });
    expect(ok.status).toBe(200);
    expect(ok.data.label).toBe('2=Debug UART');

    const dup = await req('POST', '/api/monitors/1/rename', { name: 'debug uart' });
    expect(dup.status).toBe(400);
  });

  it('M3b: path refs are percent-decoded before name resolution', async () => {
    // MCP 客户端总是 encodeURIComponent 监视器名："Debug UART" → "Debug%20UART"
    const get = await req('GET', '/api/monitors/Debug%20UART/config');
    expect(get.status).toBe(200);
    expect(get.data.monitor).toBe('2=Debug UART');

    const renamed = await req('POST', '/api/monitors/Debug%20UART/rename', { name: 'RTT' });
    expect(renamed.status).toBe(200);
    expect(renamed.data.label).toBe('2=RTT');
  });

  it('M4: config get/set updates display settings', async () => {
    const set = await req('POST', '/api/monitors/2/config', { showTimestamp: true, rxIdleWrapMs: 50 });
    expect(set.status).toBe(200);
    expect(set.data.config.showTimestamp).toBe(true);

    const get = await req('GET', '/api/monitors/2/config');
    expect(get.data.config.rxIdleWrapMs).toBe(50);
  });

  it('M5: delete removes the monitor; last one cannot be deleted', async () => {
    const del = await req('DELETE', '/api/monitors/2');
    expect(del.status).toBe(200);

    const last = await req('DELETE', '/api/monitors/1');
    expect(last.status).toBe(409);
    expect(last.data.error.code).toBe('MONITOR_MINIMUM');
  });
});
