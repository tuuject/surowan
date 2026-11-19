# Surowan - 20261119 IMH-03：用 Host 特征表取代 core 里的 Host 字面量分支

## 背景

这是 `agent-doc/design/20261117 多 IM Host 铺路实施计划.md` 的第三个工作包 IMH-03，解决计划里的 A7、A13，A14 只做「收进特征表」这一步：

- **A7**：core 里用 `=== / !== 'telegram' | 'playground'` 做二分判断。IMH-02 之后，`src/` 下在计划允许清单之外仍有 57 个文件带 Host 字面量。另外还有几种默认值形态：`AgentPlugin.hosts` 省略即 `['telegram']`、`LongTaskService.invocationScope(hosts = ['telegram'])`、`previewContext(hostKind = 'telegram')`、`isHostReady = host === 'playground' || …`、群聊记忆写死 `isHostReady('telegram')`。
- **A13**：`TelegramMediaClient` 放在 `capabilities/media/download.ts`，直接访问 `api.telegram.org`；读图与读原文件的路径用「是不是 playground」做二分。
- **A14**：模型可见的用语（历史标签、图片来源说法、工具 label 与描述片段）分散在各处的三元表达式里。

第三个 Host 进来时，这些二分判断都会算错。本包把它们改成读特征或写穷举 `switch`；两个现有 Host 的行为、模型可见文本、Admin 响应都不变。按计划 D11，用语本身一个字都不改，只挪进特征表。

本次改动由 Devin（`swe-2-high`，thought_level `max`，T3 子线程「IMH-03: host trait table replaces host literal branches」）实现，共一轮首次实现加一轮修正。主会话负责 review、复验与交付。

## 主要变更

### 1. 特征表（`src/platform/host-profile.ts`）

`hostExecutionProfile(kind)` 原先是 `kind === 'playground' ? PLAYGROUND_PROFILE : TELEGRAM_PROFILE`，现在改为查 `Record<HostKind, HostExecutionProfile>` 表。新增 `HostKind` 时，类型系统会强制补全这张表。`HostKind` 改为从 `HOST_KINDS` 元组派生（`(typeof HOST_KINDS)[number]`），避免联合类型和元组各写一份、日后不同步，导致按特征生成的 SQL 漏掉新 Host。

| 特征 | telegram | playground | 取代的分支 |
| --- | --- | --- | --- |
| `chatSource` | `config` | `room` | `invocation-policy`、`delivery-target`、`model-switch`、replay preflight、dictionary、image bridge 等处「查 `telegram.chats` 还是查 `rooms`」 |
| `intake` | `bucket` | `release` | 调度与队列恢复里「过期 Bucket 重发」还是「房间队列」 |
| `deliveryRecord` | `wire` | `sequence` | `send/support.ts` 的 `reportsWireIds` |
| `mediaSource` | `download` | `local_asset` | `image-input.ts`、`original-file.ts`、`media/index.ts` |
| `connection` | `registry` | `none` | `serve.ts`、`admin/routes`、warning catalog、群聊记忆、`resume.ts` 的就绪判断 |
| `sleep` / `budgetBypass` | `true` / `true` | `false` / `false` | 调度器的睡眠过滤、回执认领、`resume` 的睡眠检查 |
| `snapshotFormat` | `plasticwan.invocation-snapshot.v1` | `plasticwan.invocation-snapshot.playground.v1` | `invocation-snapshot.ts` 的 Telegram 过滤、`builder/schema.ts` |
| `wording` | Telegram 现有文案 | 房间现有文案 | `render.ts` 的历史标签、`builder/index.ts` 的图片来源说法、`read_image` / `read_member_profile` 的 label 与描述片段 |

辅助函数：

- `hostsWhere(predicate)`：返回满足某个特征的 Host 列表。
- `hostKindsSql(expr, hosts)`（`src/store/host-scope.ts`）：把这个列表生成 `host_kind IN (...)`；列表为空时生成 `1 = 0`，不会退化成不带过滤的查询。
- `policyScopeChatId(kind, ids)`：按 `chatSource` 选用原生 chat id 或内部 chat id。

真正逐 Host 不同的地方写穷举 `switch`，`default` 分支用 `unreachableHostKind` 断言 `never`。这样的地方有：快照的 validator 与投影（二者现在由同一个 switch 选择，不会各走各的）、历史行渲染、sender 查询、`original-file.ts` 按 `mediaSource` 的分派、`serve.ts` 的就绪判断。

