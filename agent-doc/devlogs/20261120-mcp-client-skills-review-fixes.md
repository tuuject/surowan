# Surowan - 20261120 MCP 客户端 Skills 的审查修复

## 背景

`a7a4184b` 让出站 MCP 客户端支持 MCP with Skills，见 `agent-doc/devlogs/20261120-mcp-client-skills.md`。用户要求经 T3 委派 Pi 复审 PR #121（模型 `magpie/opencode-go/deepseek-v4.1-flash`，thinking `max`）。Pi 跑的是 open-code-review：

```bash
ocr review --from origin/develop --to HEAD --exclude 'agent-doc/devlogs/**'
```

ocr 给出 6 条意见，Pi 逐条核实，又补了 3 条。主会话再对照代码核实一遍，结论如下：

- 4 条成立：两处 `connection.ts` 竞态、容量检查的预留按字符算而不是按 token 算、Skill 文件路径没有总长度上限。
- 1 条误报：e2e 没断言持久化。磁盘上的值已由 `test/admin/mcp-servers-skills.test.ts` 断言。
- 1 条小问题：`resources/read` 的 content 回退。这次也一并改了。
- 另外更正一处事实：异常 Server 让 Tool 推迟出现的上限约 60 秒，不是首篇 devlog 和 PR 说明里写的约 30 秒。

两处竞态都来自同一个根源。`connect` 在 `listTools` 和发布之间多了一段 await（Skill 发现），而原有代码默认「attempt 仍然有效」就等于「client 仍然活着」，也默认发布前不会有回调需要用到 `server.client`。

## 主要变更

### 1. 发现期间 transport 关闭：attempt 失败，不再发布死 client

`discoverSkills` 会吞掉请求失败，所以 Server 在 `resources/read` 时退出，发现照样正常返回。`onclose` 只把状态记成 degraded 并安排重连，不改 generation，于是 generation 检查照样通过：已经死掉的 client 被发布成 `ready`。发布又会把 `reconnectAttempt` 清零，Server 因此一直以 1 秒间隔重连，面板却始终显示 `ready`。Pi 实测 4 秒里重连了 15 次。

现在 `onclose` 会在 attempt 内记一个标记，发现结束后检查它（`src/capabilities/mcp/connection.ts`）：

```ts
if (transportClosed) {
  // `onclose` already reported the outage and armed the retry; failing
  // here keeps the backoff growing instead of resetting it on publish.
  throw new Error('MCP transport closed during skill discovery');
}
```

### 2. 发布前收到 `tools/list_changed`：发布后再刷新

`start()` 和 `reconcile()` 调用 `connect` 时不持有信号量。这时 `refreshTools` 读到的 `server.client` 还是空的，会抛 `MCP server is unavailable`：健康的 Server 被标成 `degraded / registry_update_failed`，还留下一个重连定时器，之后会把刚发布的 client 换掉。这个窗口原本只有 `listTools` 那一下，Skill 发现把它拉长到最多 30 秒。

现在发布前收到的通知只记一笔，等发布和 `revalidate` 完成后再刷新一次：

```ts
if (!published) {
  toolsChangedEarly = true;
  return;
}
refresh();
// ...
if (toolsChangedEarly) {
  refresh();
}
```

为此，`published` 的声明提前到构造 `Client` 之前。

### 3. 容量检查按最坏情况预留

`estimateTextTokens` 对非 ASCII 字符每个记 1 token。原来用 `'x'.repeat(4096)` 占位，只预留了约 1,024 token；全中文的索引最多会到 4,096 token。现在 `src/orchestration/agent-runtime/support.ts` 改用 `'汉'.repeat(MCP_SKILL_INDEX_MAX_CHARACTERS)` 占位。

### 4. 发现阶段校验 URI 总长度，content 必须对应请求的 URI

- **URI 总长度**：原来只校验路径的每一段，没限制总长度。路径很深的文件能通过校验，但 URI 超过 512 字符，`read` 永远读不到。现在 `discoverSkills` 接收 alias，用 `mcpSkillUri(alias, name, path)` 拼出完整 URI；超过 `MCP_SKILL_URI_MAX_LENGTH` 就记 `skill_manifest_invalid`。
- **避免循环导入**：`MCP_SKILL_URI_PREFIX`、`MCP_SKILL_URI_MAX_LENGTH` 和 `mcpSkillUri` 从 `skill-source.ts` 移到 `skills.ts`，`read-tool.ts` 和 `index.ts` 改从新位置导入。
- **content 回退**：`resources/read` 的结果去掉了 `?? read.contents[0]` 回退。没有和请求 URI 对应的 content 时，记 `skill_read_failed`。

### 5. 测试

- **fixture**：`test/fixtures/mcp-skills-server.ts` 新增四种模式：
  - `die`：第一次 `resources/read` 时退出进程；
  - `notify`：新增一个 Tool、发出 `tools/list_changed`，停顿 1.5 秒后再应答（SDK 默认防抖 300 ms，之后还会重新列一次 Tool）；
  - `deep`：路径为 9 层、每层 120 字符的目录；
  - `wronguri`：返回的 content 换了一个 URI。
- **`test/mcp/skills-race.test.ts`** 新增两条测试：
  - `die`：等到调用方记下 `initialization_failed`。断言 `registry_hash` 为空（说明从未持久化 `ready`）、`reconnect_attempt ≥ 1`。
  - `notify`：断言新增的 `pong` 出现在 Tool 列表里，状态为 `ready`，没有 `mcp_server_degraded` 事件，`reconnect_attempt` 为 0。
- **`test/mcp/skills.test.ts`**：在 `test.each` 里加了 `deep` 和 `wronguri` 两种情况。

## 验证

```bash
# 逐个还原四处修复（transportClosed、发布前通知、URI 长度、content 回退），各跑对应测试
# 四处还原后，对应测试都失败（各 1 failed）；恢复后通过
for i in 1..5: pnpm vitest run test/mcp/skills-race.test.ts test/mcp/skills.test.ts
# 5 轮均 21 passed
pnpm test
# 461 files / 2326 tests passed（rebase 前）
./node_modules/.bin/biome lint . && ./node_modules/.bin/biome format .
# 通过
pnpm run check
# exit 0
# rebase 到 origin/develop（26c80281）后：
pnpm vitest run test/mcp/skills.test.ts test/mcp/skills-race.test.ts test/admin/mcp-servers-skills.test.ts test/system-resources.test.ts
# 28 passed；biome lint/format、tsc --noEmit 通过
```

本机的 `pnpm run lint` 包装器会把 biome 的输出吞掉，只打印 `ESLint output (JSON parse failed…)`，退出码也不可靠。它就这样漏掉过一处格式问题，所以这次直接运行 `biome lint` 和 `biome format`。

改动不涉及前端，没有重跑 e2e。

## 提交

```txt
25e3343d Fix MCP skill discovery races found in review
```

rebase 后首篇 devlog 引用的代码提交从 `1a182b46` 变为 `a7a4184b`，本提交同时更正了那里的 hash。
