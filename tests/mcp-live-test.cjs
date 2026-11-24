const { spawn } = require('child_process');
const path = require('path');

const child = spawn(process.execPath, [path.join(__dirname, '..', 'packages', 'serialagent-plus-mcp', 'dist', 'index.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_monitors', arguments: {} } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_serial_status', arguments: { monitor: '1' } } },
  { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'read_serial_log', arguments: { lines: 3, monitor: '1' } } },
];

const seen = [];
let buffer = '';
const timeout = setTimeout(() => { console.log('TIMEOUT waiting for responses'); child.kill(); process.exit(1); }, 15000);

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) { continue; }
    try {
      const resp = JSON.parse(line);
      if (resp.id === 1) {
        console.log('initialize OK ->', resp.result.serverInfo.name, resp.result.serverInfo.version);
      } else if (resp.id === 2) {
        const names = resp.result.tools.map((t) => t.name);
        console.log(`tools/list OK -> ${names.length} tools:`);
        names.forEach((n) => console.log('  -', n));
      } else if (resp.id === 3) {
        const parsed = JSON.parse(resp.result.content[0].text);
        console.log(`list_monitors OK -> count=${parsed.count}:`, parsed.monitors.map((m) => m.label).join(', '));
      } else if (resp.id === 4) {
        const parsed = JSON.parse(resp.result.content[0].text);
        console.log(`get_serial_status(monitor=1) OK -> ${parsed.monitor} connected=${parsed.connected} port=${parsed.port}`);
      } else if (resp.id === 5) {
        const parsed = JSON.parse(resp.result.content[0].text);
        console.log(`read_serial_log(monitor=1) OK -> total=${parsed.totalBuffered}`);
        clearTimeout(timeout);
        child.kill();
        process.exit(0);
      }
    } catch { /* ignore non-JSON */ }
  }
});

child.stderr.on('data', (chunk) => {
  const text = chunk.toString().trim();
  if (text && !text.includes('Started')) { console.log('stderr:', text); }
});

requests.forEach((r) => child.stdin.write(JSON.stringify(r) + '\n'));