### 2. 去掉隐式默认

- `AgentPlugin.hosts` 改为必填，空数组在注册时报错（错误信息带插件 id）。以前空数组会退回 Telegram，现在要求显式声明。各内置插件挂载的 Host 与改动前一致，由 `test/plugins.test.ts` 的挂载矩阵钉住。
- `LongTaskService.invocationScope` 与 `previewContext` 删掉默认参数，调用方显式传 Host。
- 回执认领、调度器唤醒、queued-sleep 过滤三条路径统一要求 `sleep && budgetBypass` 都为真，才认回执上的 `bypassDailyBudget`；`resume` 的睡眠检查也按目标 Host 的 `sleep` 特征 gate。现有两个 Host 上的取值不变，可观察行为也不变。
- 群聊记忆的就绪判断看候选 Chat 自己的 Host：未就绪的候选跳过，其余候选照常整理；模型调用前按 batch 的 Host 再查一次就绪。`sleeping.ts` 加上这些改动后超过 20 KB，候选与 batch 规划原样拆到新文件 `src/context/group-memory/planning.ts`。
- Replay 遇到本构建不认识的 Host 时，仍走结构化的 `replay_host_unsupported`（preflight 返回 `available: false`，运行端点返回 409），不会直接抛出普通错误。
- warning catalog 的连接告警改为 `Record<HostKind, … | null>` 全量表：漏配会在编译期暴露，不会在运行时抛错。

### 3. 媒体下载器归 Telegram adapter

`TelegramMediaClient` 原样搬到 `src/adapters/local-monolith/telegram/media.ts`；`MediaDownloader` 接口和 `MediaTooLargeError` 留在 `capabilities/media/`。媒体服务改收 `downloaders: Partial<Record<HostKind, MediaDownloader>>`，按媒体行的 Host 取下载器，只有 `mediaSource` 为 `download` 的 Host 才有。

### 4. 边界测试（`test/im/host-literals.test.ts`）

测试扫描 `src/**/*.ts`。在允许清单之外，以下情况一律判失败：三种引号写出的 `'telegram'` / `'playground'` 字面量，以及 SQL 里的 `host_kind = '`。

- 扫描前先剥掉注释，所以注释里出现这两个词不会误报。
- 只豁免一种写法：值为纯 Host 字面量数组的 `hosts: [...]` 挂载声明，可以出现在任何文件里。
- 允许清单在测试里逐项写明理由，主要是两个 adapter 目录、`local-monolith` 的 `config/` 与 `runtime/`、`ingress/telegram-ingestion/`、`ingress/admin/`、`store/playground/`、`store/host-scope.ts`、`platform/host-profile.ts`、`platform/im-host/`、`platform/config/`、`tui/`、`doctor.ts`、`cli.ts`。比计划初稿多出四项：
  - `capabilities/media/local-assets.ts`：房间资产的磁盘路径。
  - `capabilities/media/sticker-index.ts`：Sticker 是 Telegram 专属子系统。
  - `context/builder/render.ts`、`schema.ts`：这两个文件里有逐 Host 的穷举 switch。
- 清单里的某一项如果已经不再命中任何字面量，测试会报错，防止清单越积越长。
- 扫描器本身有正反样例测试：三种引号都能抓到；注释、标识符、更长的字符串不误报；插件里的 `if (kind === 'telegram')` 会被抓到。

### 5. 其他测试

- `test/media/tool-descriptions.test.ts`：逐字节钉住两个 Host 下 `read_image` 与 `read_member_profile` 组装后的完整描述。期望值取自 base `3fd1994f` 的输出。
- `readOriginalFile` 的房间分支新增测试：读出的字节等于上传的资产，Telegram 下载器没有被调用。
- `test/tasks/runtime.test.ts`：钉住睡眠期间的三条路径：房间回执照常认领；排队中的 Telegram Invocation 被跳过；带 bypass 的回执照常投递。
- 群聊记忆：两个候选中一个 Host 未就绪时，另一个仍然完成整理。

子 agent 报告：群聊记忆按 Host 跳过、未知 Host 的 replay 拒绝、空 `hosts` 报错、扫描器的 `hosts:` 豁免规则，这四组测试都在修复前失败。逐字节钉住的测试在改动前后都通过。

