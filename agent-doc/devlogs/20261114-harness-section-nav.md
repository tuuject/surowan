# Surowan - 20261114 Harness 页分区导航

## 背景

Admin Panel 的 Harness tuning 页把 `agent` 段配置分成预算与并发、发送行为、限流、上下文、主动回复五组，竖着排成一张长表单，页宽 768px。要找后面的分组只能一路往下滚，也看不出哪一组有待修正或未保存的改动。

用户希望它像 design 仓库 Admin 模板的「助手配置」页（`apps/admin/src/routes/_authed.assistant-settings.tsx`，`components/sectioned-form/`）那样带分类导航。模板的 `SectionedForm` 绑定 react-hook-form；Harness 页有自己的草稿模型（`draftOf` / `parseDraft`）和 `FormActionBar`，所以只移植导航、scrollspy、标记和布局，保存流程不动。

这次是试用委派流程：实现由 OpenCode 子线程（经 T3 Code 派发）完成，`ocr review` 审阅后打回修正两轮，最后由主会话复验并提交。

## 主要变更

### 1. `components/section-navigation/`

- `index.tsx`：`containerType: 'inline-size'` 按表单容器自身宽度布局。宽于 720px 时左侧是 200px 吸顶列表，当前分组带 `aria-current="location"`，点击跳转并聚焦组标题；更窄时隐藏列表，改为吸顶的 `SelectPanel` 下拉框，和模板的 `SectionMenu` 一样不移动焦点。顶部偏移与焦点环复用 `components/app-shell/shared` 的 `HEADER_OFFSET` / `HEADER_HEIGHT` / `focusRing`，`scroll-margin` 让跳转落在顶栏下方、避开底部操作栏。
- `outline.ts`：只管 DOM 的 scrollspy，不碰表单状态。当前项是第一个仍越过顶栏线的分组；较短的末组只有在实际滚动容器滚到底时才成为当前项（`apps/admin-next/src/components/section-navigation/outline.ts:124`）：

  ```ts
  const atEnd = scroller.scrollTop > 0 && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1;
  ```

  点击跳转会锁定所选分组，直到用户自己滚动。跳转是否结束不依赖 `scrollend`：每帧比较滚动位置，连续两帧不动就收尾（`outline.ts:74`）。停下的位置偏离目标说明中途被打断，这时解除锁定再重算（`outline.ts:103`）。所以「点一个已经对齐的分组」和不支持 `scrollend` 的浏览器都不会把锁卡住。
- `markers.tsx`：待修正用错误图标，未保存用小圆点，各自带只给读屏器的文字。

### 2. Harness 页接入

`apps/admin-next/src/pages/harness.tsx:101` 用 `SectionNavigation` 包住原表单，按 `HARNESS_GROUPS` 把 `parseDraft` 的 `errors` / `changes` 汇总到分组；每组外包一层 `data-form-section`（`harness.tsx:126`）。页宽改为 960px，`Panel` 新增可选的 `headingTabIndex`，标题才能被程序聚焦。中英文 locale 都加了 `harness.sections.*`。

### 3. 测试

`apps/admin-next/e2e/19-harness.e2e.ts` 新增：

- 用滚轮从顶部往下滚，高亮依次经过各组；Context 还越过顶栏线时，即使主动回复整组已经露出来，Context 仍是当前项；滚到底时主动回复成为当前项（`19-harness.e2e.ts:21`）。
- 点击已对齐的分组后，用 `page.evaluate` 模拟拖滚动条，高亮跟随滚动；分别在有无 `scrollend`、减弱与正常动效下各跑一遍（`19-harness.e2e.ts:74`）。
- 点击跳转、聚焦标题、校验与未保存标记、容器宽度切换（侧栏折叠与手机宽度），以及中英文 × 明暗主题 × 1440/390 宽度下无横向溢出，都会截图。

`01-routes` 的分组标题断言改为按 heading 定位，因为导航里也出现同样的标题。

### 4. 审阅中修掉的问题

`ocr review` 报了 4 条，核对后 3 条成立，打回给 OpenCode 修正：

- 末组判断原来只看它是否露出，Context 还在顶栏线上时就会被抢走高亮，现在改为滚到底才算。这个启发式是从模板 `outline.ts` 一起照搬过来的。
- 跳转到已对齐的分组时 `programmatic` 永远不复位，之后拖滚动条高亮不动。
- 原测试只覆盖点击跳转，没有覆盖用户向下滚动。

第 4 条（窄屏下拉跳转后断言标题获得焦点）是误报，与模板的 `SectionMenu` 行为一致，没有改。新增的回归用例确认过在旧实现上失败 3 个。

复验时又发现「中英文 × 主题 × 宽度」用例不稳定（单跑 5 次失败 1 次）。根因是切换语言后「中文」提示框在缩屏后短暂停留在桌面坐标，`scrollWidth` 读到 1206px 后才回到 390px，页面本身没有横向溢出。测试改为先等导航切到对应形态，再用 `expect.poll` 等严格的零溢出。

## 验证

```bash
git diff --check
# 通过
pnpm run lint
# exit 0
pnpm run check
# exit 0
pnpm run admin:build
# ✓ built
pnpm run admin:test:e2e 19-harness --repeat-each 5
# 60 passed
pnpm run admin:test:e2e 19-harness 01-routes 24-i18n
# 42 passed
```

OpenCode 另外报告 `pnpm run admin:test:e2e 19-harness --repeat-each 10` 120 项全部通过（主会话未重跑这一项）。

未执行：完整 `pnpm run admin:test:e2e` 全套件、完整 `pnpm test`（只改了 Admin 前端）、Firefox 与 Safari 下的手动检查。

## 提交

```txt
559b0e9d Add section navigation to the Harness page
```
