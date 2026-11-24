import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

/**
 * MCP 入口回归：dist/index.js 直接运行必须启动服务器并响应 initialize。
 * 历史缺陷：兼容入口仅 require bundle，bundle 内 require.main !== module，
 * main() 永不执行 —— 全局安装 / npx 启动时进程静默退出（无任何输出）。
 */
describe('MCP dist entry starts the server (bin/npx scenario)', () => {
  it('responds to initialize over stdio', async () => {
    const entry = path.resolve(__dirname, '..', 'packages', 'serialagent-plus-mcp', 'dist', 'index.js');
    const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });

    const result = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
      let buffer = '';
      const timer = setTimeout(() => resolve({ ok: false, detail: `timeout; stdout=${JSON.stringify(buffer.slice(0, 200))}` }), 10000);
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const idx = buffer.indexOf('\n');
        if (idx === -1) { return; }
        const line = buffer.slice(0, idx).trim();
        try {
          const resp = JSON.parse(line);
          if (resp.id === 1 && resp.result?.serverInfo?.name) {
            clearTimeout(timer);
            resolve({ ok: true, detail: resp.result.serverInfo.name });
          }
        } catch { /* not JSON-RPC */ }
      });
      child.stderr.on('data', () => { /* startup log expected */ });
      const req = {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
      };
      child.stdin.write(JSON.stringify(req) + '\n');
    });

    child.kill();

    expect(result.ok).toBe(true);
    expect(result.detail).toBe('serialagent-plus-mcp');
  }, 15000);
});