## Review

首轮实现后用 ocr 审了一轮（61 个文件，26 条意见），主会话逐条核实：

| 意见 | 判定 | 处理 |
| --- | --- | --- |
| 群聊记忆要求「所有 config 型 Host 都就绪」，不是看 Chat 自己的 Host | 成立（计划原文要求按 Chat 判断） | 修正 |
| 逐 Host 的 switch 缺 `never` default；`original-file` 用 if/else 分派；快照 validator 与投影各用一个 key | 成立 | 修正 |
| `HOST_KINDS` 与 `HostKind` 可能不同步 | 成立 | 修正：类型从元组派生 |
| `serve.ts` 让所有 registry Host 借用 Telegram 的连接状态；告警表是 Partial 加运行时 throw | 成立 | 修正 |
| sleep 与 budgetBypass 两个特征在三条路径上读法不一致 | 成立 | 修正 |
| 未知 Host 的 replay 从结构化 409 变成普通报错 | 成立 | 修正 |
| `hosts: []` 会悄悄卸载插件 | 成立 | 修正：注册时报错 |
| `read_image` 组装后的描述、`readOriginalFile` 房间分支缺测试 | 成立 | 补测试 |
| 允许清单整个放行 `plugins/` 与 `adapters/local-monolith/`（主会话发现） | 成立 | 修正：只豁免 `hosts:` 声明，`local-monolith` 收窄到四个子目录 |
| `mcpCapableHost()` 是按表顺序选出的进程级单一 Host | 成立 | 推迟到 IMH-04：MCP 绑定目前仍从 `telegram.chats` 来，配置投影会给每个绑定带上所属 Host |
| `policyScopeChatId` 的 `?? 0n` 哨兵 | 原有问题 | 推迟到 IMH-04（拆分 `chatId` 一词两义） |
| `send/support.ts` 按 `deliveryRecord: 'wire'` 选用 Telegram 措辞 | 不改 | 发送工具用语按 D11 推迟 |
| `TelegramMediaClient` 的 abort 时机、错误路径未读完 body、`write` 可能部分写入 | 原有问题 | 不改：类是原样搬过来的，留作后续 |
| 其余 7 条只在今天不存在的特征组合下才会出现（room 型 Host 开 sleep、全部 Host 都关 sleep、第二个 release Host 等） | 不改 | — |

修正轮没有再跑 AI review，由主会话逐条对照上一轮意见，并通读新 diff。

## 验证

以下由主会话在子 agent 的 checkout 里亲自运行：

```bash
pnpm run lint && pnpm run check && git diff --cached --check && node scripts/file-token-limit.ts
# 首轮与修正轮都通过
pnpm test test/im test/playground test/scheduler test/tasks test/sleep.test.ts test/media test/plugins.test.ts \
  test/tool-schema.test.ts test/prompts test/skills test/skills.test.ts test/group-memory test/image test/invocations   # 首轮
# 100 files / 458 tests passed
pnpm test   # 修正轮之后
# Test Files 1 failed | 438 passed | 1 skipped (440); Tests 1 failed | 2173 passed | 9 skipped
# 唯一失败：test/group-memory/store.test.ts「a keyword search reaches an entry older than thousands of non-matching ones」超时 5388 ms（上限 5000 ms）
pnpm run admin:build && pnpm run admin:test:e2e
# 348 passed, 1 failed：17-dictionary「creates, edits, disables and deletes an entry through the UI」等待 New entry 按钮超时
pnpm run admin:test:e2e 17-dictionary --repeat-each 4
# 72 passed
```

group-memory 那条超时在 base 上也有：本地单跑要 4.6–4.8 s，紧贴 5 s 上限；IMH-02 的 CI 首跑也挂在它上面，重跑后通过。本包没有改 `group-memory/store.ts`。`17-dictionary` 单独重复 4 遍全部通过，判断为全量负载下的 flake。

未执行：真实 Telegram 验收。建议在私聊、群和 Forum Topic 里各发一次带图消息，触发一次 Alarm 回执，并在 `/pause` 期间重启后确认补偿行为；Playground 房间建议各收发一次带图消息。

## 提交

```txt
48586786 Replace host literal branches with a host trait table
```
