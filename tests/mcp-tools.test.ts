import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { registerTools } from '../packages/serialagent-plus-mcp/src/index';

type ToolHandler = (args: any) => Promise<any>;

interface ToolDef {
  description: string;
  schema: Record<string, unknown>;
  handler: ToolHandler;
}

class FakeMcpServer {
  readonly tools = new Map<string, ToolDef>();

  tool(name: string, description: string, schema: Record<string, unknown>, handler: ToolHandler): void {
    this.tools.set(name, { description, schema, handler });
  }
}

function getTool(server: FakeMcpServer, name: string): ToolDef {
  const tool = server.tools.get(name);
  if (!tool) { throw new Error(`Tool not found: ${name}`); }
  return tool;
}

function parseSchema(shape: Record<string, unknown>) {
  return z.object(shape as z.ZodRawShape);
}

describe('MCP tools registration and bridge mapping', () => {
  it('should register all 15 tools (9 core + 6 monitor management)', () => {
    const server = new FakeMcpServer();
    registerTools(server as any, vi.fn() as any);
    expect(server.tools.size).toBe(15);

    expect([...server.tools.keys()].sort()).toEqual([
      'clear_serial_log',
      'connect_serial',
      'create_monitor',
      'delete_monitor',
      'disconnect_serial',
      'get_monitor_config',
      'get_serial_status',
      'list_monitors',
      'list_serial_ports',
      'read_serial_log',
      'rename_monitor',
      'send_and_wait',
      'send_serial_data',
      'update_monitor_config',
      'wait_for_output',
    ]);
  });

  it('should enforce required input for connect_serial schema', () => {
    const server = new FakeMcpServer();
    registerTools(server as any, vi.fn() as any);
    const connect = getTool(server, 'connect_serial');
    const schema = parseSchema(connect.schema);

    const invalid = schema.safeParse({});
    expect(invalid.success).toBe(false);

    const parsed = schema.parse({ port: 'COM3' });
    expect(parsed.port).toBe('COM3');
    expect(parsed.baudRate).toBe(115200);
    expect(parsed.dataBits).toBe(8);
    expect(parsed.stopBits).toBe(1);
    expect(parsed.parity).toBe('none');
  });

  it('should map core serial tools to expected bridge endpoints', async () => {
    const requester = vi.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }));
    const server = new FakeMcpServer();
    registerTools(server as any, requester as any);

    await getTool(server, 'get_serial_status').handler({});
    await getTool(server, 'list_serial_ports').handler({});
    await getTool(server, 'connect_serial').handler({ port: 'COM7', baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' });
    await getTool(server, 'disconnect_serial').handler({});
    await getTool(server, 'read_serial_log').handler({ lines: 20 });
    await getTool(server, 'send_serial_data').handler({ data: 'AT', hexMode: false });
    await getTool(server, 'clear_serial_log').handler({});

    expect(requester).toHaveBeenCalledWith('GET', '/api/status');
    expect(requester).toHaveBeenCalledWith('GET', '/api/ports');
    expect(requester).toHaveBeenCalledWith('POST', '/api/connect', { port: 'COM7', baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' });
    expect(requester).toHaveBeenCalledWith('POST', '/api/disconnect', {});
    expect(requester).toHaveBeenCalledWith('GET', '/api/log?lines=20');
    expect(requester).toHaveBeenCalledWith('POST', '/api/send', { data: 'AT', hexMode: false });
    expect(requester).toHaveBeenCalledWith('POST', '/api/clear', {});
  });

  it('should route monitor-scoped tools by index or name', async () => {
    const requester = vi.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }));
    const server = new FakeMcpServer();
    registerTools(server as any, requester as any);

    await getTool(server, 'get_serial_status').handler({ monitor: '2' });
    await getTool(server, 'read_serial_log').handler({ lines: 10, monitor: 'RTT' });
    await getTool(server, 'send_serial_data').handler({ data: 'AT', hexMode: false, monitor: '2' });
    await getTool(server, 'disconnect_serial').handler({ monitor: 'RTT' });
    await getTool(server, 'wait_for_output').handler({ pattern: 'OK', timeout: 5, scanBuffer: false, monitor: '3' });

    expect(requester).toHaveBeenCalledWith('GET', '/api/status?monitor=2');
    expect(requester).toHaveBeenCalledWith('GET', '/api/log?lines=10&monitor=RTT');
    expect(requester).toHaveBeenCalledWith('POST', '/api/send', { data: 'AT', hexMode: false, monitor: '2' });
    expect(requester).toHaveBeenCalledWith('POST', '/api/disconnect', { monitor: 'RTT' });
    expect(requester).toHaveBeenCalledWith(
      'GET',
      '/api/log/wait?pattern=OK&timeout=5&scanBuffer=false&monitor=3',
      undefined,
      10000,
    );
  });

  it('should map monitor management tools to management endpoints', async () => {
    const requester = vi.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }));
    const server = new FakeMcpServer();
    registerTools(server as any, requester as any);

    await getTool(server, 'list_monitors').handler({});
    await getTool(server, 'create_monitor').handler({ name: 'RTT' });
    await getTool(server, 'create_monitor').handler({});
    await getTool(server, 'delete_monitor').handler({ monitor: '2' });
    await getTool(server, 'rename_monitor').handler({ monitor: 'RTT', name: 'Debug UART' });
    await getTool(server, 'get_monitor_config').handler({ monitor: '1' });
    await getTool(server, 'update_monitor_config').handler({ monitor: '1', showTimestamp: true, rxIdleWrapMs: 50 });

    expect(requester).toHaveBeenCalledWith('GET', '/api/monitors');
    expect(requester).toHaveBeenCalledWith('POST', '/api/monitors', { name: 'RTT' });
    expect(requester).toHaveBeenCalledWith('POST', '/api/monitors', {});
    expect(requester).toHaveBeenCalledWith('DELETE', '/api/monitors/2');
    expect(requester).toHaveBeenCalledWith('POST', '/api/monitors/RTT/rename', { name: 'Debug UART' });
    expect(requester).toHaveBeenCalledWith('GET', '/api/monitors/1/config');
    expect(requester).toHaveBeenCalledWith('POST', '/api/monitors/1/config', { showTimestamp: true, rxIdleWrapMs: 50 });
  });

  it('wait_for_output should encode query and set timeoutMs', async () => {
    const requester = vi.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }));
    const server = new FakeMcpServer();
    registerTools(server as any, requester as any);

    await getTool(server, 'wait_for_output').handler({ pattern: '[ERROR] GPIO', timeout: 3, scanBuffer: true });

    expect(requester).toHaveBeenCalledWith(
      'GET',
      '/api/log/wait?pattern=%5BERROR%5D%20GPIO&timeout=3&scanBuffer=true',
      undefined,
      8000,
    );
  });

  it('send_and_wait should map body and timeoutMs correctly', async () => {
    const requester = vi.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }));
    const server = new FakeMcpServer();
    registerTools(server as any, requester as any);

    await getTool(server, 'send_and_wait').handler({
      data: 'AT',
      pattern: 'OK',
      timeout: 10,
      hexMode: false,
      lineEnding: 'crlf',
    });

    expect(requester).toHaveBeenCalledWith(
      'POST',
      '/api/send-and-wait',
      { data: 'AT', pattern: 'OK', timeout: 10, hexMode: false, lineEnding: 'crlf' },
      15000,
    );
  });
});

