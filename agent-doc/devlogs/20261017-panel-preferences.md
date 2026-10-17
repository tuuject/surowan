# Plastic Wan - 20261017 面板偏好页：浏览器本地显示选项

## 背景

Harness tuning 页（见 `20261017-harness-tuning.md`）最初在每个字段下无条件显示 `agent.*` 配置路径。用户启动服务实际查看后认为这类键名对多数场景是噪音，提出：

- 「显示 config.jsonc 键名」做成一个选项，**默认不显示**；
- 只存在用户浏览器的 localStorage，不进服务端、不写 `config.jsonc`；
- 这类选项应该有自己的设置页；随后又要求把主题与界面语言也放进这一页，同时保留右上角的切换按钮。

改动前，面板已有两个浏览器本地偏好：主题（`ThemeProvider`，localStorage 键 `admin-theme`）与语言（`src/lib/i18n.ts`，键 `admin-language`），都只能通过顶栏按钮循环切换，没有集中的设置页。

## 主要变更

### 1. `panel-preferences.ts`：键名开关的存储

新文件 `apps/admin-next/src/lib/panel-preferences.ts` 放只属于当前浏览器的显示偏好。键 `admin-show-config-keys`：打开写 `'true'`，关闭直接 `removeItem`，所以缺省与关闭在存储上一致；所有读写包在 try/catch 里，存储不可用时按关闭处理。

```ts
// apps/admin-next/src/lib/panel-preferences.ts:20
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab changing the preference updates this one too.
  window.addEventListener('storage', listener);
  // ...
}

// :47
export function useShowConfigKeys(): boolean {
  return useSyncExternalStore(subscribe, readShowConfigKeys, () => false);
}
```

用 `useSyncExternalStore` 而不是另起一个 Context Provider：`setShowConfigKeys`（`:30`）写完后通知本页内的订阅者，`storage` 事件覆盖其它标签页，不需要改 `main.tsx` 的 Provider 树。

### 2. Harness tuning 页按开关显示路径

`apps/admin-next/src/pages/harness.tsx:197`：`HarnessFieldRow` 读 `useShowConfigKeys()`，只有开启时才渲染 `<code>agent.{field.key}</code>`。

### 3. Panel preferences 页

- 路由 `/preferences`（`apps/admin-next/src/routes/preferences.tsx`），侧边栏 Account 组 Settings 之后，图标 `SlidersVertical`；en「Panel preferences」/ zh-CN「面板偏好」，文案在 `pages.preferences`。
- `apps/admin-next/src/pages/preferences.tsx`：一张「显示」卡片，主题 Select（light / dark / system，复用 `layout.theme.*` 文案）、语言 Select、键名 Switch。
- 主题直接用 `useTheme()` 的 `mode` / `setMode`，语言用 `setLanguage()`，与顶栏按钮读写同一状态，两处任一修改另一处即时跟随；顶栏按钮不动。
- 为此 `ThemeMode` 从 `theme-provider.tsx` 导出；语言自称（English / 中文）从 `language-toggle.tsx` 的本地常量挪到 `src/lib/i18n.ts:12` 的 `LANGUAGE_LABELS`，按钮与偏好页共用。

### 4. 测试

- `apps/admin-next/e2e/19-harness.e2e.ts`：原用例改为断言键名缺省不可见；新用例在偏好页打开开关 → 刷新仍开启、localStorage 为 `'true'` → Harness 页出现 `agent.context.ref_ttl_hours` 等路径 → 清空 origins 的新浏览器上下文仍不显示 → 关闭后 localStorage 键被删除。
- `apps/admin-next/e2e/07-theme.e2e.ts`：偏好页选 Dark → `<html>` 带 `dark`、顶栏按钮显示「Toggle theme: Dark」；选中文 → 侧边栏切换语言、主题 Select 显示「深色」，刷新后保留；再用顶栏「切换语言」按钮切回，偏好页 Select 跟随为 English。
- `apps/admin-next/e2e/01-routes.e2e.ts`：`/preferences` 渲染。
- 坑：中文下 `getByRole('link', { name: '面板偏好' })` 同时命中侧边栏与面包屑两个链接，strict mode 报错，断言改用 `.first()`。

### 5. 文档

`agent-doc/admin-panel.md` 前端结构表新增 `src/lib/panel-preferences.ts` 一行（三个 localStorage 键与同步方式），Harness tuning 一节注明路径只在开关打开时显示；用户指南 `apps/docs/content/docs/configure/admin.md` 的常用任务、Harness tuning 与界面语言三处同步。

## 验证

```bash
pnpm run check
# runtime / cli / admin-next / docs tsc 全部通过
pnpm run lint
# biome lint . 与 biome format . 均无错误
git diff --check
# 无输出
pnpm exec vitest run test/admin-harness.test.ts apps/admin-next/src/lib
# Tests  104 passed (104)
pnpm run admin:test:e2e 07-theme 19-harness 01-routes
# 25 passed（首次 1 个因上述 strict mode 失败，修正选择器后通过）
```

未运行：完整 `pnpm test`（本次只改前端与文档，后端无改动）、Admin E2E 全量套件。

## 提交

```txt
2975794 Add browser-local panel preferences page
```
