# Surowan - 20261120 出站 MCP 客户端支持 MCP with Skills

## 背景

Surowan 自己的 MCP Server（`src/ingress/admin/mcp/`）已经通过 `io.modelcontextprotocol/skills` 扩展发布 `surowan-mcp` Skill，但出站 MCP 客户端（`src/capabilities/mcp/`）还不认识这个扩展：外部 Server 自带的 Skill 既到不了模型，也不会在 Admin Panel 上显示。

用户要求：

- 客户端支持 MCP with Skills。
- Admin Panel 用徽标或其他符合 Koi 设计的方式，显示每个 Server 自带的 Skill。
- 实现与 code review 都委派给内置 subagent（Claude Sonnet 5.5）。

用户裁决了信任级别：模型可以读，每个 Server 一个开关，省略即开启。这与当前 MCP 工具描述直接给模型看的信任级别一致。

主会话定了两条约束：

- Skill 索引不进 system prompt。system prompt 哈希一变就会重建 Conversation Context，而 Server 掉线、重连很常见。
- 可见性与 MCP Tool 完全一致。

## 主要变更

### 1. 发现与校验

新模块 `src/capabilities/mcp/skills.ts:58` 的 `discoverSkills`：

- Server 声明了扩展且有 `resources` capability 时，分页调用 `skills/list`，再对清单里的每个文件做 `resources/read`。
- 每个文件都校验三项：内容是文本、UTF-8 字节数等于 `size`、sha256 等于 `digest`。
- 上限：每 Server 32 个 Skill、每 Skill 64 个文件、每文件 32 KiB、每 Server 合计 1 MiB。
- 清单资源必须在「`entry.uri` 去掉 `SKILL.md`」的根之内，路径段必须匹配 System Skills 的段模式。
- 坏 Skill 单个丢弃；重名的 Skill 在读取文件之前就跳过。
- 函数从不抛错，只返回第一个问题的短码。

接入 `connect`（`src/capabilities/mcp/connection.ts:197`）的方式：

```ts
const discovered = await discoverSkills(client, attempt.abort.signal);
if (state.stopping || generation !== server.generation) {
  return;
}
// ...
publishCandidate(server, definitions, revalidate);
// Only a candidate the registry accepted publishes its skills; a rejected
// one must not leave them on the panel of a server that never came up.
server.skills = discovered.skills;
server.skillsError = discovered.error;
```

- 客户端握手时也声明了该扩展。
- Skill 只存在 `ManagedServer` 的内存里，`stopServer` 时清空。

### 2. `read` 读取 `mcp-skill://`

`src/capabilities/mcp/skill-source.ts` 负责三件事：

- **可见性**：`visibleSkills`（第 55 行）直接复用 `chatToolSet` 的结果，所以与 Tool 同一套规则：宿主 profile、Chat 绑定、`ready`、至少一个可达 Tool，再加上 `skills !== false`。
- **索引**：最多 32 条、合计不超过 `MCP_SKILL_INDEX_MAX_CHARACTERS = 4_096` 字符（溢出提示行也算在内）。描述压成一行，并以 JSON 字符串引起来。
- **URI 解析**：URI 形如 `mcp-skill://<alias>/<skill>/<path>`，相对引用不能越出 `<alias>/<skill>`。

`src/capabilities/read-tool.ts` 按 scheme 分派：`system:///` 走原来的 SystemResources，`mcp-skill://` 走本 Invocation 的 source。不可见或不存在一律返回 `resource_not_found`。审计与 32 KiB 截断与原来相同。

索引放在 `read` 的 description 里，不进 system prompt。为避免所有 Context 重建，`renderSkillIndexPrompt` 原有的「This index is the complete list」措辞保持不变；`read` 的 description 自己说明 MCP Skill 是 system skills 之外额外的。

运行时接线：

- `RuntimeServices.mcpSkills` 由 `host-tooling.ts` 和 `serve.ts` 提供，实现是 `McpManager.createSkillSource`。
- `validateAdditionalTools` 按 4,096 字符的上限为 `read` 预留注册表空间。

### 3. 配置与 Admin Panel

- `src/platform/config/schema.ts`：stdio 与 HTTP 两种 Server 都新增 `skills: Type.Optional(Type.Boolean())`。
- `sameMcpServerConfig` 把 `skills` 排除在实例身份之外，所以切换它不重连。
- `read.ts` 的视图新增 `skills_enabled`、`skills`（名称、描述、URI、文件数、字节数）和 `skills_error`，不返回文件内容。
- `write.ts` 的创建与更新接受 `skills`。
- 前端：
  - 列表行在 alias 下显示 `ToneBadge`：开启时 info 色，关闭时 neutral 色。
  - 详情弹窗新增「模型可读」一行和 Skill 小节。
  - 编辑弹窗的开关拆到新组件 `skills-switch.tsx`，因为 `server-dialog.tsx` 已接近 20,000 字节上限。
  - 四个 locale 都补了文案。

### 4. Review 修正

实现交给 Sonnet 5.5 subagent，code review 交给另一个 Sonnet 5.5 subagent，报告 1 条 important 和 8 条 nit。主会话核实后自行修正了以下几条：

- 撤回 System Skills 索引措辞的改动（important）。
- 溢出提示行计入上限。
- Skill 赋值移到 `publishCandidate` 之后。
- 重名 Skill 提前跳过。
- 索引描述加引号。
- 文档补充路径段约束。
- 新增 `test/mcp/skills-race.test.ts`：fixture 的 `hang` 模式让 `resources/read` 永不返回，并写出一个标记文件。测试在 Skill 发现进行中调用 `stop()`，断言三点：5 秒内返回，没有发布 Skill、错误码或 Tool，状态行为 `stopped`。临时删掉第二个 generation 检查时，这条测试因 `skills_error: "skill_read_failed"` 而失败。

有意保留、没有改的两点：

- Skill 发现放在发布 Tool 之前，异常 Server 最多让 Tool 晚约 30 秒出现。
- 注册表固定预留 4 KiB。

## 验证

```bash
pnpm run lint
# Checked 1627 files. No fixes applied.
pnpm run check
# 通过（root tsc、CLI、admin-next、docs）
pnpm vitest run test/mcp/skills.test.ts test/mcp/skills-race.test.ts test/system-resources.test.ts test/skills.test.ts
# 4 files / 25 tests passed
pnpm test
# 461 files / 2322 tests passed
pnpm run admin:test:e2e 37-mcp-servers
# 8 passed（产物：mcp-servers-skills-list.png、mcp-servers-skills-detail.png）
pnpm run admin:test:e2e
# 360 passed
git diff --check
# 无输出；改动的非 Markdown 文件均 ≤ 20,000 字节
```

本机原来缺 Playwright 1.64 需要的 `chromium_headless_shell-1248`，用 `pnpm exec playwright install chromium-headless-shell` 补装后才跑通 e2e。

`pnpm run docs:build` 与 `pnpm run docs:verify`（`DOCS_BASE_PATH=/` 和 `/surowan/`）由实现 subagent 运行并通过；主会话之后只改了 `agent-doc/`，没有重跑。

未运行：连接真实第三方 MCP Server 的 Skill 验收；真实 Telegram 中模型读取 MCP Skill 的人工验收。

## 提交

```txt
1a182b46 Support MCP server skills in the outbound MCP client
```
