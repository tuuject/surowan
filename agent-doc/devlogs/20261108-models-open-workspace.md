# Surowan - 20261108 Models 工作区减少卡片

## 背景

用户指出 `5350b5926c0e85b5daa65aaaa66f914e90767423` 重排后的 Models 页仍使用过多卡片，与 Koi 官方布局审美不符。页面当时给 Current models、Provider 导航、Connection 和 Models 各套一张 Card。

对照 Koi 的 Card spec、Admin 模板与布局指引后，本次保留独立摘要所需的一张 Card，将连续管理工作区直接铺在页面上。

## 主要变更

- `components/layout/panel.tsx` 增加 `variant="plain"`，使用带标题的语义 `section`，保留区域名、说明和操作布局。默认 Card 行为继续服务其它页面。
- Provider 导航移除 Card、搜索区底边和新增操作区顶边；保留搜索、刷新、在用分组、选中状态与新增按钮。
- Connection 与 Models 使用 plain Panel，通过 32px 分组间距和一条横向分隔线建立层级。连接组件改名为 `provider-connection-section.tsx`，迁移唯一调用方并移除旧文件路径。
- Current models 继续使用摘要 Card。连接保存、模型编辑、发现、切换、健康检查、分页和 revision 冲突处理未改动。
- 更新 Admin README 与 `agent-doc/admin-panel.md` 中的布局和共享 Panel 契约。
- 结构 E2E 验证 Models 页正文只有一张摘要 Card，连接与模型列表不带 Card 框架。
- 首次受影响 E2E 暴露健康检查测试把耗时单位写死为 `ms` 的偶然断言：失败产物实际显示 `TTFB 1.15 s, total 1.42 s` 且状态成功。移除单位断言，保留真实请求、响应、状态恢复和重复调用等行为验证。

## 验证

```bash
pnpm run admin:build
# 通过；保留 harness.tsx 中既有 useShowConfigKeys 的 Panda 抽取警告。

pnpm run check
# runtime、CLI、Admin、docs TypeScript 检查通过。

pnpm run lint
# Biome lint 与格式检查通过。

pnpm test apps/admin-next/src
# 3 files / 10 tests passed。

pnpm run admin:test:e2e
# 257 passed（68.84s）。

pnpm test
# 首次执行受 300 秒命令时限中断；取消命令时限后重跑。
# 366 files / 1746 tests passed（447.08s）。

git diff --cached --check
node scripts/file-token-limit.ts
# 通过；代码提交的 pre-commit guard 也通过。
```

真实 Chromium 页面检查：1440px 与 390px，light / dark，默认 koi / rose 配色，共八种组合均无整页横向溢出，Models 正文只有一张摘要 Card；检查了搜索提交及清除、Provider 切换、水平导航下的 sticky Provider 区、Tool Model 弹窗，页面无异常。

代码提交后对齐 `origin/develop`，新增基线内容只有 `doc/design/20261107-model-selection.md`，rebase 无冲突；未修改该产品设计文档。

## 未执行

真实 Electron、Telegram、Docker、Safari / Firefox，以及本轮启用 Passkeys 的验收。

## 提交

```txt
51037e6c0b802a6d6a238141ab45e3892e07e95b Flatten Models provider workspace
```
