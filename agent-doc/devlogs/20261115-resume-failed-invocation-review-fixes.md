# Surowan - 20261115 Invocation 续跑：review 修复

## 背景

`20261115-resume-failed-invocation.md` 记录的续跑功能（`473cf7f6`）开 PR #90 后，交给另一个 agent（Pi，GPT-6.1 Sol，thinking xhigh）用 open-code-review 审阅。它报了 6 个问题（2 高 4 中），其中 4 条来自 ocr，2 条是它自查发现的。主会话读源码逐条核实，6 条都成立。本次是对应的修复。

## 主要变更

### 1. 失败批次没进 Context 时，改为拷贝冻结快照重跑（高）

原实现假设失败批次一定已经写进 canonical Context：一般情况下确实如此，开场 checkpoint 在第一次模型调用前就写入了。但进程在 checkpoint 前崩溃（恢复后标为 `aborted`），或在 `agent.prompt` 之前就失败时，`invocation_buckets.injected_at` 为空，批次不在 Context 里。续跑这时只拍了有条数上限的 history，原输入可能丢一部分，也不会生成 new 消息才有的 reply 引用。

`src/orchestration/invocation-queue/resume.ts` 现在先查源运行开场 Bucket 的 `injected_at`。为空时，把源运行的 `history` 行和开场批次的 `new` 行（`source_bucket_id` 为开场 Bucket）拷到新 Invocation，`new` 行改挂新 Bucket：

```ts
if (opening?.injectedAt === null) {
  store.orm.run(
    sql`INSERT INTO invocation_messages
          (invocation_id, source_bucket_id, sequence_no, message_id, revision_id, section, omitted_before, snapshot_json, snapshot_format)
        SELECT ${resumed}, CASE WHEN section = 'new' THEN ${bucket.id} ELSE NULL END, sequence_no, message_id,
               revision_id, section, omitted_before, snapshot_json, snapshot_format
        FROM invocation_messages
        WHERE invocation_id = ${invocationId} AND (section = 'history' OR source_bucket_id = ${source.bucketId})`,
  );
} else {
  snapshotInvocation(store, current.config.agent.history_messages, resumed, bucket.id, source.conversationId, true);
}
```

只拷开场批次：其后的批次只能在开场注入之后 attach，开场没注入就不会有，原运行也已经通过 `releaseUninjectedBuckets` 把它们作为独立工作释放了。`src/context/builder/render.ts` 只在本批没有 new 消息时才调用 `adminResumeState`，所以重跑未注入批次就是一次普通运行，不带「本批无新消息」的说明。

### 2. 换模型导致 Context 重建：改措辞并写进文档，不拦截（高）

换到图片能力不同的模型、或窗口更小的模型时，`contexts.open` 可能重建 Context。这时工具结果、任务回执正文这类非聊天内容就没了。核实后的结论是：续跑入队时拍的历史快照里有失败批次和 Bot 已发出的消息，重建后 transcript 为空，这些历史不会被去重，会完整渲染；丢的只是非聊天内容。这和用户原来「换模型 + 手动发一条消息」的流程完全一样，所以没有加拦截（要在守卫里预判新模型会不会重建，就得在 admin 侧重新计算稳定 prompt）。

`src/context/builder/admin-task.ts` 的说明行从「your history shows what you already sent」改为让模型从自己的历史或聊天记录里接着做未完成的事，不再暗示 transcript 一定还在。用户手册和 `agent-doc/admin-panel.md` 都写明了这个限制。

### 3. 历史快照不收仍在 collecting 的消息（中）

失败之后又来了新消息，消息在一个还没到期的 collecting Bucket 里，这时点续跑：历史快照只排除了自己那个空 Bucket 的消息，于是把 collecting 消息当 history 收了进来；等那个 Bucket 到期或被 attach，同一条消息又作为 new 注入一次。渲染器只对 history 去重，不对 new 去重。

`src/store/invocation-snapshot.ts` 的历史查询加了排除条件：

```sql
AND m.id NOT IN (
  SELECT pending.message_id FROM bucket_messages pending
  JOIN buckets pb ON pb.id = pending.bucket_id
  WHERE pb.conversation_id = ${conversationId} AND pb.state = 'collecting')
```

子查询不相关，只算一次，走 `bucket_messages` 主键。普通 Bucket 入队时，同一 Conversation 不会有别的 collecting 批次（`one_collecting_bucket_per_conversation`），这条不起作用。任务回执同样是在 collecting 批次旁边开的运行，原本也有这个重复问题，这次一并修掉。

