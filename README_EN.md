# Serial Agent Plus

中文版本：[README.md](README.md)

> **Note**: This project, **Serial Agent Plus**, is an unofficial fork of [Rance-OwO/Serial-Agent](https://github.com/Rance-OwO/Serial-Agent) focused on enhanced serial features. All credit for the original project belongs to the upstream authors. This repository keeps the upstream MIT license and original copyright notices, and only differentiates the publishing identifiers.

Serial Agent Plus is an AI-powered embedded serial debugging platform. It chains a VS Code extension, an MCP server, and a skill into one reusable workflow, so reading logs, sending commands, and analysing problems can be shared between you and AI agents.

**Contents**

- [What This Project Does](#what-this-project-does)
- [Requirements](#requirements)
- [Quick Start In Three Steps](#quick-start-in-three-steps)
- [How The Chain Works](#how-the-chain-works)
- [Three Deliverables](#three-deliverables)
- [Why Three Deliverables And One Repo](#why-three-deliverables-and-one-repo)
- [Repository Structure](#repository-structure)
- [Development Commands](#development-commands)
- [FAQ](#faq)
- [Contributing](#contributing)

## What This Project Does

**Serial workspace (VS Code extension)**

- Up to 10 independent Serial Monitors, each with its own connection config, log buffer, send history and terminal session
- The sidebar tab and the editor-area panel are two viewports of the same monitor: logs, terminal, send draft, quick commands and `Cycle` state stay in sync
- The log panel is a direct terminal: type commands in the log, paste with `Ctrl+V`, complete with `Tab`, recall with `↑/↓`
- Byte-capped log buffer with per-monitor `Save` export (the file starts with a serial-info header)

**AI integration (MCP + Bridge)**

- The extension embeds a local Bridge that exposes real serial state, log buffers and send abilities as an authenticated HTTP API
- `Serial Agent Plus MCP` wraps those endpoints as MCP tools over stdio, so AI clients can read status, watch RX logs, and send TX commands

**Workflow layer (Skill)**

- The skill teaches an agent to pick the right MCP tools and workflow, and to tell read-only inspection apart from open-loop serial work

The result is one local chain: `AI Agent -> MCP -> Bridge -> extension -> serial device`.

## Requirements

| Item | Requirement | Notes |
| --- | --- | --- |
| VS Code | `>= 1.85.0` | Minimum declared in `engines.vscode` |
| Node.js | `>= 20` (20 / 22 / 24 recommended) | Development and tests only; the MCP runtime needs Node 18+ |
| OS | Windows / macOS / Linux | Friendly COM port names are read through PowerShell on Windows only |

Nothing in the chain requires network access: extension, MCP and Bridge all run locally.

## Quick Start In Three Steps

### Step 1: Install the `Serial Agent Plus` VS Code extension

The extension is the runtime entry point of the whole chain.

| Install method | When to use it |
| --- | --- |
| Search `Serial Agent Plus` in the Marketplace | Most users, least effort |
| Install the `.vsix` from Releases | You need a pinned version, or the Marketplace lags behind |
| Build from source | You are developing or validating this repo |

See the extension docs for the VSIX and build-from-source steps:

- [packages/serialagent-plus/README_EN.md](packages/serialagent-plus/README_EN.md)

> The extension alone is a complete serial workspace; continue with steps 2 and 3 only when you want the AI loop.

### Step 2: Configure the MCP server

Let the agent configure itself — send it this prompt:

```text
Please configure an MCP server for me. The display name is serialagent-plus-mcp and the full JSON is:
{
  "args": [
    "-y",
    "@fnote2030/serialagent-plus-mcp"
  ],
  "command": "npx",
  "startup_timeout_sec": 15,
  "type": "stdio"
}
```

Notes:

- This is `Serial Agent Plus MCP`; the npm package is `@fnote2030/serialagent-plus-mcp`
- It needs the `Serial Agent Plus` extension and its local Bridge: start the extension first, and MCP reads the discovery file `~/.serialagent-plus/bridge.json` for port and token
- The token changes every time the Bridge restarts; MCP re-reads the file before each call, so nothing needs manual maintenance

MCP docs:

- [packages/serialagent-plus-mcp/README_EN.md](packages/serialagent-plus-mcp/README_EN.md)

### Step 3: Feed the skill to your AI

Feed this skill file to the agent:

- [packages/serialagent-plus-skill/SKILL.md](packages/serialagent-plus-skill/SKILL.md)

Recommended approach:

- If your client supports skill installation, install the `serialagent-plus` directory through that mechanism
- Otherwise feed the `SKILL.md` content directly into the model prompt

With all three in place you have a reusable local debugging chain. Many tasks only need open-loop serial interaction.

## How The Chain Works

```text
AI IDE / Agent Client
    -> Serial Agent Plus MCP
    -> Local Bridge
    -> Serial Agent Plus VS Code Extension
    -> Serial Device
```

AI is not just "reading the docs" — it takes part through MCP tools:

- read serial status
- watch RX logs
- send TX commands
- draw conclusions from evidence

## Three Deliverables

All three artifacts ship from one source repository with a shared version, **1.0.0**:

| Deliverable | Package / ID | Artifact |
| --- | --- | --- |
| VS Code extension | `Fnote2030.serialagent-plus` | `serialagent-plus-<version>.vsix` |
| MCP server | `@fnote2030/serialagent-plus-mcp` | npm package, runs via `npx` |
| Skill | `serialagent-plus-skill` (`private` package in this repo) | `SKILL.md` plus prompt assets |

### 1. Serial Agent Plus

The VS Code extension is the primary product. It owns:

- serial UI
- local serial state
- buffered logs
- Bridge server lifecycle

Source:

- [packages/serialagent-plus](packages/serialagent-plus)

Docs:

- [packages/serialagent-plus/README_EN.md](packages/serialagent-plus/README_EN.md)

### 2. Serial Agent Plus MCP

The MCP package exposes Serial Agent Plus capabilities to AI clients over stdio. It
depends on the local Bridge started by the extension.

Source:

- [packages/serialagent-plus-mcp](packages/serialagent-plus-mcp)

Docs:

- [packages/serialagent-plus-mcp/README_EN.md](packages/serialagent-plus-mcp/README_EN.md)

### 3. Serial Agent Plus Skill

The skill is the workflow layer. It helps agents decide whether a task is
read-only or open-loop serial work, then
use MCP tools, the extension, and the local Bridge more effectively. It is not
a replacement for the runtime.

Source:

- [packages/serialagent-plus-skill](packages/serialagent-plus-skill)

Docs:

- [packages/serialagent-plus-skill/README_EN.md](packages/serialagent-plus-skill/README_EN.md)

## Why Three Deliverables And One Repo

Serial Agent Plus serves three usage modes:

- developers using the serial workspace directly in VS Code
- AI agents calling serial capabilities through MCP
- teams or agents reusing one debugging workflow through the skill

It is not split into three repositories because:

- the extension and the MCP server are still strongly coupled at runtime
- the skill is a workflow layer, not an independent runtime
- one repository keeps versions, READMEs, issues and architecture docs in sync

## Repository Structure

```text
packages/
  serialagent-plus/          # VS Code extension (serial UI, Bridge runtime)
  serialagent-plus-mcp/      # MCP server (stdio -> Bridge HTTP)
  serialagent-plus-skill/    # skill workflow and prompt assets
tests/                       # Vitest suites (11 files / 152 cases)
tsconfig.base.json           # shared TypeScript options
tsconfig.bridge.json         # config for the standalone Bridge test scripts
vitest.config.ts
```

Inside the extension package:

```text
packages/serialagent-plus/
  src/                       # extension host: serial, monitors, Bridge, terminal session
  media/                     # webview assets: main.js / main.css / shared pure modules
  image/README/              # screenshots used by the extension README
  .vscodeignore              # packaging rules (allow-list for native .node binaries)
  pack.js                    # standalone packaging script (avoids npm workspace symlink clashes)
```

## Development Commands

Install dependencies from the repository root:

```bash
npm install
```

Common commands:

| Command | Purpose |
| --- | --- |
| `npm test` | Run the full Vitest suite |
| `npm run test:watch` | Watch mode |
| `npm run build --workspaces` | Build the extension (webpack) and MCP (tsc) |
| `npm --workspace packages/serialagent-plus run build` | Build the extension only |
| `npm --workspace packages/serialagent-plus run pack` | Package a VSIX into `packages/serialagent-plus/` |
| `npm --workspace packages/serialagent-plus-mcp run build` | Build the MCP package only |

Type checking (three independent configs):

```bash
npx tsc -p packages/serialagent-plus/tsconfig.json --noEmit
npx tsc -p packages/serialagent-plus-mcp/tsconfig.json --noEmit
npx tsc -p tsconfig.bridge.json --noEmit
```

Debug the extension locally:

```bash
code --extensionDevelopmentPath=packages/serialagent-plus
```

Or pick `Run Serial Agent Plus Extension` in VS Code's Run and Debug view.

> Tests must stay isolated from a live instance: the Bridge discovery file lives at
> `~/.serialagent-plus/bridge.json`, and the suites use a temp directory so a running
> Bridge is never overwritten.

## FAQ

**Can I use it with just the extension?**

Yes. The extension is a complete serial workspace; MCP and the skill only matter when AI joins.

**Are monitors and serial settings restored after a reload?**

Yes. The monitor list, connection settings (port / baud / frame / flow control) and send history persist per monitor. If a saved port no longer exists, that monitor clears the port and logs a `[WARN]` line (baud and other preferences stay). Auto-connecting on startup is controlled by `serialagent-plus.autoConnectOnStartup`, off by default.

**Why does opening the Bridge in a browser return `AUTH_REQUIRED`?**

The Bridge is a local API behind `Bearer` authentication, not a web page. A browser address bar cannot send the header, so this is expected — use PowerShell, curl, Postman, or an MCP client.

**MCP is configured but tool calls still fail?**

Check in order: is the extension running (the Bridge lives inside it) → does `~/.serialagent-plus/bridge.json` exist → is the monitor connected (monitors start disconnected after a window reload, so `/api/send` returns `SERIAL_NOT_CONNECTED`).

**Can it coexist with upstream `Serial Agent`?**

Yes. Extension ID, command IDs, settings keys (`serialagent-plus.*`) and the discovery path are all distinct from upstream.

**What changes when migrating from upstream?**

Settings keys were renamed and are not auto-migrated, and the Keil build/flash commands plus the `F7` binding were removed.

## Contributing

- Make sure `npm test` and all three type checks pass before pushing
- Update the matching README (Chinese / English) when behaviour changes
- In issues and PRs, mention the serial chip, firmware framework (e.g. RT-Thread) and reproduction steps

Upstream project:

- <https://github.com/Rance-OwO/Serial-Agent>

## License

See [LICENSE](LICENSE).
