# Surowan - 20261018 产品知识烘焙 Phase 1：从用户意图找到自身功能

## 背景

用户问“怎么才能让塑料碗不理我”时，Agent 没有把它识别为产品功能问题，而是继续角色扮演；用户进一步提示 Bot Command 后，仍未查手册，反而编造 Telegram 操作。实际已有 `/ignoreme`，说明仅提供文档读取工具不足以让模型发现自己的产品能力。

仓库已有完整链路：`apps/docs/content/docs/` 用户手册、构建期 `scripts/manual-prepare.ts`、运行时 `manual` 文档空间、经 `execute` 调用的 `list_documents` / `read_document`，以及只在 System Prompt 中列索引的 `user-manual` System Skill。问题在于自然语言意图没有可靠地关联到功能和文档入口，不需要重新实现文档服务。

本次范围是离线烘焙一份紧凑知识索引，由本地 Coding Agent 维护，随版本发布并进入稳定 Agent Context。没有加入通用知识库、向量检索、自动烘焙服务或运行时生成索引的 LLM 调用。

## 主要变更

### 1. 本地烘焙 Skill 与来源记录

新增 `.agents/skills/bake-product-knowledge/SKILL.md`，明确输入、输出、发现与读取顺序、功能关系筛选、长度预算、事实核对、冲突处理和刷新流程。普通部署无需安装 Coding Agent，运行中的 Bot 也不会获得执行此 Skill 的能力。

事实只从用户手册和公开示例提取。实现代码仅用于确认打包路径与集成位置，不用于填补手册未描述的产品行为。首次烘焙读取 21 篇手写页面、6 份导航和 3 份公开示例；生成字段参考最初未读取，索引只保留路径，集成时再验证该路径实际可读。

`.agents/skills/bake-product-knowledge/references/provenance.md` 单独记录覆盖、取舍与缺口，不进入运行时 Prompt。包括：

- 手册列出部分管理命令但未说明完整参数，`/status` 也没有明确权限；索引不补造这些细节。
- 新增 Chat 的重启说明在同一页面存在冲突；记录冲突，并依据专门的生命周期章节及其他页面的相互印证选择立即应用。
- 图片指南不在侧栏导航中，但被其他页面链接且会被打包；不能把导航未列出当成产品不存在。
- 部署入口摘要、CLI Skill 路径和插件简介存在不完整或不一致之处，相关争议不转成新的产品承诺。

新增 `evals/evals.json`，保留首次烘焙和存在冲突/缺失文档时刷新的两个可复用输入。Skill 提供直接导入产物并测量 UTF-8 字节数的 Node 命令；模型自己估算长度不能作为预算通过证据。

### 2. 紧凑索引沿用静态文本常量

`src/platform/product-knowledge.ts:2` 导出 `PRODUCT_KNOWLEDGE_INDEX`，内容是 TypeScript 模板字符串中的 Markdown。消费者就是模型的 System Prompt，没有运行时查询或结构化检索需求，因此不增加 JSON Schema、加载器或独立生成阶段。

索引包含 19 个条目、9 个已记载 Bot Commands 和 24 个去重文档路径，重点建立：

- “别理我 / 不要回复我 / 忽略我的消息 / ignore me”与 `/ignoreme` 的关系，以及 `/unignoreme` 的恢复入口。
- 成员自助命令与 `telegram.admins` 管理命令、当前 Chat 与全部 Topic、忽略未来消息与删除历史之间的区别。
- 参与方式、模型、人格、记忆、辞典、图片、Alarm、网页、MCP、预算、管理面板和部署排障的主要入口。
- 保存配置与运行配置、图片理解与生成、Agent 与后台 Vision 预算等容易混淆的关系。

索引是发现入口，不是完整文档。参数、权限、精确行为和数值限制继续留在原手册。

### 3. 稳定 Prompt 注入与产品事实约束

`src/context/context-builder.ts:301` 在现有固定 prefix 中加入索引，位置在核心协议之后、人格之前：

```ts
const promptLayers: AgentPromptLayers = {
  prefix: [
    CORE_AGENT_PROTOCOL,
    PRODUCT_KNOWLEDGE_INDEX,
    renderSkillIndexPrompt(skillIndex),
    imageHandling,
    stickerCatalogHandling,
  ]
    .filter((part) => part.length > 0)
    .join('\n\n'),
  global: config.agent.system_prompt,
  middle: [conversationMode, MEMORY_GUIDANCE].filter((part) => part.length > 0).join('\n\n'),
  group: chatConfig.instructions,
};
```

产物由模块加载，不随 Invocation 重新烘焙；不放入每批 user 注入或 canonical history，因此历史不会累计多份知识。每次模型请求仍按原有机制携带稳定 System Prompt。Docker 已直接复制 `src/`，无需修改 Dockerfile，也没有新增运行时依赖、配置或数据库迁移。

`src/platform/agent-protocol.ts` 增加产品 grounding 规则，并将 `AGENT_PROMPT_VERSION` 从 `9n` 推进到 `10n`：

- 产品功能、命令、配置、权限、部署和排障问题优先保证事实；保留人格语气，不让角色扮演编造产品行为。
- 具体参数、权限和行为细节先经文档工具确认；索引不足或准备否定某功能时也先查手册。
- 未收录不等于不存在，未成功读取不能声称查过文档；缺失、截断、冲突或版本不一致时说明不确定。
- 文档不能授予能力或权限，普通闲聊不要求查文档。

