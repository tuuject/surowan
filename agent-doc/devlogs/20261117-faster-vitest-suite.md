# Surowan - 20261117 测试文件共用模块注册表，全量 vitest 从约 22 分钟降到约 12 分钟

## 背景

一次全仓审计里测到全量 `pnpm test` 要 22 分钟：408 个测试文件串行执行，每个文件单独隔离。vitest 自己在那次运行的汇总里给出了原因：

```txt
Duration  1335.36s (tests 55%, import 44%, transform 1%)
Import  1117 modules were evaluated 8413 times · 566.17s total, 44% of tracked time
        ~491.00s faster with isolate: false
```

将近一半时间花在为每个文件重新加载同一批模块上。仓库规则要求跨模块改动跑完整 `pnpm test`，22 分钟让这条规则很难被执行。

约束：不改任何生产源码，不删除、跳过、放宽或调换任何断言。

本次改动由 Devin（`swe-2-high`，T3 子线程 `surowan-audit-epic-t-test-speed-v1`）实现，主会话 review 与复验。

## 主要变更

### 1. `vitest.config.ts` 拆成两个 project

```ts
    fileParallelism: false,
    projects: [
      {
        test: {
          name: 'isolated',
          include: ISOLATED_FILES,
          isolate: true,
        },
      },
      {
        test: {
          name: 'shared',
          include: TEST_GLOBS,
          exclude: ISOLATED_FILES,
          isolate: false,
        },
      },
    ],
```

- `shared`：几乎全部测试文件共用一份模块注册表，模块只加载一次。这是提速的全部来源，import 占比从 44% 降到 3%。
- `isolated`：7 个文件保持逐文件隔离。它们都用 `vi.mock` 替换了别的套件也会加载的模块（`node:fs/promises`、`grammy`、`src/platform/subprocess.ts`）；在共享注册表下，mock 只在注册它的文件运行期间生效，其他文件会拿到被 mock 过的导出。全仓使用 `vi.mock` 的正好就是这 7 个文件。
- 文件之间仍然串行（`fileParallelism: false`）。测试会改 `process.env`、挂 console / stdin 的 spy、起子进程、用假定时器，两个文件并发就会互相踩；要放开并行得逐文件审计这些全局状态，是另一件更大的事。

### 2. 共享 fixture 的清理改为绑定到当前测试

模块只加载一次之后，写在 fixture 模块顶层的 `beforeEach` / `afterEach` / `afterAll` 只会绑定到第一个导入它的测试文件，后面的文件创建的数据库、服务、spy 和临时目录就没人清理了。`test/helpers.ts` 新增两个 helper：

```ts
export function afterThisTest(close: () => Promise<void> | void, fallback: () => void): void {
  try {
    onTestFinished(close);
  } catch {
    fallback();
  }
}
```

在测试内调用时用 vitest 的 `onTestFinished` 把清理挂到当前测试；在测试外（例如 `beforeAll`）调用时走 `fallback`，通常是推进模块自己的清理数组。`trackTempDirectory(bag, dir)` 是它针对临时目录的包装。`onTestFinished` 的回调按注册的逆序执行，所以「先关数据库、再删目录」的顺序保持不变。

需要 `beforeEach` 建立状态的 fixture（如 `test/playground/delivery-fixtures.ts`）改为导出一个安装函数，由每个测试文件在顶层调用一次。

全仓「模块顶层注册钩子、又被多个测试文件导入」的 fixture 共 22 个，全部处理过；主会话用脚本复扫确认没有遗漏。

### 3. 文档

`agent-doc/verification.md` 更新 `pnpm test` 的运行方式说明与预期耗时。`vitest.config.ts` 里那句「bun test ran files sequentially」的过时注释换成了现在的真实原因。

## review 过程

一轮 ocr，3 条意见，主会话逐条实测：

| 意见 | 判定 |
| --- | --- |
| `test/helpers.ts` 引入 `vitest` 后，Playwright 的后端（普通 Node 进程，它导入这个文件）一导入就会抛错，全量 e2e 起不来（high） | 不成立。在普通 Node 进程里实测，`vitest` 与 `test/helpers.ts` 都能正常导入；全量 e2e 329 条通过，耗时与之前相同（2.7 分钟） |
| 内联 project 不继承根配置的 `setupFiles`，`test/setup/pin-browser-language.ts` 不再执行（medium） | 不成立（vitest 5.0.3）。主会话分别在 `shared` 与 `isolated` 两个 project 里放探针测试，断言 `navigator.language` 是 setup 文件定义的自有属性，两边都通过 |
| `test/tasks/migration-upgrades.test.ts:107` 仍直接往导入的 `directories` 数组里推，临时目录可能不被清理（medium） | 成立，只影响临时目录残留。主会话改为 `trackTempDirectory` |

主会话另外确认：过滤器不匹配任何文件时 `pnpm test <path>` 仍以非零退出（`npm.yml` 的步骤依赖这一点）；单文件过滤照常工作。

## 验证

主会话亲自运行（在子 agent 的 checkout 内，Windows，机器上没有其他任务）：

```bash
pnpm run lint && pnpm run check
# 通过

pnpm test
# Test Files  1 failed | 406 passed | 1 skipped (408)
# Tests  1 failed | 2011 passed | 9 skipped (2021)
# Duration  722.12s (tests 95%, import 3%, transform 1%)

pnpm exec vitest run --sequence.shuffle.files --sequence.seed 20261117
# 同样的计数，Duration 713.51s

pnpm exec vitest run --sequence.shuffle.files --sequence.seed 7
# 同样的计数，Duration 715.73s

pnpm test test/tasks          # 上面那处小修之后
# 14 files / 65 tests passed

pnpm run admin:build && pnpm run admin:test:e2e
# 329 passed (2.7m)

git diff --cached --check && node scripts/file-token-limit.ts
# 无输出
```

三次全量的计数与基线（`8d5e82f8`：2011 通过、9 跳过、1 失败）完全一致。唯一的失败是 `test/recurring-alarms/schedule.test.ts` 的 Windows 路径断言，基线上同样失败，由另一个 PR 修复。

子 agent 自报、主会话未重跑：同一台机器上未改动时的基线 1362 秒；最终配置下另外三遍全量（719 秒、715 秒、乱序种子 424242 下 713 秒），计数同样一致。

未执行：

- 只验证了三个乱序种子（子 agent 一个，主会话两个）。共享模块注册表之后，测试之间通过模块级状态互相影响的可能性比以前大，三个种子都通过不等于任何顺序都通过。
- 没有在 Linux 上跑；CI 的耗时与这里的数字会不同。
- `test/admin/invocation-media-read-window.test.ts` 里有一处已有的隐患没有处理：测试体内启用假定时器，超时的话 `finally` 里的恢复来不及执行。它目前通过，并且被隔离 project 兜住，不会波及别的文件。

## 提交

```txt
cb8b6959 Share the module registry across test files to halve the suite time
```
