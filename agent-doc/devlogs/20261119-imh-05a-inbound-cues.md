# Surowan - 20261119 IMH-05 a–c：入站线索、原始片段读取器与 Telegram 命令解析

## 背景

这是 `agent-doc/design/20261117 多 IM Host 铺路实施计划.md` 第五个工作包 IMH-05（入站契约）的前半段，覆盖 a（Cues）、b（原始片段读取器）和 c（命令）三节。计划允许 IMH-05 按小节拆 PR；后半段是 d（中性入库路径）、e（补偿拉取与装配）和 grammy import 边界测试，单独成 PR。

这三节处理计划里的 A10、A11：

- **A10**：core 直接解释 grammy 类型。`platform/participation.ts`、`store/participation.ts`、`orchestration/proactive-reply.ts`、`orchestration/bot-commands/index.ts`、`platform/bot-command.ts`、`orchestration/invocation-queue/catch-up.ts` 都 `import type { Message } from 'grammy/types'`。参与闸门、主动回复和命令解析都是直接读 Telegram 消息对象。
- **A11**：core 自己解析 Telegram 的原始片段。`message_revisions.raw_fragment_json` 的读者（快照、主动回复、scene 渲染、catch-up）各自 `JSON.parse` 后直接调用 `telegram-markdown`，或者把 JSON 断言成 grammy 类型。

外部可见的行为不变：冻结快照的正文、spoiler、`media_slots` 逐字节相同；参与触发、注意力窗口、主动回复的直接 / 非直接判定和计数、命令解析都与原来一致。

本次改动由 Devin（`swe-2-high`，thought_level `max`，T3 子线程「IMH-05a-c: message cues, raw fragment readers, Telegram commands」）实现，共一轮首次实现加一轮修正。主会话负责 review、复验与交付。

## 主要变更

### 1. MessageCues（a）

`src/platform/im-host/cues.ts` 定义了中性契约。这个文件放在叶子目录里，不 import 任何外部模块。

```ts
interface MessageCues {
  readonly mentionsBot: boolean;
  readonly repliesToBot: boolean;
  readonly asksBot: boolean;
  readonly texts: readonly string[];
}
```

- `matchTriggerKind(cues, keywords, includeAsk)` 保持原来的优先级：ask > mention > reply_to_bot > keyword。`evaluateParticipation` 改为接收 cues、`hostChatId` 和消息编号。
- Telegram 的提取逻辑在 `src/platform/telegram-markdown/cues.ts`。实时消息与 `raw_fragment_json` 共用同一套结构化提取；`src/ingress/telegram-ingestion/cues.ts` 是实时消息的入口。
- 「是不是 /ask」分两种口径：
  - **实时路径**（`telegramCues`）：沿用原来的 `isAsk`，是否为编辑由 update 种类决定，与被忽略用户的 bypass 用同一个谓词。
  - **存储片段**（`cuesFromFragment` / `asksFromFragment`）：额外要求 `edit_date` 为空。原因是 revision 1 也可能是一次编辑（原始 update 没收到时）。
- 入库时只对非编辑消息提取一次 cues，同时用于参与闸门和 mention typing。编辑消息与原来一样只入库，不提取 cues。
- `BotIdentity` 移到 `im-host/cues.ts`：cue 提取要用它，而按叶子目录的规则，它不能留在 `platform/participation.ts`。

### 2. 原始片段读取器表（b）

`src/platform/raw-fragments.ts`：

```ts
export const RAW_FRAGMENT_READERS: Record<HostKind, RawFragmentReader> = {
  telegram: { cues: cuesFromFragment, asks: asksFromFragment, body: bodyFromFragment },
  playground: { cues: () => EMPTY_CUES, asks: () => false, body: (_raw, stored) => ({ text: stored.text, caption: stored.caption }) },
};
```

- 这张表按计划 D9 是静态分派表，放在 `platform/`，不进 `im-host/` 叶子目录。
- 读取器在计划的 `{ cues, body }` 之外多了一个 `asks`：主动回复的「原始 ask」检查和 catch-up 扫描只需要这一项，`asks` 只看命令字段。catch-up 可能在一个同步事务里翻完整个启动 backlog，不应为每行都遍历 rich message 两遍。
- 已迁移的读者：
  - `store/invocation-snapshot.ts`：新增 `host` 参数，所有调用点显式传入。
  - `orchestration/proactive-reply.ts`、`context/scene/render.ts`。
  - `orchestration/invocation-queue/catch-up.ts`：`isOriginalAskCue` 改走读取器。
  - `platform/spoilers.ts` 只在注释里提到 telegram-markdown，没有代码依赖。
- Telegram 行的快照仍然走同一个 `bodyFromFragment`，输出逐字节不变。
- 读取器约定：片段坏掉时退化成「没有 cue 加上存储的正文」，不会崩溃。id 比较统一经 `sameUserId`（`Number.isSafeInteger` 加 `BigInt` 比较）。

### 3. 命令（c）

