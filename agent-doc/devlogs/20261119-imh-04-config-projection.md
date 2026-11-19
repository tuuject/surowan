# Surowan - 20261119 IMH-04：配置投影与拆分 chatId 的两种含义

## 背景

这是 `agent-doc/design/20261117 多 IM Host 铺路实施计划.md` 的第四个工作包 IMH-04，处理计划里的 A8 和 A9：

- **A8**：`InvocationContext.chatId` 与 `InvocationScope.chatId` 在 Telegram 上是 Telegram chat id，在 Playground 上是内部 `chats.id`。同一个字段要看 Host 才知道是什么意思，由此带出两个问题：
  - `plugins/dictionary/index.ts` 用 `chatId > 0n` 判断是不是私聊；
  - `capabilities/send/record.ts` 拿这个 id 去查 Chat 行。
- **A9**：配置层与 adapter 之外，还有约 20 个 core 文件直接读 `config.telegram.*`。例如 `resolveChatConfig(config, orm, telegramChatId)` 返回的类型是 `RawConfig['telegram']['chats'][number]`。

按用户确认的 D1，`config.jsonc` 的格式一个字段都不动，`ConfigSchema` 也不变，只在 core 与配置文件之间加一层投影。以后的 Host 在配置里新增一段与 `telegram` 并列的配置即可。

另外，IMH-03 review 时推迟了两项到本包：

- `mcpCapableHost()` 按表顺序挑出一个「MCP Host」作为进程级的单一值，这与 D12 冲突（D12 允许同时接入多个平台）。
- `policyScopeChatId` 遇到 config 型 chat 缺原生 id 时，会悄悄返回哨兵值 `0n`。

本次改动由 Devin（`swe-2-high`，thought_level `max`，T3 子线程「IMH-04: config projection and split chatId meanings」）实现，共一轮首次实现加一轮修正。主会话负责 review、补读 ocr 没能审完的文件、复验与交付。

## 主要变更

### 1. 配置投影（`src/platform/config/projection.ts`）

```ts
interface ChatConfigRef { hostKind: HostKind; hostChatId: bigint | null }
configuredChats(config, host): readonly ChatConfigEntry[]
allConfiguredChats(config): readonly { host: HostKind; chat: ChatConfigEntry }[]
mapConfiguredChats(config, map: (chat, host) => ChatConfigEntry): RawConfig
hostIntakeSettings(config, host): HostIntakeSettings
resolveChatConfig(config, orm, chat: ChatConfigRef): ChatConfigEntry | undefined
storedChatsForConfig(store, host, configuredId): readonly { id; hostChatId }[]
```

- 每个访问器都是穷举 `switch (host)`。Telegram 分支读 `config.telegram`，`playground` 没有配置条目。
- `hostIntakeSettings` 汇总入站相关的配置：Bucket 窗口（并入了原来的 `resolveBucketTiming`）、`process_bot_messages`、`sticker_trigger_enabled`、`mention_typing_enabled`、全局 `participation`、全局 `proactive_reply` 与 `admins`。
- `resolveChatConfig` 先按 `chatSource` 特征分派。Telegram 分支保留直查与 `chat_migrations` 别名解析；room 型 Host 返回 `undefined`。旧签名 `resolveChatConfig(config, orm, telegramChatId)` 与 `invocationChatEntry` 都已删除。
- `storedChatsForConfig` 把一个配置条目解析成库里的 Chat 行，Telegram 分支沿用 `telegramChatIdentity` 的迁移别名图。群聊记忆的候选 Chat 改为经 `allConfiguredChats` 加这个 helper 求出，不再在 core 里点名 Telegram。

迁到投影 API 的读者：

- bot-commands（`index` / `status` / `config` / `session`）、model-switch（改用 `mapConfiguredChats`）、invocation-queue（`due` / `catch-up` / `shared`）、agent-runtime。
- participation、prompt-versions、providers（`modelsForTelegramChats` 改名为带 Host 参数的 `modelsForChats`）、proactive-reply。
- MCP（bindings / tool-sets）、send/record、media、群聊记忆、replay、scene、调度器。
- 插件：alarm 与 dictionary。
- runtime 装配代码：chat-lifecycle、mcp-cutover、mcp-publication、serve-run、support。

Admin 层新增 `src/ingress/admin/chat-ref.ts`（`configuredTelegramChat`），把 5 处 Admin 调用点收口到一起，也顺带把 `prompts.ts` 压回 20 KB 以下。

