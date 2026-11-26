# Surowan - 20261127 概览对话视图改为铺满面板宽度

## 背景

`20261126-invocation-chat-layout.md` 之后，用户质疑概览对话视图的宽度是写死的。对话列外层是 `maxWidth: '960px'`，靠起始边对齐；960 不是 Koi 的尺寸 token（Koi 的阅读列 token 是 `content-max`，56rem）。

临时脚本（未提交）量出的标签页面板宽度与对话列宽度：

| 视口 | 面板 | 对话列 | 右侧空出 |
| --- | --- | --- | --- |
| 1280 | 984 | 960 | 24 |
| 1920 | 1624 | 960 | 664 |
| 2560 | 2264 | 960 | 1304 |

上方的摘要卡片与批改笔记卡片都铺满面板，宽屏下 Bot 回复的右边缘和批次分隔线却停在页面中间，与卡片的右边缘对不上。

## 主要变更

`apps/admin-next/src/components/invocations/overview-tab.tsx` 去掉 960px 的外层容器，对话列直接铺满面板：左边缘与标签栏对齐，右边缘与摘要卡片对齐，Bot 回复贴同一条右边线。气泡保留 Koi `ChatBubble` 自带的 480px 上限，文字行不会被拉长；步骤里展开的 JSON 面板可以用满宽度。

考虑过用 `content-max` 居中成一条阅读列，但它会让对话列的左边缘离开标签栏和卡片的左边线，同样不对齐，所以没用。

## 验证

```bash
# 临时脚本在 1280 / 1920 / 2560 下量面板与对话列宽度
# 改后：984/984、1624/1624、2264/2264；1920 截图里分隔线和回复右边缘与摘要卡片右边缘重合

pnpm run admin:build && pnpm run admin:test:e2e 41-invocation-chat 03-invocation-detail 13-sender-ids 34-invocation-review
# 28 passed（含 390px 无横向滚动的断言）

npx biome lint apps/admin-next/src && (cd apps/admin-next && pnpm exec tsc --noEmit) && git diff --check
# 通过
```

公开截图 `tuning/invocation-resume`（中英）在 1440px 视口下拍摄，面板约 1144px，比原来的 960px 列宽了近 200px，分隔线随之变长，所以重拍并替换：

```bash
pnpm --filter surowan-admin-next exec playwright test --config playwright.docs.config.ts tuning-runs -g invocation-resume
# 2 passed（en、zh-CN）；看图确认分隔线延伸到摘要卡片右边缘后，从 staging 手动复制到 apps/docs/content/public/screenshots/tuning/
```

未运行：完整 e2e、全量 vitest（只改了一个视图容器）。

## 提交

```txt
a0aa3012 Let the invocation chat use the full panel width
```
