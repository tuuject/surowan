# Surowan - 20261113 Admin Panel 文案对齐 Koi 规范

## 背景

按 Koi 设计规范的文案规则审计 `apps/admin-next` 时，发现四类系统性问题：

- 状态、类型、角色直接显示枚举原值。`StateBadge` 渲染 `{state}`，全站 18 处会显示 `outcome_unknown`、`skipped_budget` 这类原值；Invocation、提醒与贴纸索引的状态筛选下拉也直接用 `label: value`。思考强度同样在下拉、勾选框和表格里显示 `off`、`xhigh`。
- 同一对象在中文界面有多个名字：Invocation 被叫作「调用记录」「Invocation」「工具会话」「Tool 会话」「运行」，甚至「会话」；Chat 混用「会话 / Chat / 群」，而「会话」同时还指 Conversation 和登录状态；Topic、Prompt、Sticker、API key、Bot 也中英混用。
- 可见文案里出现 `config.jsonc`、`key.json`、`search_memory`、`pwblob://`、`ttl_seconds: null`、`bucket_max_seconds`、`sleeping`、`worker`、`supervisor`、`LRU`、`GC` 等实现层标识符。
- 多个页面用 Alert、页头描述或脚注解释功能原理和限制（备忘录、群聊记忆、Bot 管理员、贴纸、API 密钥、网络搜索、Harness、Playground、辞典等）。

此外还有 6 处中间点分隔符，以及一批标点问题：「（可选）」与「（选填）」混用，`1-80` 与 `1–80` 混用，中文里用半角括号，用连字符当分隔符。

用户裁定：中文界面的核心术语表一律用中文；面板目前没有链接帮助页的机制，说明原理的文案先删除。

## 主要变更

### 1. 枚举值统一经翻译目录显示

`common` 目录新增 `states`、`kinds`、`roles`、`thinkingLevels` 四组，覆盖迁移里各表的状态取值、Telegram 消息与媒体类型、模型调用与 transcript 角色，以及全部思考强度。`src/lib/format.ts` 提供对应的取值函数，目录里没有的值回退为原值：

```ts
/** A state in the current language; a state the catalog doesn't know shows as itself. */
export function stateLabel(state: string): string {
  return i18n.t(`common.states.${state}` as 'common.states.queued', { defaultValue: state });
}
```

`StateBadge`（`apps/admin-next/src/components/business/state-badge.tsx:68`）、上下文与 transcript 的角色徽章、消息与媒体类型列、发送参数、三个状态筛选下拉、生图的比例与质量下拉、模型编辑的思考档位勾选框、角色卡与会话对话框的思考强度下拉、会话表格、相关 toast 都改走这些函数。原先只有 Playground 自己维护的 `playground.states` 并入 `common.states` 后删除。

模型保存后的提示原来列出配置路径（`等待重启：{{paths}}`），现在改为计数（`{{count}} 项设置需要重启后生效`），见 `apps/admin-next/src/lib/model-manager.ts` 的 `applyFeedback`。

### 2. 中文术语表

zh-CN 目录统一使用以下术语：Invocation 称「运行」（列表页「运行记录」），Chat 称「会话」，Topic 称「话题」，Conversation Context 称「上下文」，Prompt 称「提示词」，Bucket 称「消息批次」，Sticker 称「贴纸」，Bot 称「机器人」，agent 角色的模型称「主模型」，Hold/Release 称「暂存/放行」，Passkey 称「通行密钥」，Seq/GC/checkpoint/ref 称「序号/清理/检查点/引用」。登录状态不再叫「会话」。

导航随之调整：分组「运行记录」改为「活动」，「Agent」改为「机器人」；「调用记录」改为「运行记录」，「告警」改为「提醒」（原来与「警告」页撞义，而这个页面管理的是机器人设的提醒），「Prompt」改为「提示词」，「Harness 微调」改为「运行参数」，「Bot 管理员」「Bot 贴纸包」改为「机器人管理员」「贴纸集」。

英文导航保持 `Tool sessions` 与 `Harness tuning`，因为用户文档按这两个英文名引用页面；英文目录只修改实现层标识符、错误提示和把 Invocation 叫成 session 的地方。

### 3. 删除说明性文案

删除的内容包括：备忘录、群聊记忆、Bot 管理员的 Alert；贴纸页的两段 `Pre/Mid/Post` 拼接说明；API 密钥、网络搜索、循环闹钟、Playground、Harness、辞典、供应商页的页头描述；网络搜索的能力变更 Alert；Harness 各分组的描述和跳转说明；Invocation 列表与模型调用页的 Token 口径脚注；私有推理的说明段落（`PrivateReasoningNote` 组件一并删除）；Prompt 版本保留数量、辞典保留说明、注入去重说明、覆盖说明、导入冲突说明、导出回导说明；主动回复对话框的示例与说明。

确认对话框里的操作后果、字段格式提示和缺失数据提示都保留，只是改写成不含标识符的说法。例如开启或关闭群聊记忆会中止运行，这条提示保留；网络搜索开关的说明改成一句后果：「关闭搜索会中止正在进行的运行。」

另外清理了几个从未被引用的说明键：`overview.tokenHint`、`usageFootnote*`、`cancelOngoingDesc`、`chats.configConflictRemove`、`dictionary.toolModel.*`。

### 4. 分隔符与标点

中间点全部移除：提醒详情里的「时间 · 操作者」、触发记录的「时间 · 手动」、贴纸集的待处理与失败计数改为用布局间距分隔（flex + `columnGap`）；下拉选项这种纯字符串改用 `common.separator` 拼接；`recurringAlarms.roomLabel` 改为「房间：{{title}}」。跳过原因原本用中间点拼进徽章，现在改用 `resultSkippedBecause`（「已跳过：{{reason}}」）。

统一了「（选填）」、en dash 范围、中文全角括号与「」引号，并去掉连字符分隔符和多余空格。`zh-CN/pages/group-memories.ts` 原来缺少 `typeof` 注解，键名漂移不会让构建失败，这次补上了。

### 5. 文档与 E2E

`agent-doc/admin-panel.md` 的「前端」下新增「界面文案」一节，写明术语表、枚举取值函数与页面文字边界，同时同步了 Harness 的分组和 Context 提示条文案。E2E 中断言旧文案的地方都已更新：删掉的说明不再断言，状态与思考强度的断言改为新标签，设置页的标题断言改用 heading 角色。

## 验证

```bash
pnpm run lint
# Checked 1327 files. No fixes applied.

git diff --check
# 无输出

pnpm run check
# 通过（tsc、cli、admin-next、docs）

npx vitest run apps/admin-next/src/lib
# 3 files / 10 tests passed

pnpm run admin:build
# 通过

pnpm run admin:test:e2e
# 第一轮 279 passed / 17 failed，失败全是断言旧文案；更新断言后整套 296 passed
# 恢复英文导航名后再跑整套：296 passed (1.6m)
```

未执行：中文界面的桌面宽度与手机宽度截图核对（E2E 固定英文 locale）；完整 `pnpm test`（改动只涉及 `apps/admin-next` 与 `agent-doc`，没有后端代码）；`docs:build` / `docs:verify`（未改 `apps/docs`）。

## 提交

```txt
f8258ed1 Align admin panel copy with Koi conventions
```
