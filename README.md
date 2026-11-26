# Serial Agent Plus

English version: [README_EN.md](README_EN.md)

> **声明**：本项目 **Serial Agent Plus** 是 [Rance-OwO/Serial-Agent](https://github.com/Rance-OwO/Serial-Agent) 的非官方衍生版（fork），主要增强串口功能。原始项目版权归原作者所有；本仓库保留上游 MIT 许可证与原始版权声明，仅对发布标识做了区分。

`Serial Agent Plus` 是一个面向嵌入式串口调试场景的 AI 平台。它把 VS Code 插件、MCP 和 Skill 串成一条可复用的工作流，让你能把“看日志、发命令、分析问题”交给 AI 和开发者协同完成。

**目录**

- [这个项目能做到什么](#这个项目能做到什么)
- [环境要求](#环境要求)
- [三步快速上手](#三步快速上手)
- [这条链路是怎么工作的](#这条链路是怎么工作的)
- [三个交付物](#三个交付物)
- [为什么是 3 个交付物，但仍然保留 1 个源码仓](#为什么是-3-个交付物但仍然保留-1-个源码仓)
- [仓库结构](#仓库结构)
- [开发命令](#开发命令)
- [常见问题](#常见问题)
- [参与贡献](#参与贡献)

## 这个项目能做到什么

**串口工作台（VS Code 插件）**

- 最多 10 个独立 Serial Monitor：每个监视器拥有自己的连接配置、日志缓冲、发送历史与终端会话
- 侧边栏标签页与编辑器区面板是同一监视器的两个视口，日志、终端、发送草稿、快捷指令、`Cycle` 状态实时同步
- 日志区内置终端：可直接在日志里键入命令、`Ctrl+V` 粘贴、`Tab` 补全与 `↑/↓` 历史召回
- 日志缓冲按字节上限配置，支持按监视器 `Save` 导出（文件头附带串口信息）

**AI 集成（MCP + Bridge）**

- 插件内嵌本地 Bridge，把真实串口状态、日志缓冲和收发能力暴露为带认证的 HTTP API
- `Serial Agent Plus MCP` 通过 stdio 把 Bridge 能力封装成 MCP tools，AI 客户端可直接读取状态、观察 RX 日志、发送 TX 命令

**工作流增强（Skill）**

- 通过 Skill 教 AI 正确选择 MCP 工具与工作流，区分只读检查与开环串口操作

最终形成 `AI Agent -> MCP -> Bridge -> 插件 -> 串口设备` 的本地调试链路。

## 环境要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| VS Code | `>= 1.85.0` | 插件 `engines.vscode` 声明的最小版本 |
| Node.js | `>= 20`（推荐 20 / 22 / 24） | 仅开发与测试需要；MCP 运行时最低 Node 18 |
| 操作系统 | Windows / macOS / Linux | 友好端口名（COM 描述）仅 Windows 通过 PowerShell 读取 |

链路上没有必须联网的环节：插件、MCP、Bridge 全部在本机运行。

## 三步快速上手

### 第一步：安装 VS Code 插件 `Serial Agent Plus`

先安装 VS Code 插件 `Serial Agent Plus`。这是整条本地调试链路的运行时入口。

| 安装方式 | 适用场景 |
| --- | --- |
| Marketplace 搜索 `Serial Agent Plus` | 普通使用者，最省事 |
| 安装 Release 里的 `.vsix` | 需要固定版本或 Marketplace 尚未更新 |
| 从源码构建 | 开发或验证本仓库最新代码 |

VSIX 与源码构建的具体步骤见插件文档：

- [packages/serialagent-plus/README.md](packages/serialagent-plus/README.md)

> 只装插件也能把它当本地串口工作台用；想接上 AI 闭环再继续第二、三步。

### 第二步：给 AI Agent 配置 MCP

让 AI 自己完成配置，直接把下面这段提示词发给 AI：

```text
Hi，请帮我配置一个 MCP。MCP 的显示名称是 serialagent-plus-mcp，完整的 JSON 格式如下：
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

说明：

- 这是 `Serial Agent Plus MCP`，npm 包名为 `@fnote2030/serialagent-plus-mcp`
- 它需要配合 VS Code 插件 `Serial Agent Plus` 和本地 Bridge 一起使用：先启动插件，MCP 会读取发现文件 `~/.serialagent-plus/bridge.json` 拿到端口与 token
- `token` 每次 Bridge 重启都会变化，MCP 每次调用前会重新读取，无需手动维护

MCP 文档：

- [packages/serialagent-plus-mcp/README.md](packages/serialagent-plus-mcp/README.md)

### 第三步：把 Skill 喂给 AI

把这个 Skill 文件喂给 AI：

- [packages/serialagent-plus-skill/SKILL.md](packages/serialagent-plus-skill/SKILL.md)

推荐做法：

- 如果你的客户端支持 skill 安装，优先用客户端自己的 skill 机制安装它
- 如果当前客户端没有 skill 安装能力，也可以直接把 `SKILL.md` 内容喂给 AI

完成插件、MCP 和 Skill 之后，你就拥有了一条可复用的本地调试链路。很多场景只需要开环串口通信。

## 这条链路是怎么工作的

当这三步都完成后，你就拥有了这样一条链路：

```text
AI IDE / Agent Client
    -> Serial Agent Plus MCP
    -> Local Bridge
    -> Serial Agent Plus VS Code Extension
    -> Serial Device
```

这意味着 AI 不只是“读说明文档”，而是能够通过 MCP tools 参与本地调试流程：

- 读取串口状态
- 观察 RX 日志
- 发送 TX 命令
- 基于证据形成调试结论

## 三个交付物

当前仓库会从同一个源码仓发布 3 个强关联交付物，版本号统一为 **1.0.0**：

| 交付物 | 包名 / 标识 | 产物 |
| --- | --- | --- |
| VS Code 插件 | `Fnote2030.serialagent-plus` | `serialagent-plus-<version>.vsix` |
| MCP 服务端 | `@fnote2030/serialagent-plus-mcp` | npm 包（`npx` 直接运行） |
| Skill | `serialagent-plus-skill`（仓库内 `private` 包） | `SKILL.md` + 提示词资源 |

### 1. Serial Agent Plus

这是主产品，也就是 VS Code 插件。它负责：

- 串口 UI
- 本地串口状态
- 日志缓冲
- Bridge 生命周期

源码：

- [packages/serialagent-plus](packages/serialagent-plus)

文档：

- [packages/serialagent-plus/README.md](packages/serialagent-plus/README.md)

### 2. Serial Agent Plus MCP

这是 AI 集成层。它通过 MCP 对外暴露串口和日志工具，并把调用转发给本地 Bridge。

源码：

- [packages/serialagent-plus-mcp](packages/serialagent-plus-mcp)

文档：

- [packages/serialagent-plus-mcp/README.md](packages/serialagent-plus-mcp/README.md)

### 3. Serial Agent Plus Skill

这是工作流增强层。它帮助 AI 或代理判断当前任务属于只读检查还是开环串口操作，并更稳定地使用插件和 MCP，但它本身不是运行时。

源码：

- [packages/serialagent-plus-skill](packages/serialagent-plus-skill)

文档：

- [packages/serialagent-plus-skill/README.md](packages/serialagent-plus-skill/README.md)

## 为什么是 3 个交付物，但仍然保留 1 个源码仓

`Serial Agent Plus` 需要同时服务三种使用方式：

- 开发者直接在 VS Code 中使用串口工作台
- AI Agent 通过 MCP 调用串口能力
- 团队或代理通过 Skill 复用同一套调试工作流

当前不拆成 3 个源码仓，是因为：

- 插件和 MCP 在运行时仍然强耦合
- Skill 现在是工作流增强层，不是独立运行时
- 单仓更适合保持版本、README、Issue 和架构文档同步

## 仓库结构

```text
packages/
  serialagent-plus/          # VS Code 插件（串口 UI、Bridge 运行时）
  serialagent-plus-mcp/      # MCP 服务端（stdio -> Bridge HTTP）
  serialagent-plus-skill/    # Skill 工作流与提示词资源
tests/                       # Vitest 单元测试（11 个文件 / 152 项用例）
tsconfig.base.json           # 各包共享的 TypeScript 配置
tsconfig.bridge.json         # 独立运行 Bridge 的人机联调脚本配置
vitest.config.ts
```

插件目录内部：

```text
packages/serialagent-plus/
  src/                       # 扩展宿主：串口、监视器、Bridge、终端会话
  media/                     # webview 资源：main.js / main.css / 共享纯逻辑模块
  image/README/              # 插件 README 截图
  .vscodeignore              # 打包排除规则（含原生 .node 的保留白名单）
  pack.js                    # 独立目录打包脚本（规避 npm workspace symlink 冲突）
```

## 开发命令

在仓库根目录安装依赖：

```bash
npm install
```

常用命令：

| 命令 | 作用 |
| --- | --- |
| `npm test` | 运行全部单元测试（Vitest） |
| `npm run test:watch` | 测试监听模式 |
| `npm run build --workspaces` | 构建插件（webpack）与 MCP（tsc） |
| `npm --workspace packages/serialagent-plus run build` | 只构建插件 |
| `npm --workspace packages/serialagent-plus run pack` | 打包 VSIX 到 `packages/serialagent-plus/` |
| `npm --workspace packages/serialagent-plus-mcp run build` | 只构建 MCP |

类型检查（三个配置彼此独立）：

```bash
npx tsc -p packages/serialagent-plus/tsconfig.json --noEmit
npx tsc -p packages/serialagent-plus-mcp/tsconfig.json --noEmit
npx tsc -p tsconfig.bridge.json --noEmit
```

本机调试插件：

```bash
code --extensionDevelopmentPath=packages/serialagent-plus
```

或在 VS Code 的 Run and Debug 中选择 `Run Serial Agent Plus Extension`。

> 测试必须与真实运行实例隔离：Bridge 发现文件默认写在 `~/.serialagent-plus/bridge.json`，
> 测试使用临时目录，不会覆盖本机正在运行的 Bridge。

## 常见问题

**只装插件能用吗？**

可以。插件本身是完整的串口工作台，MCP 与 Skill 只在需要 AI 参与时才配置。

**重启后监视器和串口配置还在吗？**

在。监视器列表、连接配置（端口/波特率/帧格式/流控）、发送历史都按监视器持久化。
保存的端口若已不存在，该监视器会清空端口并写入 `[WARN]` 日志（波特率等偏好保留）。
启动时是否自动连接由设置项 `serialagent-plus.autoConnectOnStartup` 控制，默认关闭。

**为什么浏览器直接打开 Bridge 会报 `AUTH_REQUIRED`？**

Bridge 是带 `Bearer Token` 认证的本地 API，不是网页。地址栏无法附加请求头，
因此这是预期结果；请用 PowerShell / curl / Postman 或 MCP 客户端访问。

**MCP 配置好了，但 tool 调用仍然失败？**

按顺序检查：插件是否已启动（Bridge 依赖插件）→ `~/.serialagent-plus/bridge.json` 是否存在
→ 监视器是否已连接端口（重载窗口后监视器默认断开，`/api/send` 会返回 `SERIAL_NOT_CONNECTED`）。

**能和上游 `Serial Agent` 同时安装吗？**

可以。扩展 ID、命令 ID、设置键（`serialagent-plus.*`）与发现文件路径都已与上游区分，互不冲突。

**从上游迁移过来需要注意什么？**

设置键全部改名，旧配置不会自动迁移；Keil 编译/烧录相关命令与 `F7` 绑定已移除。

## 参与贡献

- 提交前请确保 `npm test` 与三份类型检查全部通过
- 改动涉及功能行为时，同步更新对应包的 README（中/英）
- Issue / PR 请说明串口芯片、固件框架（如 RT-Thread）与复现步骤，便于定位

上游项目：

- <https://github.com/Rance-OwO/Serial-Agent>

## License

See [LICENSE](LICENSE).
