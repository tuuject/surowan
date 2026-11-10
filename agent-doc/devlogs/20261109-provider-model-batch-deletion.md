# Surowan - 20261109 Provider 模型原子批量删除

## 背景

Providers 页的模型复选框原先只用于批量测试，删除模型仍需逐行操作。用户要求多选后批量删除，并明确要求新增批量接口。

## 主要变更

- 新增 `POST /api/providers/models/delete`，body 为 `{ models: [{ provider, model }] }`。允许跨供应商的 1–200 个目标，TypeBox 校验请求结构，并拒绝重复目标。
- 批量删除先校验全部模型存在、Agent / Vision / Tool Model / Chat 引用，再通过现有 `providerWrite` 与配置写锁完成一次写入和热应用。缺失模型、引用冲突、非法请求和过期 revision 均不会删除任何目标。
- 同一供应商内按数组索引倒序移除，避免 JSONC 数组前移导致删错模型；单项删除复用同一引用保护，并补齐 Tool Model 保护。
- 配置允许 builtin 和 custom 供应商的模型列表为空。删除最后一个模型保留连接、密钥和 header，运行时模型列表同步清空，供应商仍可继续添加模型。
- Providers 页共用多选状态执行测试与删除，跨分页和供应商保留选择。增加“删除所选”及带供应商名称的模型清单确认框；在用模型禁用删除，成功清除已删除项的选择，失败保留整批选择与错误信息。
- 批量接口加入共享 Admin surface，沿用配置 revision、Origin、写权限和 destructive 确认规则，CLI / MCP 命令为 `model delete-many`。
- 确认框支持正文内容，模型清单放在正文中，避免把块级清单嵌入描述段落。同步中英文文案、健康检查 E2E 选择器及 Admin 主题文档。

首次跨供应商全选验收发现原配置要求每家供应商至少一个模型，导致删除全部模型被拒绝。本次允许空模型列表，并同时验证 builtin / custom 连接保留与运行时清空。

## 验证

```bash
pnpm exec vitest run test/admin/providers-delete-models.test.ts
# 10 passed：跨供应商、数组索引、空供应商、角色/Chat 保护、重复/非法目标、认证、Origin、revision。

pnpm run admin:build
# 通过。

pnpm run admin:test:e2e 08-models 16-model-health
# 其余 20 项 Providers / 模型健康流程通过；批量删除的首次全选验收暴露空模型列表约束。

pnpm run admin:test:e2e 08-models-deletion
# 修复约束后 4 passed：跨分页/供应商全选、取消确认、角色保护、失败保留选择与重试、单项删除。
# 保存 batch-deletion-result.json 与 batch-deletion-page.png，记录最终 API 状态和页面。

pnpm run check
pnpm run lint
# runtime、CLI、Admin、docs 类型检查及 Biome lint / format 通过。

DOCS_BASE_PATH=/ pnpm run docs:build
DOCS_BASE_PATH=/ pnpm run docs:verify
DOCS_BASE_PATH=/surowan/ pnpm run docs:build
DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# 两种 base 均通过，各验证 49 个 HTML/Markdown 页面与 161 个 HTTP 资源。

pnpm test
# 367 files / 1759 tests passed，616.06s；首次执行达到 300 秒时限，延长时限后完整通过。

git diff --check
git diff --cached --check
# 通过。
```

Chromium 检查批量删除确认框的 light / dark、rose 配色与 390px 手机宽度，无横向溢出。最终验收 JSON 确认两家供应商模型列表清空，Agent、Vision 和继承中的 Tool Model 引用不变。

本地后端按仓库约定通过 `node --watch src/cli.ts serve --config dev-data/config.jsonc --takeover` 优雅接管，日志确认 `takeover_completed`、`admin_started` 与 `serve_started`；5273 的认证 API 代理恢复响应。

## 未执行

完整 Admin E2E、真实 Electron、Docker、Safari / Firefox，以及真实 Telegram 发言验收。

## 提交

```txt
2b9f171f6ad5a21f389424e7f8f1c1714d171246 Add atomic batch model deletion
```
