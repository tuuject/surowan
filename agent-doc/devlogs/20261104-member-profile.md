# Surowan - 20261104 群成员资料读取原语

## 背景

Bot 记得谁说过话，却读不到那个人「是什么人」。消息头只给 `uid:6869211498` 或房间的 `member:member_5` 这类 token，模型能称呼对方，但看不到对方是否管理员、有没有自定义头衔、头像长什么样。此前要获取这些信息只能靠猜，或者从历史消息里拼。

需求是给一个通用工具：按当前 Invocation 所属的会话与平台，读取指定群成员的资料，凡是平台 API 能给到的都要能读到，头像以图片形式交给模型；虚拟房间能给多少算多少（用户名即可）。约束是不能接受任意用户 ID，引用必须限定在当前 Conversation 内。

## 决策

**做成 runtime 原语，不做 `execute` 能力。** 读资料是推理中途的高频小查询，走 `execute search/help/call` 会多两跳，且返回值里有图片，需要 tool-result 通道而不是 `execute` 的 `{text, refs}` 封套。加进 `EXECUTE_PRIMITIVES`，因此 `execute` 永远不能 dispatch 它。

**常驻注册表，不在运行时按宿主增删。** 与 `send` 一致：宿主没有资料读取器（Telegram 未连接）时工具仍在，调用时以 `profile_unavailable` 拒绝。工具面不随连接状态抖动，注册表校验与场景定义在两种状态下形状一致。

**授权就是这段会话历史。** Telegram 侧先用 `messages`/`message_revisions`/`senders` 确认该 uid 在本 Conversation 说过话，再发任何 Bot API 调用。房间侧查询 `room_participants` 并按当前房间的 `chatId` 收窄。跨房间的 sender id、猜出来的 uid、私聊里第三人的 uid 都返回 `found: false`，且不产生外部请求。

**平台能给多少给多少，缺的就是 null。** Telegram 三路调用各管一半：`getChatMember` 给 `standing` 与 `custom_title`（Bot 是管理员时才有），`getChat` 只对私聊问（取 `bio`），`getUserProfilePhotos` 取最新一张最大尺寸并下载。任一调用失败只让对应字段为 `null`——普通成员的 `getChatMember` 被 Telegram 拒绝是常态，不是错误。

**头像复用 MCP 的工具图片通道，顺手去掉 MCP 专属命名。** 原来 `details.mcpImages` 与 `[MCP image <id>]` 是 MCP 专用形状，成员头像不该为了复用而冒充 MCP。重命名为 `details.toolImages` 与 `[image <id>]`，并把三处重复的「嗅探 → `normalizeImage` → 按 Chat 存资产」逻辑收进 `capabilities/media/tool-image-store.ts` 的 `ingestToolImage`。这是持久化形状变更，所以加了迁移 `051` 就地把旧行改写成新键与新标记，保留历史里的图片仍可投影。

## 主要变更

### 1. 宿主接口

`src/platform/im-host/profiles.ts` 定义 `ImMemberProfile`、`ImMemberProfileRequest` 与 `ImMemberProfiles`。资料字段刻意全可空：`displayName`、`username`、`isBot`、`standing`、`title`、`bio`、`languageCode`、`joinedAt`、`avatar`（原始字节，未校验）。`ImHost` 新增 getter 形式的 `profiles?: () => ImMemberProfiles | undefined`，每次调用取当前值，连接建立或断开都不需要重建宿主或工具注册表。

### 2. Telegram 读器

`src/adapters/local-monolith/telegram/profiles.ts`：

- `parseTelegramSenderRef` 只认 `uid:<安全整数>`，其余一律 `null`。
- `knownMember(store, conversationId, senderId)` 用一条 `EXISTS` 查询确认历史里出现过该用户。
- 头像下载写到 `<media_cache>/profile-XXXX/avatar`，`finally` 删除临时目录；`file_size` 超过 10 MiB 直接跳过；照片被隐藏导致的 API 错误按「没有头像」处理。

### 3. 房间读器

`src/adapters/local-monolith/playground/profiles.ts`：`room_participants` join `senders`，按 `chatId` + `senderId` 取一行，返回显示名、角色、加入时间。`username` 只有 Bot 自己那行才有值（来自 `TelegramConnectionIdentity`），房间成员本身没有用户名。没有头像与简介——这是平台事实，不伪造。