### 2. 拆分 A8

- `InvocationScope`、`InvocationPolicy`、`InvocationContext` 同时携带 `hostKind`、`hostChatId: bigint | null`（Host 原生 id），以及 `chatId` / `internalChatId`（内部 `chats.id`）。不再有含义随 Host 变化的字段。
- dictionary 的私聊判定改为查存储里的 `chats.type`，不再看 id 的正负号；room 型 Host 不挂载辞典工具（辞典原本就不在房间里挂载）。
- `send/record.ts` 按 `internalChatId` 查 Chat 行。
- MCP 的 `chatTools` 按 `context.hostChatId` 解析 binding。
- `invocationGateKey` 的取值与 base 完全相同：Telegram 仍是 `telegram:<Telegram chat id>`，房间仍是 `playground:<内部 id>`。
- 选择 wire id 时一律按 Host 分派：
  - `identityConversation` 经穷举 switch 的 `wireChatId` 选 id；Telegram 缺原生 id 时显式报错，房间取内部 id。
  - `resolveConversation` 有存储行时走 `policyScopeChatId`；没有存储行时，只有合成目标（工具预览、doctor）会得到显式的非投递 id `'0'`。
  - 无论哪条路径，内部 SQLite id 都不会被当成 Telegram chat id 发出去。
- `policyScopeChatId` 遇到 config 型 chat 缺原生 id 时显式报错。逐行处理的调用方（如模型切换）原本就会 catch 并跳过该行。scene 预览的合成 context 单独处理。

### 3. MCP 绑定带上所属 Host

- `mcpCapableHost()` 已删除。`toolSets()` 返回 `{ chatIds, host, tools }`。
- 发布校验（`mcp-publication.ts`）与 doctor 都改为按 tool set 自己的 Host 构造 `previewContext`；基础工具注册表按每个 `HostKind` 各校验一次。
- 枚举 MCP binding 时按 `profile.mcp` 特征过滤，与 `createTools` 的门槛一致。

### 4. 边界测试（`test/config/host-projection-boundary.test.ts`）

- 在允许清单之外，任何对 telegram 配置段的属性访问（`.telegram.`、`.telegram?.`、`['telegram']`、`RawConfig['telegram']`）都判失败。扫描时忽略注释，扫描器本身有正反样例测试；`services.telegram` / `assembly.telegram` 这类注册表字段不算配置读取。
- 允许清单与计划一致：`platform/config/`、`adapters/local-monolith/config/`、`adapters/local-monolith/telegram/`、`ingress/telegram-ingestion/`、`ingress/admin/`、`tui/`、`doctor.ts`，再加两处 Sticker 集模块（`adapters/local-monolith/runtime/sticker-sets.ts`、`capabilities/stickers/`）。`adapters/local-monolith/runtime/` 里的其他文件都不再读配置段。
- IMH-03 的 Host 字面量边界测试继续通过，而且允许清单没有增加。

### 5. 测试

- `test/config/projection.test.ts`：
  - 群迁移后，新 id 仍能解析到旧配置条目。
  - 房间与 Telegram chat 的 id 相撞时（有意构造房间内部 id 等于某个已配置的 Telegram chat id），房间拿不到那个条目的任何设置。
  - 另覆盖：配置条目枚举、intake 设置、policy 的 id 相撞、gate key、`modelsForChats` 不跨 Host 混用。
- `test/im/strict-host-kind.test.ts`：Telegram 目标缺原生 id 时，不会产出以内部 id 为 chatId 的 ref。
- `test/mcp/publication.test.ts`：发布校验使用 binding 自己的 Host 构造预览。
- `test/group-memory/candidates.test.ts`：迁移前后的两个 Chat 行都会成为候选；关闭了群聊记忆的条目不贡献候选。
- A8 相关测试都改成原生 id 与内部 id 取不同的值：
  - mcp-cutover 夹具。
  - `read_image` 的 `daily_usage` 记账：Telegram 记在 `chat` / 原生 id 下，房间记在 `playground` / 内部 id 下。
  - context injector 的三个身份字段。
  - 子 agent 临时互换两个 id 验证过：mcp-cutover 的两个用例会因此失败。
- 其余既有测试只随 `commands.run(…)` 等签名变化调整调用写法，期望值没有变。`IngestResult.mention` 的内部结构随 A8 拆分变成 `{ hostKind, hostChatId, internalChatId, threadId }`，值是等价的。

