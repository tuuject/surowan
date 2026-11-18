# Surowan - 20261118 修复移动端会话弹窗溢出

## 背景

移动端打开「编辑会话」时，输入框、模型下拉框和帮助文字的右侧会被弹窗裁掉。原生下拉框的最长选项会增大 `fieldset` 的最小内容宽度，导致整个表单超出弹窗可用宽度。360px 视口的回归用例中，表单内容宽 551px，可用宽度为 280px。

## 主要变更

在新增和编辑会话共用的 `ChatForm` 里，将 `fieldset` 的 `min-inline-size` 设为 `0`，让表单可以随弹窗收窄。Playwright 选中长模型 ID 后检查表单横向尺寸和保存按钮，生成 `mobile-chat-edit.png`，并在取消后通过 API 复核配置 revision。

## 验证

- `git diff --check`、`pnpm run lint`、`pnpm run check`、`pnpm run admin:build` 通过。
- `pnpm run admin:test:e2e 09-chats 29-modal-transitions` 共 17 条通过。
- `pnpm run admin:test:e2e 09-chats.e2e.ts -g 'mobile Chat edit'` 在修复前复现溢出，修复后通过。检查了暗色窄屏截图。
- 实机与生产环境验收待执行。

## 提交

```text
15da3ea1 Fix Chat dialog overflow on mobile
```
