# Surowan - 20261118 调整运行详情的移动端布局

## 背景

运行详情的工具调用、模型调用和发送记录在手机上共用桌面表格。固定列挤在一个屏宽内，状态、时间和调用 ID 难以读取。390px 的 Playwright 用例在原版构建上复现了问题。

## 主要变更

- 768px 以下按记录显示可展开摘要，露出工具名与调用 ID、模型名与尝试次数，或发送类型与消息编号，每条独立显示状态。展开后可读带标签的审计字段和原有报文。模型请求仍可下载为 JSON。
- 三个标签页共用现有字段定义和报文渲染器。宽屏继续使用审计表格，窄屏标签栏缩小横向内边距以露出更多标签。

## 验证

- `pnpm run admin:build`、`pnpm run check`、`pnpm run lint`、`git diff --check` 通过。
- `pnpm run admin:test:e2e 03-invocation-detail 34-invocation-review 35-invocation-resume-race` 通过，共 19 项。新增用例验证 390px 下三组记录的摘要、展开和页面宽度，并输出 `phone-tool-calls.png`。
- 验证使用本地 Playwright Chromium 和种子数据。真实手机和线上部署未验收。

## 提交

- `d13b9d3a` Improve invocation detail on mobile
