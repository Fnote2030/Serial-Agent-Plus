# Serial Agent Plus MCP

中文版本：[README.md](README.md)

> **Note**: This package is the MCP server of **Serial Agent Plus**, an unofficial fork of [Rance-OwO/Serial-Agent](https://github.com/Rance-OwO/Serial-Agent) focused on enhanced serial features. All credit for the original project belongs to the upstream authors; this repository keeps the original copyright notices.

`Serial Agent Plus MCP` is the MCP server for the `Serial Agent Plus` platform. It exposes
serial tools over stdio and forwards requests to the local Bridge
started by the VS Code extension `Serial Agent Plus`.

Upstream project:

- <https://github.com/Rance-OwO/Serial-Agent>

This README is intentionally MCP-focused. For the product overview, the VS Code
extension, and the skill, see:

- Product overview: [../../README_EN.md](../../README_EN.md)
- VS Code extension: [../serialagent-plus/README_EN.md](../serialagent-plus/README_EN.md)
- Skill: [../serialagent-plus-skill/README_EN.md](../serialagent-plus-skill/README_EN.md)

## Runtime Model

The real runtime chain is:

```text
VS Code Extension -> local Bridge -> MCP -> AI IDE
```

This MCP is not a standalone product. It requires the VS Code extension
`Serial Agent Plus`. The extension owns:

- serial connection state
- buffered logs
- Bridge lifecycle

The MCP package is the stdio adapter that lets AI clients call those
capabilities through MCP tools.

## Package Identity

- Product name: `Serial Agent Plus MCP`
- Client alias: `serialagent-plus-mcp`
- npm package: `@fnote2030/serialagent-plus-mcp`
- Author: `Fnote2030`

## Install And Run

### Recommended: npm / npx

```bash
npx -y @fnote2030/serialagent-plus-mcp
```

Client config example:

```json
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@fnote2030/serialagent-plus-mcp"],
  "startup_timeout_sec": 15
}
```

### Local source build

From the repository root:

```bash
npm install
npm --workspace packages/serialagent-plus-mcp run build
npm --workspace packages/serialagent-plus-mcp run start
```

If you need to run the versioned main artifact directly, the naming rule is:

```bash
node packages/serialagent-plus-mcp/dist/serialagent-plus-mcp-<package-version>.js
```

## Dependency On The Extension

This MCP server requires the Bridge started by the VS Code extension. The
discovery file is expected at:

```text
~/.serialagent-plus/bridge.json
```

If the Bridge is not running, MCP startup may succeed while tool calls fail.

## Tools

Current tool surface:

1. `get_serial_status`
2. `list_serial_ports`
3. `connect_serial`
4. `disconnect_serial`
5. `read_serial_log`
6. `send_serial_data`
7. `clear_serial_log`
8. `wait_for_output`
9. `send_and_wait`

## Distribution Order

Recommended public distribution order:

1. Publish the VS Code extension `Serial Agent Plus`
2. Publish the npm package `@fnote2030/serialagent-plus-mcp`
3. Add MCP Registry metadata later

## Maintainer Notes

- Source entry: `src/index.ts`
- Main artifact: `dist/serialagent-plus-mcp-<version>.js`
- Compatibility entry: `dist/index.js`
- Before publishing, run:

```bash
npm --workspace packages/serialagent-plus-mcp run build
cd packages/serialagent-plus-mcp
npm pack --dry-run
```
