# Surowan - 20261109 Admin 弹层过渡与滚动位置

## 背景

Koi 的 `Dialog` 由 Base UI 驱动，进入/退出过渡只在该 Dialog 的根保持挂载、`open` 从 false 切到 true 再切回 false 时才会播放。Admin Panel 里多处弹层按「打开时挂载、关闭时卸载」实现，浏览器实测 21 条弹层路径中有 16 条完全没有触发进入或退出过渡；另有多处弹层的标题或正文与 `open` 共用同一份状态，退出过渡开始的第一帧就被清空。

用户报告两类现象：编辑模型对话框没有开关动画；打开 modal 时页面被强制滚到 `y=0`。

## 主要变更

- 页面滚动改由 `html` 的 `overflow-y: auto` 承担，`body` / `#root` 保留全高布局但不再作为滚动容器。Base UI 因此在 macOS 上锁定 `html` 而不是固定一屏高的 `body`，长页面不会被裁短、滚动位置不再归零。
- 模型编辑对话框改成常驻挂载 + 独立 `open`，关闭期间保留模型快照与表单内容；每次打开只用递增的 `formKey` 重挂内层表单，取消的草稿不会带入下一次编辑。
- 其余弹层按同一约定修复：Providers 的新建向导、模型选择器与嵌套的模型确认；Chats 的增删改与三个设置编辑器；API keys 的三类弹窗与撤销确认；设置页的 Passkey 注册与删除确认；Dictionary 的新建、编辑、导入、导出、合并与删除确认；Web search 引擎编辑器；Prompts 的两个确认框；Bot admins 新增；Playground 新建房间；Models / Providers 的 Thinking reset 提示。
- 关闭时只翻转 `open`，标题与正文继续读保留快照，退出过渡结束后才由组件库移除弹层。保存成功不再顺带清空表单，改为在下一次打开时替换。
- API 密钥明文仍是例外：关闭的同一帧清空明文，展示弹层允许在退出期间只剩外壳与标题；该弹层同时固定 `role`，避免 Koi 因 role 变化切换 Base UI 根组件而跳过过渡。
- `provider-wizard.tsx` 超出提交钩子的单文件体积上限，按职责拆出 `provider-wizard-steps.tsx`（连接 / 凭据 / 模型三步），入口保持原文件名。
- 新增 `apps/admin-next/e2e/29-modal-transitions.e2e.ts`：监听真实 `transitionrun` 事件断言进入与退出过渡都存在，并在 `data-ending-style` 出现的瞬间读取标题，断言它没有被提前清空；覆盖 Providers（含嵌套确认）、Chats、API keys、Dictionary、Web search、Bot admins、Playground 与 Prompt 恢复确认。
- 同步更新 `agent-doc/admin-panel.md` 的前端约定与 `agent-doc/verification.md` 的覆盖清单。

## 验证

```bash
pnpm run admin:test:e2e 29-modal-transitions
# 6 passed：Providers（含嵌套元数据确认）、Chats、API keys、Dictionary、
# Web search + Bot admins + Playground、Prompt 恢复确认。

pnpm run admin:test:e2e
# 280 passed：全量 Admin E2E 通过。

pnpm test
# 367 files / 1760 tests passed。首次执行有 2 项无关的后端用例超时失败，重跑全部通过。

pnpm run check
# runtime、CLI、Admin、docs 类型检查通过。

pnpm run lint
# Biome lint 与 format 通过。

pnpm run admin:build
# 通过。

git diff --check
# 通过。
```

修复前用同一探针逐条测量：21 条弹层路径里 16 条 `transitionrun` 计数为 0，两条正常对照各产生 opacity 与 transform 双向事件。修复后同一批路径全部产生双向事件，关闭瞬间标题非空。

顺带更新了 Koi 迁移后遗留的过时选择器：`08-models-deletion` 与 `16-model-health*` 仍按旧的 `Delete selected (N)` / `Test selected (N)` 文案断言，现在改为 `Delete` / `Test` 按钮加独立的 `N selected` 计数行。

## 未执行

真实 Telegram 验收、Docker 镜像构建、Safari / Firefox、Electron 外壳，以及 `E2E_PASSKEYS=1` 下的真实 WebAuthn 注册/登录（全量 E2E 跑的是未配置 `admin.public_url` 的默认分支）。

## 提交

```txt
c0932df5101504631ae6575ab7ac527cd27d2508 Fix model dialog transitions and modal scroll locking
8aa114278858c3c9f6b4d9f5d6b6f2f3763e9be0 Keep admin modals mounted so their transitions play
```
