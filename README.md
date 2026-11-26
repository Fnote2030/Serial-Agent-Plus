# Serial Agent Plus

English version: [README_EN.md](README_EN.md)

> **声明**：本项目 **Serial Agent Plus** 是 [Rance-OwO/Serial-Agent](https://github.com/Rance-OwO/Serial-Agent) 的非官方衍生版（fork），主要增强串口功能。原始项目版权归原作者所有；本仓库保留上游 MIT 许可证与原始版权声明，仅对发布标识做了区分。

`Serial Agent Plus` 是一个面向嵌入式串口调试场景的 AI 平台。它把 VS Code 插件、MCP 和 Skill 串成一条可复用的工作流，让你能把“看日志、发命令、分析问题”交给 AI 和开发者协同完成。

## 这个项目能做到什么

- 在 VS Code 中提供串口工作台
- 通过 MCP 让 AI 访问串口和日志
- 通过 Skill 教 AI 正确选择 MCP 工具和工作流
- 形成 `AI Agent -> MCP -> Bridge -> 插件` 的本地调试链路

## 三步快速上手

### 第一步：安装 VS Code 插件 `Serial Agent Plus`

先安装 VS Code 插件 `Serial Agent Plus`。这是整条本地调试链路的运行时入口。

![VS Code 插件安装](assets/vscode-extension-install.png)

插件文档：

- [packages/serialagent-plus/README.md](packages/serialagent-plus/README.md)

### 第二步：给 AI Agent 配置 MCP

推荐使用 `CC Switch` 进行入下图 MCP 配置。
![CC Switch 配置 MCP](assets/ccswitch-mcp-config.png)

如果你习惯让 AI 自己完成配置，也可以直接把下面这段提示词发给 AI：

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

- 这是 `Serial Agent Plus MCP`
- 它需要配合 VS Code 插件 `Serial Agent Plus` 和本地 Bridge 一起使用

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

## 项目源码介绍

当前仓库会从同一个源码仓发布 3 个强关联交付物：

1. `Serial Agent Plus` VS Code 插件
2. `Serial Agent Plus MCP`
3. `Serial Agent Plus Skill`

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
- AI Agent通过 MCP 调用串口能力
- 团队或代理通过 Skill 复用同一套调试工作流

当前不拆成 3 个源码仓，是因为：

- 插件和 MCP 在运行时仍然强耦合
- Skill 现在是工作流增强层，不是独立运行时
- 单仓更适合保持版本、README、Issue 和架构文档同步

## 仓库结构

```text
packages/
  serialagent-plus/
  serialagent-plus-mcp/
  serialagent-plus-skill/
docs/
tests/
```

## 开发命令

在仓库根目录安装依赖：

```bash
npm install
```

常用命令：

```bash
npm test
npm --workspace packages/serialagent-plus run build
npm --workspace packages/serialagent-plus run pack
npm --workspace packages/serialagent-plus-mcp run build
```

## 维护者文档

- [docs/architecture.md](docs/architecture.md)
- [docs/release-matrix.md](docs/release-matrix.md)
- [docs/release-playbook.md](docs/release-playbook.md)

## License

See [LICENSE](LICENSE).