子 agent 报告：wire id 回退、MCP 预览 Host 这两组新测试在修复前失败；群聊记忆候选测试钉住的是原有行为。

## Review

首轮实现后用 ocr 审了一轮。82 个文件里有 24 个因为限流与超时没能审完，涉及 projection、record、delivery-target、proactive-reply、群聊记忆、prompts、dictionary、bot-commands 等组；这部分由主会话补读 diff。ocr 给出 19 条意见，主会话的核实结果：

| 意见 | 判定 | 处理 |
| --- | --- | --- |
| `identityConversation`、`resolveConversation`、scene 预览都按 `hostChatId ?? internalChatId` 选 id，不分 Host | 成立 | 修正：按 `chatSource` 选 id，缺原生 id 时显式报错，合成路径用显式的非投递 id |
| MCP 发布校验与 doctor 仍固定用 Telegram 预览；枚举 binding 时没按 `mcp` 特征过滤 | 成立 | 修正 |
| `group-memory/chats.ts` 写死 `configuredChats(config, 'telegram')` 并加进了 Host 字面量允许清单（主会话发现） | 成立 | 修正：新增 `storedChatsForConfig`，并从允许清单移除 |
| A8 相关测试里原生 id 与内部 id 用了同一个值 | 成立 | 修正 |
| `test/mcp/live-vision.ts` 仍用旧的 `chatId` 字段 | 成立 | 修正 |
| `invocationGateKey` 的值变了（子 agent 报告措辞引起的疑问） | 误报 | base 本来就是 `host:id`，值没有变 |
| vision gate 测试持有原始 id、MCP 受影响 chat 丢了 Host、catch-up 的 sticker 设置、`due.ts` 可空列类型、群聊记忆读工具读 live config，以及若干清理项（共 10 条） | 不改 | 原有问题，或只在尚不存在的第二个 config Host 下才会出现 |

另外，子 agent 的 checkout 里混进了一个名为 `$null` 的 16 字节杂散文件（在 POSIX shell 里用 PowerShell 写法重定向产生的），主会话删除后才提交。

修正轮没有再跑 AI review，由主会话逐条对照上一轮意见，并通读新 diff。

## 验证

以下由主会话在子 agent 的 checkout 里亲自运行：

```bash
pnpm run lint && pnpm run check && git diff --cached --check && node scripts/file-token-limit.ts
# 首轮与修正轮都通过
pnpm test test/config test/schema/config-chat-settings.test.ts test/chat test/models test/participation test/proactive \
  test/mcp test/dictionary test/memo test/bot-commands test/tasks test/runtime test/foundation test/im test/replay \
  test/send test/telegram test/admin   # 首轮
# 224 files / 1135 tests passed
pnpm test   # 修正轮之后
# Test Files 443 passed | 1 skipped (444); Tests 2193 passed | 9 skipped (2202)
pnpm run admin:build && pnpm run admin:test:e2e   # 修正轮之后，共跑 4 次
# 第 1 次：348 passed, 1 failed（04-writes 的并发编辑步骤 PUT /api/chats 返回 500）
# 第 2 次：348 passed, 1 failed（09-chats「saved-but-not-applied…」超时）
# 第 3 次：348 passed, 1 failed（12-image-assets：net::ERR_NO_BUFFER_SPACE）
# 第 4 次：349 passed
pnpm run admin:test:e2e 09-chats 04-writes --repeat-each 5
# 115 passed
```

同一台机器在 base `095612a1` 上连跑两次全量 e2e，都是 349 全过。IMH-04 的 4 次全量里，每次挂的用例都不一样，其中一次全绿，一次是系统 socket 缓冲区耗尽；相关 spec 单独重复 5 遍全部通过。子 agent 在 vitest 里也观察到过 Windows 上配置写入的 `EBUSY`。综合判断这些是负载与环境造成的 flake，但 04-writes 那次 500 没有抓到服务端日志，无法完全排除与本包有关。

未执行：真实 Telegram 验收。建议做以下几项：

- 私聊、普通群、Forum Topic 的收发与回复。
- 已迁移超级群的配置是否仍然生效。
- `/status`、`/model`、`/effort`、`/pause` 与 `/resume`。
- 辞典在私聊和群里的作用域。
- MCP 工具调用一次。
- Admin 的 Chats 页与全局模型切换。

## 提交

```txt
0d6c479b Project host configuration and split chat id meanings
```
