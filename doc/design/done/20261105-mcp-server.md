# PRD：塑料碗 MCP Server 与 MCP with Skills 支持

## 1. 背景

塑料碗目前已经具备 MCP Client 能力，但尚未提供 MCP Server 能力。

随着塑料碗的开发和维护需求增加，希望让外部 Agent 能够通过 MCP Server 直接操作塑料碗，而不再仅仅依赖 CLI。

## 2. 目标

为塑料碗增加 MCP Server 能力，使外部 Agent 能够通过 MCP 协议完成以下操作：

- **配置管理**：读取和修改塑料碗配置。
- **Invocation Replay**：通过 MCP Server 使用 Invocation Replay 能力。

同时，减少对 CLI 更新和独立 Skill 安装的依赖。

## 3. MCP Server

在现有 MCP Client 能力的基础上，新增 MCP Server 能力。

MCP Server 将作为外部 Agent 操作塑料碗的接口，提供配置管理和 Invocation Replay 等能力。

MCP Server 与现有 CLI 并存，不要求 Agent 必须通过 CLI 完成上述操作。

MCP Server 的能力与 Admin Panel 一一对应，只有下文「API key 权限」中排除的账号与凭据操作除外。

MCP Server 内置在塑料碗服务端，随服务端一起发布。传输方式使用 Streamable HTTP；用户在 Agent 侧配置 `Authorization: Bearer <token>` 请求头完成鉴权。Bearer token 使用 API key：同一个 API key 开启 `read:all` 与 `write:all` 后，即可完成全部读写操作。

### API key 权限

API key 增加权限系统，按操作的性质分为三种：

- `read:all`：读取信息。不改变系统状态，也不消耗外部资源。
- `write:all`：改变系统状态。包括之前已实现的、能修改配置文件的操作，以及 Chat、Prompt、Memo Pad、辞典、群聊记忆、告警、Playground、重启等不改配置文件的写操作。
- `execute:paid-operations`：消耗外部资源。例如 Invocation 重放、Provider 健康检查、图片生成、辞典合并预览、Playground 的放行与重试。
- `read:all` 是每把 API key 的基础权限，始终开启；`write:all` 与 `execute:paid-operations` 是两个附加项，互不包含。
- 既改变系统状态又消耗外部资源的操作（例如 Playground 的放行），需要同时开启 `write:all` 与 `execute:paid-operations`。
- 这三个权限字段是系统内部实现细节，为以后更细化的权限系统预留。暴露给用户的只有四种模式，只能四选一：只读、读+改、读+耗、全部。
- Admin Panel 新建 API key 时用下拉框选择这四种模式之一。
- 已创建的 API key 只能修改权限（同样四选一）或 rotate。
- API key 及其权限继续存在数据库中，不进入配置文件。已存的权限组合不合法时（例如直接改数据库造成只能写不能读），这把 key 不能工作；控制台输出警告，Admin Panel 的警告系统显示常态警告。前端需要做好抗脏数据处理，页面不能因此出错。
- Admin API 与 MCP Server 都需要提供端点，告知当前 API key 拥有的权限。
- 塑料碗提供的 Skill（`surowan-utils`、`surowan-mcp`，以及经 MCP with Skills 下发的 Skill）都要确保：权限不足时，Agent 主动拒绝执行，并提醒用户去 Admin Panel 开启权限。
- 既有的 API key 迁移为开启 `read:all` 与 `execute:paid-operations`，保留原有的重放能力。
- 账号与凭据整类排除在 API Key 可管控的范围之外：无论开启什么权限，API Key 都不能改管理员密码、管理 Passkey、新增或删除管理员账号，也不能颁发、吊销或查看 API Key。这些操作留给浏览器面板和服务端命令行 `surowan`。
- surowan-utils 的用户名密码登录功能，以及 `setup`（首次创建管理员账号），先删除，CLI 只用 API key 鉴权；等想好怎么做再加回去。
- 服务端命令行 `surowan`（`serve`、`doctor`、`admin-account` 等）不在本次改动范围内。

## 4. MCP with Skills

塑料碗 MCP Server 将采用 **MCP with Skills** 标准。

目标是让支持该标准的 Agent 能够直接通过塑料碗 MCP Server 获取和使用相关 Skill，而不需要用户单独安装 Skill。

通过这一机制，减少因塑料碗功能变化而频繁更新 CLI 或单独安装 Skill 的需求。

## 5. 独立 Skill Fallback

考虑到目前不同 Agent Harness 对 MCP with Skills 的支持情况存在差异，塑料碗仍将提供一份**可以单独安装的 Skill**。

该 Skill 作为 MCP with Skills 的兼容性 Fallback，供尚未支持 MCP with Skills 的 Agent Harness 使用。

因此，塑料碗将同时提供两种 Skill 使用方式：

| 方式 | 适用情况 |
|---|---|
| MCP with Skills | Agent Harness 支持 MCP with Skills |
| 独立安装 Skill | Agent Harness 尚未支持 MCP with Skills |

这份独立安装的 Skill 名为 `surowan-mcp`，调用塑料碗 MCP Server 的工具，不走 CLI。现有走 CLI 的 `surowan-utils` Skill 继续保留。需求实现后，塑料碗同时提供 `surowan-utils` 与 `surowan-mcp` 两个 Skill。

## 6. 预期结果

- 塑料碗同时具备 MCP Client 和 MCP Server 能力。
- 外部 Agent 可以通过 MCP Server 修改配置和执行 Invocation Replay。
- 支持 MCP with Skills 的 Agent 无需单独安装 Skill。
- 不支持 MCP with Skills 的 Agent 可以通过独立安装的 Skill 使用相关能力。
- 减少为 Agent 操作塑料碗而频繁更新 CLI 的需要。
