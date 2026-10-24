# Surowan - 20261018 锁与停止的复审修正：排空期信号与 PID 文件竞态

## 背景

对 `ff9389f`（见 `agent-doc/devlogs/20261018-serve-lock-and-stop.md`）做代码审查（open-code-review 加人工核对源码），发现一个 High、三个 Medium：

- **二次信号在排空期间失效**：`serve()` 的 `finally` 第一步就是 `stopSignals()`，之后才 `await scheduler?.stop(30_000)`。`shutdown()` → `bot.stop()` → `bot.start()` 返回 → 进入 `finally`，所以 30 秒排空期间根本没有监听器。第二次信号落到 Node 默认动作：裸机上直接被信号杀死，不打 `shutdown_forced`；容器里 node 是 PID 1，内核对没注册处理器的信号不执行默认动作，信号被直接忽略。`test/serve-signals.test.ts` 只测了 `watchStopSignals` 本身，没覆盖它在 `serve()` 里的接线。
- **PID 文件的「检查后删除」竞态**：`release()` 先关互斥连接，再比对内容、unlink。中间继任者可能已拿锁并写好 PID 文件，而容器里两边都写 `1\n`，内容比对挡不住；`stopRunningInstance` 判定锁空闲后的 unlink 分支同样有窗口。活实例失去 PID 文件后，`--takeover` 报 `A serve process holds … but serve.lock is missing`。
- **写 PID 文件失败时连接泄漏**：事务已拿到但 `writeFile` 抛错，调用方拿不到 `ServeLock`，同进程内锁要等 GC 才释放。
- **takeover 强依赖 PID 文件**：持有者在「拿锁后、写 PID 前」的窗口里会让 takeover 直接报错。另外持有者的 `watchStopRequests` 启动时会删掉已存在的 `serve.stop`（当作崩溃残留），正在等待的 takeover 的请求也会被一起删掉，于是白等 60 秒超时。

## 主要变更

### 1. 信号监听保留到收尾结束

`src/adapters/local-monolith/runtime-host.ts:420` 把收尾包进内层 `try`，`stopSignals()` 移到外层 `finally`，在 `lock?.release()` 之后才解除监听：

```ts
} finally {
  // The signal handlers outlive the drain below: ...
  try {
    replayShutdown.abort(new Error('shutdown'));
    stopWatcher?.();
    await admin?.stop();
    await scheduler?.stop(30_000);
    // ...
    store?.close();
    await lock?.release();
  } finally {
    stopSignals();
  }
}
```

面板重启或 takeover 发起的关闭之后，排空期间来的第一次信号进入 `shutdown()`，被 `shuttingDown` 守卫吞掉；第二次信号走强退。这与 `watchStopSignals` 注释里「内部关闭后的信号仍需自己的第一按」一致。

### 2. PID 文件只在持锁期间写入或删除

`ServeLock.release`（`src/adapters/local-monolith/database.ts:74`）改为先删 PID 文件、再关连接放锁。继任者拿到锁之前不可能写 PID 文件，所以不再需要内容比对，`#pidContent` 随之删除：

```ts
async release(): Promise<void> {
  try {
    await unlink(this.#pidPath).catch(/* ENOENT 忽略 */);
  } finally {
    this.#mutex.close();
  }
}
```

`stopRunningInstance` 的两个空闲分支（互斥文件不存在、锁未被持有）不再 unlink PID 文件。崩溃留下的旧文件由下一次 `acquire` 覆写；它本来就不参与存活判断，留着无害。

### 3. acquire 失败时关闭连接

`src/adapters/local-monolith/database.ts:64`：写 PID 文件包进 `try`，失败时先 `mutex.close()` 再抛错。BUSY 报错和 takeover 里读 PID 的逻辑抽成 `readPidFile`（`src/adapters/local-monolith/database.ts:93`）。

### 4. takeover 只看锁，PID 尽力而为

`stopRunningInstance`（`src/adapters/local-monolith/database.ts:142`）的返回值从 `number | null` 改为 `{ readonly pid: number | null } | null`：`null` 表示没有实例，对象表示停掉了实例，`pid` 在持有者从未写出 PID 时为 `null`。等待循环里 `pid ??= await readPidFile(pidPath)`，并在请求文件消失时重新写入：

```ts
pid ??= await readPidFile(pidPath);
// A holder that is still starting drops leftover requests when its
// watcher begins, which can sweep this one away too: publish it again.
if (!(await fileExists(stopPath))) {
  await writeFile(stopPath, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 });
}
```

重写是安全的：除接管方自己外，唯一删请求文件的是 watcher 的启动清扫，接管方返回前的 `finally` 照旧删掉它。`takeover_completed` 日志（`src/adapters/local-monolith/runtime-host.ts:126`）新增 `stopped` 布尔字段，用来区分「没有实例」和「停了、PID 未知」。

`agent-doc/operations.md` 同步了关闭第 8 步的顺序、排空期间二次信号依然有效、takeover 日志字段和残留 PID 文件的处理方式。

### 5. 测试

`test/operations.test.ts` 新增两条用例，旧用例按新契约调整：

- `test/operations.test.ts:156`：持锁但删掉 PID 文件，启动 takeover；500ms 后才启动持有者的 watcher（会把请求清掉），断言仍然停下且返回 `{ pid: null }`。
- `test/operations.test.ts:206`：把 `serve.lock` 预建成目录，令 acquire 报 `EISDIR`；断言随后的 `stopRunningInstance` 看到锁空闲，删掉目录后同进程能重新 acquire。
- PID 1 回归用例改为断言 takeover 不删残留文件、acquire 覆写、release 后删除；正常 takeover 用例断言返回 `{ pid: process.pid }`。

## 验证

```bash
npx vitest run test/operations.test.ts test/serve-signals.test.ts test/admin-recovery.test.ts
# Tests  24 passed (24)

git stash push -- src && npx vitest run test/operations.test.ts; git stash pop
# 旧实现上 4 failed | 4 passed：新增两条（PID 缺失、写失败泄漏）真实复现，另两条为返回值形状变化

pnpm run check          # tsc 严格检查（runtime/cli/admin/docs）通过
pnpm run lint           # lint:fix 修了一处格式后通过
git diff --check        # 通过
npx vitest run
# Test Files  110 passed (110)
# Tests  1394 passed (1394)
```

未覆盖：第 1 节的信号接线没有自动化测试。`serve()` 要连真实 Telegram，配置里也没有可替换的 API 根地址，只靠审读确认；线上可以在排空期间按两次 `Ctrl+C`，确认日志里出现 `shutdown_forced`。复审时提到的「旧版本实例仍在运行时启动新版本会双实例」（旧版本不持有 `serve.lock.sqlite`）不在本次范围，未处理。

## 提交

```txt
264d2db Fix serve lock review findings
```