### 4. 工具

`src/capabilities/member-profile.ts` 的 `createMemberProfileTool`。参数 `{ member }`（1–64 字符）。审计走标准三态：`invalid_arguments`、`profile_unavailable`、正常调用后 `finishToolCall`，成功时写入 `result_content_json`（含 `details.toolImages`），canonical history 因此只拿得到引用拿不到字节。头像入库失败时降级为文本里的 `avatar: "unavailable (<原因>)"`，不整体失败。

### 5. 装配

- `agent-runtime/support.ts` 的 `memberProfileTool` 同时供 `buildTools` 与 `validateAdditionalTools` 使用，工具位置固定在 `read` 之后。
- `agent-runtime/types.ts` 新增 `toolImageStore: (chatId, bytes, signal) => Promise<ToolImageReference>`，由组合根注入；缺失时工具仍可用，只是不附带头像。
- `telegram/host.ts` 与 `playground/index.ts` 各自接受 `profiles` 选项；`runtime/serve-run.ts` 为 Telegram 按当前 instance 构造读器（连接断开时 getter 返回 `undefined`），为房间构造一次读器。

### 6. 迁移 051

```sql
UPDATE context_messages
SET payload_json = replace(replace(payload_json, '"mcpImages"', '"toolImages"'), '[MCP image ', '[image ')
WHERE payload_json LIKE '%"mcpImages"%';
```

`tool_calls.result_content_json` 同样处理。没有 `@rebuild-tables`：这是行内 JSON 改写，不动表结构。

## 测试与文档

- `test/media/member-profile.test.ts`：两端读器与工具。覆盖完整资料 + 头像、未出现过的 uid 零 API 调用、私聊、被拒的 `getChatMember` 与隐藏照片降级、头像无法规范化时降级、房间字段、裸 `member_<n>` 形式、跨房间 id。
- `test/agent/runtime-member-profile.test.ts`：真实 Invocation。原语出现在 provider 收到的工具表；头像在请求里成为 image block；`context_messages` 里只有 `toolImages` 引用、没有 base64；没有读器的宿主仍提供服务并在调用时拒绝。
- `test/schema/migrations-tool-images.test.ts`：050 写下的旧行升级后键与标记都改写成新形状，解码结果一致。
- 更新受工具表形状影响的既有断言：`runtime.test.ts`、`runtime-tool-limits.test.ts`、`runtime-photo-history.test.ts`、`alarm.test.ts`、`sleep.test.ts`、`skills.test.ts`；schema 版本断言升到 51。
- 文档：`AGENTS.md` 原语清单、`agent-doc/telegram-agent-flow.md`（原语与成员资料、工具图片通道）、`agent-doc/data-layer.md`（051 与 `toolImages`）、`agent-doc/verification.md`（三条测试行）。

## 验证

```bash
pnpm run lint
# biome lint + format 通过（1230 / 1227 个文件）

pnpm run check
# tsc（runtime / cli / admin-next / docs）通过

pnpm test
# 367 passed | 1 skipped（368 个文件）；2029 passed | 8 skipped（2037 个用例）

git diff --check
# 无输出
```

未执行：真实 Telegram 群里的 `getChatMember`/`getUserProfilePhotos` 验收（需要真实 Bot 与真人账号，含管理员与非管理员两种权限），以及真实 Provider 下头像对模型判断的影响评估。Admin Panel 前端未改动，因此没有跑 e2e。

## 已知限制

- Telegram 侧只读「本 Conversation 里说过话的人」。Bot 是管理员时 Telegram 本可返回从未发言成员的信息，但那条路径同时会允许模型用任意 uid 探测账号，所以有意收窄。
- 头像只取最新一张的最大尺寸，不做多图或历史对比。
- 房间没有头像与简介，也没有用户名（Bot 自己除外）。
- `joinedAt` 只有房间能给：Bot API 没有成员加入时间。
- 工具图片通道在缺 `toolImageStore` 的进程（部分场景/诊断路径）里只返回文本，不附加图片。

## 提交

```txt
11f8e13 Add read_member_profile primitive
```