- `parseBotCommand`、`conversationThreadId`、`commandSender`、`BOT_COMMANDS`、`registerBotCommands` 原样搬到 `src/ingress/telegram-ingestion/commands.ts`。选 ingress 而不是 adapter，是因为入库的 `index.ts` 本来就用 `conversationThreadId` 和 `parseBotCommand`；放在同一个目录，可以保证「命令作用的会话」与「入库写入的会话」用同一份实现。
- `platform/bot-command.ts` 已删除。它导出的三个函数本质上都是 Telegram 命令 token 的逻辑，并入了 `telegram-markdown/cues.ts`，与 cue 提取共用 `botCommandToken`。
- `BotCommandService` 留在 `orchestration/bot-commands/`，只接收 `ParsedCommand`、`ChatConfigRef` 和 `CommandSender`，不再 import grammy。
- 完成本段后，允许位置之外仍 import grammy 的只剩后半段（e 节）要处理的 4 个文件：`adapters/local-monolith/runtime/serve-run.ts`、`runtime/support.ts`、`src/startup-catch-up.ts`、`src/runtime-catch-up.ts`。

### 4. 测试

- 新增 `test/participation/cues.test.ts`、`test/im/raw-fragments.test.ts`，覆盖以下几点：
  - 活跃时段外，@Bot、回复 Bot、关键词三种触发仍能打开注意力窗口。
  - 实时消息带 `edit_date` 时仍算 ask，同一片段作为存储 revision 时不算。
  - 片段里的 id 畸形（小数）时不抛错，其他 cue 照常产出。
  - `asks` 只看命令字段。
  - 每个 Host 的读取器条目在代表性片段上的输出。
- `test/participation/ask.test.ts` 新增两条：一条是 `message` update 带 `edit_date` 时仍按实时 ask 处理；另一条是 ask-only 的 catch-up 遇到一行畸形片段时，整批不会中止。
- `bot-commands/commands` 等测试跟随搬家的代码改了 import 路径，期望值没有变。

子 agent 报告：修正轮新增的 5 条测试都在修复前失败；首轮新测试在新模块缺失时就无法导入。

另外，`agent-doc/telegram-agent-flow.md` 和 `configuration.md` 里指向已删除文件 `platform/bot-command.ts` 的链接也一并修正了。

## Review

首轮实现后用 ocr 审了一轮（26 个文件，8 条意见），主会话逐条核实：

| 意见 | 判定 | 处理 |
| --- | --- | --- |
| `telegramCues` 把 `edit_date` 并进了实时 `asksBot`：被忽略用户的 bypass 与参与闸门用了两个不同的谓词 | 成立 | 修正：实时与存储两种口径分开 |
| 片段里的小数 id 会让 `BigInt` 抛错，一行坏数据可能中止整批 catch-up | 成立 | 修正：统一用带守卫的比较 |
| 「原始 ask」检查为全部 cue 付出代价；编辑消息也在写事务里提取 cue（4 条性能意见合并） | 成立 | 修正：读取器增加 `asks`，编辑消息恢复为只入库 |
| `entities` 里混入 `null` 时，旁边的 `bot_command` 会被判为 ask（原来会抛错并回落到当前 revision） | 不改 | 只有 Telegram 不会发送的脏数据才会出现，读取器约定对坏数据宽容 |

主会话核实时还确认了两点：参与闸门只在非编辑消息上运行；编辑消息的 `bucketId` 恒为空，所以 mention typing 也不会因为 `edit_date` 改变。

修正轮没有再跑 AI review，由主会话逐条对照上一轮意见，并通读新 diff。

## 验证

以下由主会话在子 agent 的 checkout 里亲自运行：

```bash
pnpm run lint && pnpm run check && git diff --cached --check && node scripts/file-token-limit.ts
# 首轮与修正轮都通过
pnpm test   # 修正轮之后
# Test Files 1 failed | 444 passed | 1 skipped (446); Tests 1 failed | 2215 passed | 9 skipped (2225)
# 唯一失败：test/group-memory/store.test.ts「a keyword search reaches an entry older than thousands of non-matching ones」超时
pnpm exec vitest run test/group-memory/store.test.ts -t "keyword search reaches" --reporter=verbose   # 本分支与 base 各跑两次
# 本分支 4965 ms / 4862 ms；base 4613 ms / 5129 ms（超时）
```

上面这个超时用例在 base 上也会挂（5129 ms 对 5000 ms 上限），是原有的 flake，本包没有动它。首轮快速层被修正轮打断，没有跑完。本段没有改 `src/ingress/admin/`，所以没跑 Playwright e2e。

未执行：真实 Telegram 验收。建议在活跃时段外分别试 @Bot、回复 Bot、关键词三种触发；在 ask-only 群里试 `/ask` 与 `/ask@bot`；在 Forum Topic 里执行 `/pause`、`/resume`、`/ignoreme`、`/unignoreme`；另外开启主动回复的群也请观察一段时间。

## 提交

```txt
ca474dc5 Read inbound cues and raw fragments through host-neutral contracts
```