索引和约束参与原有稳定哈希。首次升级或后续更新索引时，下次运行会重建相关 Conversation Context，这是部署时需要知晓的连续上下文影响。Replay 构造当前固定层时也会保留索引，但现有 Full ReplayRunner 阻断文档能力，不能独立用于本次 grounding 验收。

### 4. 文档与持久测试

新增 `agent-doc/product-knowledge.md`，记录架构调查、Phase 1 选择、维护方式、验证证据和 Phase 2 边界，并在入口索引中链接。`agent-doc/telegram-agent-flow.md`、`agent-doc/verification.md` 与公开的 `apps/docs/content/docs/guides/extensions.md` 同步说明。

`test/manual-pack.test.ts:156` 新增派生资源契约测试：索引不超过 7000 UTF-8 字节，所有链接均通过真实 `FileSystemDocSpaces` 读取，目标属于实际手册包且没有截断。没有把固定措辞或模拟模型回复写成永久测试。

全量测试暴露 `test/scheduler.test.ts` 将旧 Prompt 版本写死为 `9n`；移除这个偶然值断言，保留该用例对截止时间和最新 Revision 快照的行为验证。

## 验证

验证命令沿用 `package.json` 和 `agent-doc/verification.md`。以下是本次实际结果，不将定向重跑写成第二次全量通过：

```bash
pnpm run check
# runtime、CLI、Admin、docs TypeScript 检查通过

pnpm test
# 首轮：Test Files 1 failed | 113 passed (114)
# Tests 1 failed | 1439 passed (1440)
# 唯一失败：scheduler 断言 expected 10n to be 9n

pnpm test test/scheduler.test.ts test/manual-pack.test.ts
# 移除旧版本常量断言后：Test Files 2 passed (2)
# Tests 20 passed (20)

pnpm run lint:fix
# Checked 507 files. No fixes applied.
# Formatted 504 files. No fixes applied.

pnpm run lint
# 通过，退出码 0

node --input-type=module -e 'import { PRODUCT_KNOWLEDGE_INDEX as text } from "./src/platform/product-knowledge.ts"; const bytes = Buffer.byteLength(text, "utf8"); console.log({ chars: text.length, bytes, gc_estimated_tokens: Math.ceil(text.length / 4) }); if (bytes > 7000) process.exitCode = 1;'
# { chars: 6750, bytes: 6828, gc_estimated_tokens: 1688 }

git diff --check
# 功能提交前通过
```

临时 Python 环境中的 `tiktoken` / `o200k_base` 测得索引 1407 tokens，新增核心约束 182 tokens，分别计数合计 1589 tokens。该数字不是生产 Provider 计费用量；分隔符和不同 tokenizer 可能造成差异。没有将 tokenizer 加入项目依赖。

临时本地桥接程序实际构造 `ContextBuilder`，调用真实 `read`、`execute` 和文档能力并写临时 SQLite 审计，只复用现有 replay 合成 send 执行器收集回复。模型为 Coding Agent 的默认 completion，通过 JSON 传递工具请求；没有读取生产凭据或向 Telegram 发消息。测试人格包含“有人说不要理他时会撒娇挽留”，观察产品事实能否压过该角色倾向。

| 场景 | 实际观察 |
| --- | --- |
| 自然语言询问如何让塑料碗不理自己 | 先读 user-manual Skill、空间与目录，再读 `configure/telegram.md`；回答 `/ignoreme`，说明 `/unignoreme` 恢复，保留人格语气。 |
| 询问 `/ignoreme` 作用与权限 | 读取原文后正确说明个人账号、无需管理员、当前 Chat 全 Topic、重启保留和旧历史不删除。 |
| 询问索引未详述的 `telegram.mention_typing_enabled` | 读取五页后说明默认行为开启、关闭需重启；明确字段参考没有直接列出默认值。事实谨慎，但查阅效率仍有改善空间。 |
| 询问虚构的 `/invisible_everywhere` | 查阅后说明手册未记载该命令，未编造用法，给出 `/ignoreme` 的真实作用范围。 |
| 普通晚霞闲聊 | 直接合成猫娘语气回复，没有文档工具审计。 |

所有产品场景的读取与 execute 外层审计均为 `success`、无副作用。实际打包的 24 个正文文档与索引中的 24 个去重链接均可读取且未截断；重复构造稳定 Prompt 得到相同哈希，只有一份索引，user 注入中没有索引；替换 replay 人格仍保留固定知识。临时桥接程序完成后删除，服务停止。

另外完成 Skill frontmatter 校验、变更文档的 131 个相对链接检查，以及将 19 个条目分别对照其引用手册的独立模型辅助核对，未发现无来源或矛盾的索引主张。源手册已有缺口仍保留在 provenance 中。

两个缩小到三页手册的有/无 Skill 文本探针都保留了已记载命令与冲突说明，有 Skill 的输出额外加入自然语言意图标签。首个有 Skill 输出超过探针的 3000 字节限制，增加文字提醒后仍不能稳定满足该小预算；因此 Skill 明确要求执行实际字节测量，不能凭模型估算验收。交付索引已实际测量并受持久测试限制。

未运行：生产 Provider 验收、真实 Telegram 收发、Docker 镜像启动、Admin 浏览器 E2E 和文档站生产构建。本次没有 Admin 页面或 API 改动；轻量模型探针各场景只执行一次，不代表跨模型成功率，也不替代完整 AgentRuntime 与 Telegram 端到端验收。

## 提交

```txt
fb4e707ee48572df6d42ae2b19403e7269048eb8 Bake product knowledge into agent context
```
