# Serial Agent Plus Skill

> Serial Agent Plus Skill 是 Serial Agent Plus 项目的一部分；Serial Agent Plus 是 [Rance-OwO/Serial-Agent](https://github.com/Rance-OwO/Serial-Agent) 的非官方衍生版，主要增强串口功能。

Use this skill when an agent needs to operate Serial Agent Plus through the local
MCP tools exposed by `Serial Agent Plus MCP`.

## What This Skill Does

This skill teaches an agent how to:

- choose the right Serial Agent Plus MCP tools for the current task
- reason about the local runtime chain behind those tools
- distinguish read-only inspection from side-effectful serial actions
- report conclusions from tool evidence instead of assumptions

This skill does not replace the runtime.

## Runtime Model

The actual execution chain is:

```text
AI Client
  -> Serial Agent Plus MCP tools
  -> Local Bridge
  -> Serial Agent Plus VS Code extension
  -> Serial port(s)
```

Key boundaries:

- The VS Code extension owns the real serial state and Bridge lifecycle.
- `serialagent-plus-mcp` exposes stdio MCP tools and forwards them to the local
  Bridge.
- This skill only teaches the agent how to use those MCP tools correctly.

Agent rule:

- Prefer calling MCP tools.
- Do not assume direct Bridge REST access is available to the model.
- If MCP calls fail because the Bridge is unavailable, diagnose that as a local
  runtime/setup issue, not as missing business logic.

## Multi-Monitor Model (P3)

The extension manages up to **10 Serial Monitors**. Each monitor owns its own
serial connection, log buffer, and display config. Monitors are addressed by
**index** (`"1"`..`"10"`, stable per monitor) or **unique name**
(case-insensitive). All monitor-scoped tools accept an optional `monitor`
argument:

- exactly one monitor exists → omit `monitor` (it is the default)
- several monitors exist → omitting `monitor` fails with `MONITOR_REQUIRED`
  and the error lists all candidates (`index=name (+ port)`); retry with an
  explicit `monitor`
- prefer **index** references in scripts (a rename never invalidates them);
  names are fine interactively

### Decision flow: always start with `list_monitors`

1. `list_monitors` → see indexes, names, connection state, ports, configs.
2. Reuse: a monitor already connected to the target port with the right
   settings → operate on it directly.
3. Reconfigure: right monitor, wrong display settings →
   `update_monitor_config`; wrong port/baud → `disconnect_serial` +
   `connect_serial` on that monitor.
4. Create: no suitable monitor → `create_monitor` (optional unique name),
   then `connect_serial` with `monitor`.
5. Recreate: a monitor holds a name/index you need but is stale →
   `delete_monitor` + `create_monitor` (index is recycled smallest-first).

Port-conflict rules (avoid mid-session surprises):

- A port already opened by another monitor is **rejected**; the error names
  the owner (`2=RTT (COM3 @ 115200)`). Do not retry blindly — either use that
  monitor or `disconnect_serial` on it first.
- Before connecting to a shared-USB adapter port, check `list_monitors` for
  an existing holder.
- Housekeeping: `delete_monitor` silently disconnects first; the last
  remaining monitor cannot be deleted (`MONITOR_MINIMUM`).

## Expected Environment

- Serial Agent Plus VS Code extension installed and active
- Local Bridge started by the extension
- Serial Agent Plus MCP configured in the AI client

Typical Bridge/runtime failure hints:

- the extension is not active
- the local Bridge is not running
- the MCP server cannot discover Bridge connection info
- the client can see the MCP server but tool calls fail

## Decide The Task Mode First

Before choosing tools, decide which mode the task belongs to:

### 1. Read-only inspection

Use this mode when the user only wants to inspect state or logs.

Typical actions:

- check connection state
- list ports
- read recent logs
- wait for passive output without sending data

### 2. Open-loop serial operation

Use this mode when the device is already running and the task is about serial
interaction, configuration, or shell-style command exchange.

Typical examples:

- configure a Linux device over serial
- send AT or CLI commands
- collect logs after a manual user action
- validate request-response behavior on a running device

## Available MCP Tools

### Read-only tools

- `get_serial_status`: inspect connection state, reconnect state, counters, and
  buffered log metrics.
- `list_serial_ports`: inspect available serial devices before choosing a port.
- `read_serial_log`: inspect recent buffered log lines.
- `wait_for_output`: wait for matching serial output without sending data.
- `list_monitors`: list all Serial Monitors (index, name, connection state,
  counters, config). Call this first when several monitors exist to pick a
  target.
- `get_monitor_config`: inspect the serial/display config of one monitor.

### Serial side-effect tools

- `connect_serial`: open a serial connection.
- `disconnect_serial`: close the current serial connection.
- `send_serial_data`: send text or hex data to the connected device.
- `send_and_wait`: send data and wait for a matching response in one atomic
  operation.
- `clear_serial_log`: clear buffered logs and counters before sensitive
  verification.

### Monitor management tools (local state)

- `create_monitor`: create a new monitor (max 10); does not open any port.
- `delete_monitor`: delete a monitor (silently disconnects first); the last
  remaining monitor cannot be deleted.
- `rename_monitor`: rename a monitor; names are unique, the index never
  changes.
- `update_monitor_config`: update display-level config (lineEnding, encoding,
  hexMode, showTimestamp, rxIdleWrapMs, flowControl, logBufferKB). Connection
  parameters (port/baud/...) are set at connect time.

### Targeting a monitor

All serial tools accept an optional `monitor` parameter (index like `"2"` or
unique name like `"RTT"`). With a single monitor it defaults to that one; with
several, omitting it returns `MONITOR_REQUIRED` plus the candidate list — call
`list_monitors` and retry with an explicit target.

## Decision Rules

- Start with the least invasive tool set that can answer the question.
- Use read-only tools first when the user asks for status, evidence, or
  diagnosis.
- Use `send_and_wait` by default for request-response serial interactions.
- Only split the flow into `send_serial_data` plus `wait_for_output` when the
  task is genuinely asymmetric or long-running.
- Use `clear_serial_log` before sensitive verification when stale buffered
  evidence would be misleading.
- Prefer conclusions grounded in tool output and logs, not inferred success.

## Recommended Playbooks

### Open-loop serial interaction

1. `get_serial_status`
2. `list_serial_ports` if the connection target is unknown
3. `connect_serial` if not connected
4. `clear_serial_log` if old buffered output would pollute the check
5. `send_and_wait` for request-response commands
6. `read_serial_log` when you need broader context around the response

### Read-only diagnosis

1. `get_serial_status`
2. `list_serial_ports` if hardware presence is in question
3. `read_serial_log`
4. `wait_for_output` only if the task depends on future passive output

## Failure Interpretation

When a tool call fails, classify the failure before proposing the next step.

Common buckets:

- MCP/Bridge availability failure: the local runtime chain is not ready.
- Serial connection failure: the port is missing, busy, or not connected yet.
- Request-response mismatch: the device accepted the send but did not emit the
  expected output.

Do not collapse these into one vague "Serial Agent Plus failed" conclusion.

## Response Expectations

When using this skill, the agent should report:

- which MCP tools were used
- what evidence was observed from tool output or logs
- which failure bucket or conclusion best matches that evidence
- what next tool call or next user action is recommended