### 4. Telegram 未就绪时拒绝续跑（中）

Telegram 停用（没有 token）或未连接时，原守卫照样放行，Scheduler 按宿主就绪过滤永远不会启动这一行，它就一直停在 queued，还会让后续续跑因 `conversation_busy` 被拒。

`resumeBlockReason` 新增 `isHostReady` 参数，返回 `host_unavailable`。`src/ingress/admin/routes/index.ts` 用面板已有的 `ImConnectionRegistry` 构造一次 `(host) => host === 'playground' || connections.isReady(host)`，分别传给 control（POST）和 inspection（详情的 `resume.available`）。这和 serve 给 Scheduler 用的就绪判断同源，少了替换实例期间的 `transitioning` 窗口，那只是瞬时状态。

### 5. 保留清理跳过仍被续跑引用的源运行（中）

源运行完成时间超过 `retention.online_days`，续跑排队期间如果恰好跑了一次 `purgeExpiredData`（比如 backup），源运行会被删掉，`ON DELETE SET NULL` 把链接清空，新运行的开场批次就没有说明行了。

`src/store/store.ts` 的 `host_sends` 与 `invocations` 两处删除都加了 `NOT EXISTS (... r.resumed_from_invocation_id = i.id AND r.state IN ('queued', 'running'))`，走迁移 060 的索引。续跑结束后，说明行已经在 canonical Context 里，源运行照常清理。没有选择把原因冗余存到新运行上，因为那需要再加列。

### 6. 被拒后刷新详情（中）

两位管理员同时打开同一个失败详情，第一位续跑后，第二位点击得到 409 `resume_not_latest`，但只弹 toast：详情查询不轮询、也关了窗口聚焦刷新，按钮一直留着。`apps/admin-next/src/components/invocations/detail-header.tsx` 把详情与列表的 invalidate 从 `onSuccess` 挪到 `onSettled`，失败也刷新。

## 验证

`test/invocations/resume.test.ts` 新增 3 个用例并扩充 1 个，文件头的出错方式清单从 9 条增加到 13 条：

- (10) `scheduler.processDue()` 只入队不启动，再标成 `aborted` 模拟崩溃恢复（`injected_at` 为空）。续跑后，新运行的快照是一条挂在新 Bucket 上的 `new` 行；跑完后 `hello there` 在 canonical Context 里只出现一次，没有续跑说明行；
- (11) 失败后停掉调度器，再入库一条消息让它留在 collecting。续跑快照只有原消息这一条 history，不含 collecting 消息；
- (12) 拒绝用例中加入 Telegram 停用：POST 返回 409 `resume_host_unavailable`，详情的 `resume.reason` 同步；
- (13) 续跑排队期间把源运行推到 40 天前再 purge，源运行和链接都保留，说明行仍能生成；把续跑标为完成后再 purge，源运行被删、链接置空。

e2e：`03-invocation-detail` 的续跑用例先断言 Telegram 停用时 4127 不显示按钮，再经 `/__e2e/telegram-connection` 连上；新增 `35-invocation-resume-race`：另一位操作者先用 API 续跑 4127，再点按钮得到「only the latest one can be resumed」toast，按钮消失，并出现指向胜出运行的「Resumed by」链接。这个用例单独放一个文件，因为续跑会用掉种子会话里唯一能续跑的那次运行，而每个 spec 文件有自己的种子服务器。

```bash
npx vitest run test/invocations/resume.test.ts
# Test Files 1 passed (1) · Tests 7 passed (7)

pnpm test
# Test Files 1 failed | 396 passed | 1 skipped · Tests 1 failed | 1956 passed | 9 skipped
# 唯一失败：test/recurring-alarms/schedule.test.ts「croner is imported only by …」，
# Windows 路径分隔符问题，develop 上同样失败，与本改动无关

pnpm run admin:build
pnpm run admin:test:e2e 03-invocation-detail 35-invocation-resume-race
# 14 passed
pnpm run admin:test:e2e 01-routes 05-readonly-security 14-api-keys 02-lists-filters-invocations 30-dev-mock 34-invocation-review 21-telegram
# 62 passed

DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# 两个 base 都 Verified 53 HTML/Markdown pages …；构建后 git status 只有本次改动

git diff --check && pnpm run lint && pnpm run check
# 全部通过
```

未执行：

- 真实 Telegram 验收；
- 产品知识索引仍未重新烘焙。

## 提交

```txt
453e428e Harden invocation resume against unsent batches and stale state
```
