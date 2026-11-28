# Surowan - 20261128 只在内存里比较的指纹不再哈希

## 背景

排查全仓库的 `createHash` / `subtle.digest` 后，有三处哈希的结果只在同一进程的内存里和上一次的值做 `===` / `!==`，既不落库、不出网，也不需要隐藏明文。这三处哈希只会多一次 CPU 计算，其中一处还截断到 64 bit：

1. Invocation 实时变更流（`src/ingress/admin/audit/invocation-live.ts`）把每拍的聚合查询结果 `JSON.stringify` 后做 sha256，截成 16 位 hex，再和上一拍比较。这个摘要还被写进 SSE 的 `data`，但前端 `apps/admin-next/src/hooks/use-live-refresh.ts` 收到 `change` 事件只会重取，从不读 `data`。
2. 配置热重载（`src/adapters/local-monolith/config/reload-apply.ts`）对 `imageSnapshot` 整体再做一次 sha256 作为身份；而快照的 `version` 本来就是 `sha256({ models, credentials })`（`src/image/service.ts:111`），等于重复哈希。
3. `secretRefsDigest`（`src/platform/providers.ts`）把每个 SecretRef 的 `SecretStore.digestOf`（已经是 sha256）放进数组，再对整个数组做一次 sha256；结果只用于 provider / MCP 的轮换判断。

排查中还有第四处候选：`mcp_server_state.registry_hash` 每次 MCP Server 变为 ready 都会计算并写库，但生产代码里没有任何地方读它。不过经用户审核的 PRD `doc/design/20261023-file-system.md:47` 计划用它检测 MCP schema 变化（给尚未实现的 `path_params` 用），用户决定保留，本次不动。

其余哈希都有保留的理由：Session token 摘要、请求签名与配对码属于安全要求；Memo Blob / Playground 资产 / 图片按 `(chat_id, sha256)` 唯一索引去重；config revision 与 prompt `content_hash` 是交给面板和 CLI 的并发令牌；`digestOf` 与 `telegramTokenIdentity` 是为了不在重载状态里留第二份明文；`conversation_contexts.system_prompt_hash` 用于跨进程持久化比较。

先列出可能的失败方式：

1. 实时流的 `data` 改成直接发签名文本，把页面渲染的每一列都推给浏览器，而且体积随 Invocation 增长。
2. `data` 留空：按 SSE 规范，`data` 为空的事件不会派发，页面就再也不会重取。
3. 去掉哈希后，原来就有的「漏报插入/UPDATE」「无变化也推送」回归。
4. 图片快照改用 `version` 后，同名 SecretRef 轮换或只改模型描述却没能触发重新发布。
5. `secretRefsDigest` 不再哈希后，keychain 轮换检测失效，或者 `command` 引用在检测时被执行。

## 主要变更

### 1. 实时流比较签名文本，`data` 改为事件序号

`digest()` 改名为 `serialize()`，只保留带 `bigint` replacer 的 `JSON.stringify`（`src/ingress/admin/audit/invocation-live.ts:31`）。两条指纹查询（`:99`、`:150`）直接返回这段文本，路由仍用 `next === last` 比较。

签名文本不再出服务端。`src/ingress/admin/routes/live.ts:139` 为每条流维护一个计数，`data` 发这个从 1 开始递增的序号：

```ts
last = next;
changes += 1;
// The fingerprint is every rendered column of the page, so it stays here.
// `data` only has to be non-empty: `EventSource` does not dispatch an
// event whose data is empty.
write(`event: change\ndata: ${changes}\n\n`);
```

内存上，每条流只多存一段签名文本，长度受单个 Invocation 的行数约束；每个进程最多 32 条流。

`test/admin/live-invocations.test.ts` 的失败清单补了第 12、13 条：首个事件的 `data` 必须是 `'1'`，插入一条 tool call 后的下一个事件必须是 `'2'`（中间的静默窗口一个事件都没发）。`test/admin/live-fixtures.ts` 的 `expectChange` 改为断言正整数，`test/schema/index-plans.test.ts` 只断言详情指纹非空。`agent-doc/admin-panel.md` 的实时流一节同步了 `data` 的语义。

### 2. 图片快照身份直接用 `version`

`ImageConfigGateway.prepare` 原来返回 `unknown`，现在返回 `PreparedImageConfig | undefined`，`PreparedImageConfig` 只声明 `readonly version: string`。`version` 必须随快照内容（包括解析后的凭据）变化，这条契约写在 gateway 的注释里。`reload-apply.ts:188`：

```ts
imageSnapshotId = imageSnapshot === undefined ? 'disabled' : imageSnapshot.version;
```

两个 gateway 接口和 `PreparedImageConfig` 从 `reload.ts` 原样移到新文件 `src/adapters/local-monolith/config/gateways.ts`。原因是加了注释之后，`reload.ts` 超出 pre-commit 的 5,000 token 上限 55 个 token。该目录已有四个 `reload-*` 平铺文件，所以没有再加一个同前缀的 `reload-gateways.ts`。importer（`reload.ts`、`reload-apply.ts`、`test/config/reload-fixtures.ts`、`test/admin/chats-lifecycle-fixtures.ts`）全部改为从新模块导入，没有留 re-export。`test/admin/chats-lifecycle.test.ts` 里的 `prepare` 替身补了 `return undefined`，以满足新的返回类型。

### 3. `secretRefsDigest` 直接返回摘要列表

`src/platform/providers.ts:242` 改为 `return JSON.stringify(digests);`，并删掉不再使用的 `node:crypto` 导入。原来叠放在这个函数上的第二段 JSDoc 本属于 `connectionKeyDigest`，现在移回该函数上方。

## 验证

```bash
git diff --check                 # 通过
pnpm run lint                    # exit 0
pnpm run check                   # exit 0（tsc、cli、admin-next、docs）
pnpm test                        # 495 files, 2626 passed（拆分 gateways.ts 之前）
pnpm exec vitest run test/config test/image test/admin/chats-lifecycle.test.ts \
  test/admin/live-invocations.test.ts test/im test/telegram
# 拆分之后：64 files, 359 passed
pnpm run admin:build && pnpm run admin:test:e2e 02-lists-filters-invocations 03-invocation-detail
# 22 passed
```

失败清单对应的测试覆盖：第 1、2 条由 `test/admin/live-invocations.test.ts` 的事件序号断言钉住，第 3 条由同文件已有的插入/UPDATE/静默用例覆盖，第 4 条由 `test/image/config-reload.test.ts` 的「description-only edit」和「same-name SecretRef rotation」覆盖，第 5 条由 `test/config/reload-key-rotation.test.ts` 覆盖，以上全部通过。

拆分 `gateways.ts` 只改了 type-only 导入，不影响运行时，所以拆分后没有再跑一遍完整 `pnpm test`。

未运行：部署实例里的真实验收（面板实时刷新、图片凭据轮换）。

## 提交

```txt
f5999e6d Compare change fingerprints directly instead of hashing them
```
