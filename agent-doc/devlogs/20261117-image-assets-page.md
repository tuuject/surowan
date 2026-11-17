# Surowan - 20261117 接上 Admin Panel 的生图素材页

## 背景

一次全仓审计发现 `apps/admin-next/src/pages/image-assets.tsx`（管理提示词素材与参考图库，369 行，四个 locale 都有文案）没有路由文件，导航里也没有入口，页面根本打不开；`updateImageAsset`、`updateImagePrompt` 两个 API 函数因此没有调用方。而用户文档 `configure/admin.md` 与 `guides/images.md` 已经把这页当作存在来描述，包括参考图的改名与归档。

用户的决定是把页面接上，而不是删掉。

本次改动由 Devin（`swe-2-high`，T3 子线程 `surowan-audit-epic-e1-image-assets-route-v1`）实现，主会话 review 与复验。

## 主要变更

### 1. 路由与导航

新增 `apps/admin-next/src/routes/image-assets.tsx`（与其他图片页相同的六行路由文件），`routeTree.gen.ts` 由 TanStack Router 的 Vite 插件在构建时重新生成。`src/nav.ts` 的 `NavTo` 与 Media 组加上 `/image-assets`，四个 locale 的 `layout.ts` 补导航标题，措辞与页面标题一致（英文 Image assets，中文「生图素材」）。

枚举路由的地方一并补齐：`e2e/24-i18n.e2e.ts` 的路由清单、`e2e/25-koi-crud-structure.e2e.ts` 的结构断言、`e2e/i18n-stress-helpers.ts` 的压力测试路由。

### 2. 页面打开后才暴露的问题

页面写好之后从没被打开过，接上路由后发现：

- **API 类型与后端对不上**。`src/lib/api/images.ts` 里素材类型写的是 `created_at` / `updated_at` / `generation_id` / `output_index`，而后端（`packages/image-service/src/assets.ts`，`src/ingress/admin/image.ts` 原样透传）返回的是 camelCase，时间列因此渲染为空。类型与列渲染改为 `createdAt` / `updatedAt` / `generationId` / `outputIndex`。
- **没有改名入口**。文档承诺参考图可以改名，页面只有归档按钮。两个标签页的行操作改为 `RowActions`（Rename / Archive），新增 `RenameDialog` 调用 `updateImagePrompt` / `updateImageAsset`。
- **没有「未启用」门控**。补上 `getImageStatus()` 查询，`enabled: false` 时整页换成指向 `/image-settings` 的提示，与 `/image-generate` 同一写法。
- **选择器缓存不失效**。新建、上传、改名、归档成功后同时失效 `image-assets-picker` 与 `image-prompts-picker`，`/image-generate` 的素材选择器立即反映变化。

### 3. review 后的修正（主会话）

- `RenameDialog` 在关闭时把 `lastTarget` 一起清成 `null`，退出动画期间标题变成空字符串。改为只在 `target` 非空时更新：

```tsx
  if (target !== null && lastTarget !== target) {
    setLastTarget(target);
    setName(target.name);
  }
```

- 新 e2e 的上传模拟接口不检查请求体，前端哪怕发出坏字节测试也会通过。现在记录请求体，断言文件名、MIME，以及 base64 解码后与上传的 PNG 字节一致。
- 图片相关的浏览器测试都模拟 `/api/image/**`（e2e 服务器没有接图片服务），所以页面依赖的字段名没有任何测试对着真实后端核对过，这正是上面类型漂移一直没被发现的原因。在 `test/image/admin.test.ts` 的真实 `AdminServer` 用例里补了断言：`image/prompts` 列表项带 `createdAt` / `updatedAt`，`image/images` 列表项带 `source` / `generationId` / `outputIndex` / `createdAt` / 尺寸。
- 界面中文叫「生图素材」，用户文档两处与 agent 文档两处写的是「图片资产」，照文档在菜单里找不到。统一为「生图素材」。

### 4. 文档

`agent-doc/admin-panel.md` 补生图素材页的语义，`agent-doc/verification.md` 补浏览器回归条目，`apps/admin-next/README.md` 补页面小节。

## 验证

review：一轮 ocr，3 条意见。标题闪空（low）与上传模拟不验字节（medium）成立，已修；「状态请求加载中或失败时没有不可用状态」（medium）不改：这与作为参照的 `/image-generate` 是同一套门控，ocr 设想的 503 只在没有接图片服务的测试环境出现，`serve` 里图片服务总是接上的。

主会话亲自运行（在子 agent 的 checkout 内）：

```bash
pnpm run lint && pnpm run check
# 通过

pnpm test test/image apps/admin-next/src test/docs test/manual-pack.test.ts
# 27 files / 123 tests passed

DOCS_SITE_ORIGIN=https://docs.example.com DOCS_BASE_PATH=/ pnpm run docs:build && pnpm run docs:verify
DOCS_SITE_ORIGIN=https://docs.example.com DOCS_BASE_PATH=/surowan/ pnpm run docs:build && pnpm run docs:verify
# 两次都是 Verified 53 HTML/Markdown pages ... 173 HTTP resources

pnpm run admin:build
pnpm --filter surowan-admin-next exec playwright test 12-image-assets 01-routes --repeat-each 5
# 150 passed (35.7s)

pnpm run admin:test:e2e
# 335 passed (3.2m)

git add -A && node scripts/file-token-limit.ts
# 无拒绝输出
```

未执行：

- 全量 `pnpm test` 未跑，只跑了受影响的目录（`test/image`、前端单元测试、文档测试）；本次没有改动运行时源码。
- 页面没有对着真实图片服务在浏览器里走过一遍：e2e 用的是模拟接口，真实后端只有 `test/image/admin.test.ts` 的字段断言与既有的增删改用例覆盖。配置好图片生成的实例上的人工验收未做。
- 子 agent 报告 `01-routes --repeat-each 5` 曾出现一次 `net::ERR_NO_BUFFER_SPACE`（`/contexts`，Chromium 缓冲耗尽），主会话的重复运行没有复现。

## 提交

```txt
c874cb9a Make the image assets admin page reachable
```
