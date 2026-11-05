# Surowan - 20261105 全局模型切换时重置不兼容的群 Thinking 档位

## 背景

Chat 可以继承全局 Agent 模型、只覆盖 `thinking_level`。此前 Models 页切换全局模型仅重置 `agent.thinking_level`，原群覆盖仍参与完整配置校验；当目标模型不支持该档位时，整个切换被 `config_invalid` 拒绝。

预期是在同一次配置写入中将这些不兼容覆盖显式重置为新模型支持的最弱档，成功后弹窗告知受影响的群；兼容档位与独立模型覆盖不变。

## 主要变更

- `src/adapters/local-monolith/config/reload.ts`：在既有写锁内读取最新配置和 revision，按文件 Chat 索引生成 effort 重置，与全局模型选择一起走 JSONC 原子校验写入；保留注释、其它 Chat 设置、兼容档位和模型覆盖。最弱档来自模型支持列表，不假定为 `off`。
- `src/platform/config/write.ts` 与 `src/ingress/admin/control.ts`：成功结果携带重置明细，`PUT /api/model` 返回 `chat_thinking_resets: { chat_id, previous, current }[]`，没有受影响 Chat 时返回空数组。
- Admin Models 页：成功事件直接打开通知弹窗，列出 Chat ID 和前后档位；中英文文案同步，不增加 effect。
- `test/config/reload-chat-models.test.ts`：将旧的拒绝契约替换为重置契约，覆盖最弱档为 off/low、文件重排和新增 Chat、兼容覆盖保留、独立模型不变、旧 Invocation 快照不变及落盘/运行态/日志一致。
- `apps/admin-next/e2e/04-writes.e2e.ts`：通过真实 AdminServer 和生产 SPA 切换模型，核对弹窗、saved/active 与切回后不弹窗，并将弹窗截图写入 Playwright output 目录和附件。
- 同步 `agent-doc/admin-panel.md`、`configuration.md` 与 `verification.md`。对齐最新 develop 时保留上游测试整理及文档修订。

## 验证

```bash
pnpm run lint
# 通过

pnpm run check
# runtime / CLI / Admin / docs TypeScript 检查通过

pnpm test
# 对齐 develop 后：364 files passed；1730 tests passed

pnpm run admin:build
# 生产 SPA 构建通过

pnpm run admin:test:e2e 04-writes 08-models 09-chats
# 对齐 develop 后：33 passed

pnpm run admin:test:e2e 04-writes --grep "resets an incompatible Chat effort"
# 1 passed；确认 chat-thinking-reset.png 和附件实际落盘

git diff --check
# 通过
```

首次新增回归中修正了日志字段为字符串的断言，以及弹窗中两个 Close 按钮导致的严格定位冲突；修正后上述验证通过。主题文档链接检查：44 个目标均存在。

独立浏览器冒烟使用临时 SQLite 和真实 AdminServer，创建继承全局模型且 effort 为 `max` 的合成群，切换到仅接受 low/medium/high 的模型后看到 `max → low` 通知，API 确认 saved 与 active 均为 `low`。桌面浅色与 390px 手机暗色弹窗均已截图核对，手机页面无横向溢出。临时服务已正常关闭，不触碰用户运行配置。

未执行：真实 Telegram 与外部 LongCat Provider 调用；本次修复路径为本地配置写入和 Admin 通知，不需要模型请求。

## 提交

```txt
d791e6e2fe6d662376fae3c85fb5f1046b6e97ee Reset incompatible chat efforts on model switches
```
