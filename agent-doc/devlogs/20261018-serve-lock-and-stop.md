# Surowan - 20261018 锁与停止：容器重建不再需要手删 serve.lock

## 背景

每次用 Docker 更新线上环境后，新容器起不来：`serve` 报 `Another serve process holds ... with PID 1`，必须进数据目录手删 `serve.lock`。定位到根因是锁的陈旧判断本身不可靠：

- `ServeLock.acquire` 用 `process.kill(pid, 0)` 判断锁文件里记录的 PID 是否还活着。容器的 entrypoint 是 `exec gosu ... node`，serve 自己就是 PID 1，锁文件里写的也是 `1`；容器重建后新进程还是 PID 1，这个检查命中的是**自己**，于是永远拒绝启动。
- 就算不在容器里，`kill(pid, 0)` 也只回答「这个 PID 被占用了」，不回答「持锁的是不是当年那个进程」——PID 复用同样会误判。

顺带暴露了第二个问题：裸机 `Ctrl+C` 会等满排空预算（`runtime-host.ts:425` 的 `scheduler?.stop(30_000)`），而 `docker compose down/stop` 的默认宽限只有 10 秒，到点 `SIGKILL`，优雅关闭几乎必然被打断在排空阶段。操作者也没有主动放弃等待的手段（信号处理器是 `once`，第二按没有效果）。

关键约束：双实例防护不能靠任何「身份猜測」（PID、命名空间、主机名都不跨容器可见），只能靠内核在进程死亡时自动释放的东西。

## 主要变更

### 1. 锁本体：进程存活的 SQLite EXCLUSIVE 事务

`ServeLock` 重写（`src/adapters/local-monolith/database.ts:31`）：互斥锁改为 `<data_dir>/serve.lock.sqlite` 上一个**保持到进程结束**的 `BEGIN EXCLUSIVE` 事务。内核在进程死亡（崩溃、`SIGKILL`、容器重建）时自动释放文件锁，不存在「陈旧锁」这个状态，也不再需要任何 PID 存活性判断：

```ts
static async acquire(dataDir: string): Promise<ServeLock> {
  // ...
  const mutex = new Database(mutexPath);
  try {
    mutex.pragma('busy_timeout = 0');
    mutex.exec(`CREATE TABLE IF NOT EXISTS ${MUTEX_TABLE} (id INTEGER PRIMARY KEY)`);
    mutex.exec('BEGIN EXCLUSIVE');
    // `BEGIN EXCLUSIVE` alone can leave the OS lock unclaimed until the
    // connection touches the database; this read claims it before returning.
    mutex.prepare(`SELECT count(*) AS held FROM ${MUTEX_TABLE}`).get();
  } catch (error) {
    mutex.close();
    if (!(error instanceof Database.SqliteError && error.code === 'SQLITE_BUSY')) {
      throw new Error(`Unable to acquire serve lock ${mutexPath}`, { cause: error });
    }
    // ... 读取 serve.lock 里的 PID 拼进报错
  }
  // ...
}
```

实验里踩到的两个 SQLite 细节决定了这个形状（`src/adapters/local-monolith/database.ts:42`）：

- **`BEGIN EXCLUSIVE` 单独挂住不可靠**：SQLite 会把真正的 OS 锁推迟到连接第一次触碰数据库。空库上实测出现过持有者与竞争者同时「拿到锁」；事务内补一次读之后 12/12 轮全部正确拒绝。
- **`BEGIN IMMEDIATE` 不能用**：RESERVED 锁同样惰性获取，不写入就不挡人；而且它放行读者，后续的空闲探测没法用读实现。

表只让文件自描述，从不写行；竞争时建表也可能 `SQLITE_BUSY`，与锁冲突走同一条报错路径。选 SQLite 而不是 flock 的原因：better-sqlite3 已在依赖里，且锁的失败模式与主数据库完全一致——SQLite 锁失效的文件系统上整个 bot 本来就跑不了。代价是持锁期间多一个 8KB 文件和一个 `-journal`（写被回滚，不产生实际数据）。

### 2. `serve.lock` 降级为 PID 说明文件

`serve.lock` 仍然写、仍然被 `--takeover` 和人读，但**不再参与任何存活判断**（`src/adapters/local-monolith/database.ts:16`）。`stopRunningInstance`（`src/adapters/local-monolith/database.ts:129`）改用只读探针问锁本身：

```ts
if (!(await fileExists(mutexPath))) {
  await unlink(pidPath).catch(() => undefined);
  return null;
}
const mutex = new Database(mutexPath);
// ...
if (!mutexHeld(mutex)) {
  await unlink(pidPath).catch(() => undefined);
  return null;
}
```

`mutexHeld`（`src/adapters/local-monolith/database.ts:96`）用 `PRAGMA schema_version` 而不是锁表——互斥文件若在初始化中途被杀（0 字节、无表）也能回答「空闲」，不会抛 `no such table`。互斥锁空闲但残留 PID 文件时，接管方直接清掉残留并返回，不再对着 PID 1 写 `serve.stop` 白等 60 秒。`isProcessAlive` 整个删除。

测试相应重写（`test/operations.test.ts:156`、`test/operations.test.ts:177`）：新增「`serve.lock` 写着 PID 1 也能正常 acquire」的回归用例——这正是线上踩到的场景——和「同进程第二份 acquire 被拒且报错带 PID」的契约用例。

### 3. 停止预算对齐容器宽限，二次信号强退

`docker-compose.yml:33` 增加 `stop_grace_period: 45s`：内部排空预算是 30 秒（`scheduler?.stop(30_000)`）加中止落地、关库的余量，Docker 默认 10 秒会在排空途中 `SIGKILL`，Invocation 只能被下次启动的 `recover()`（`src/orchestration/invocation-queue.ts:115`）记成 `process_restart`/`outcome_unknown`。被 SIGKILL 本身是安全的，损失的是那条回复。

给不想等的人留了出口：第二次 `SIGINT`/`SIGTERM` 立即退出。`watchStopSignals`（`src/adapters/local-monolith/runtime-host.ts:462`）替代原来的两个 `process.once`：

```ts
export function watchStopSignals(shutdown: () => void, forceExit: (signal: NodeJS.Signals) => void): () => void {
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) {
      forceExit(signal);
      return;
    }
    stopping = true;
    shutdown();
  };
  // ...
}
```

`stopping` 只由信号置位，takeover 或面板重启发起的关闭不会被第二次轮询误触发强退。强退侧（`runtime-host.ts:106`）先 `logEvent('shutdown_forced')` 再从 stdout flush 回调里 `process.exit(130/143)`——supervisor 下 stdout 是管道、写入异步，直接退会把这行日志吞掉，所以挂了 250ms 兜底 timer。强退留下的状态与 SIGKILL 相同：互斥锁内核释放，Invocation 由 `recover()` 收尾。

## 验证

```bash
npx vitest run
# Tests  1392 passed (1392)（含新增 serve-signals.test.ts 两用例、operations.test.ts 重写的锁用例）

pnpm run check          # tsc 严格检查（runtime/admin/docs）通过
biome lint . && biome format .   # 492 files, no issues
pnpm run docs:build && pnpm run docs:verify
# Verified 23 HTML/Markdown pages, search, examples, schema, provenance and 83 HTTP resources (base /)
```

跨进程锁语义用临时脚本（跑完已删）验证过真实多进程场景：12 轮「子进程持锁 → 另一进程抢锁」全部正确拒绝；10 组并发冷启动 10/10 恰好一个持锁；持锁进程 `SIGKILL` 后新实例直接拿到锁；`serve.lock` 预写 PID 1 时 `acquire` 成功并覆写。强退路径由 `test/serve-signals.test.ts` 用真实子进程信号覆盖（Windows 跳过，无 SIGINT 语义）。

未运行真实 Docker 的 `docker compose down/up`：本机没有 docker 可执行文件。`stop_grace_period` 的行为按 Compose 规范推断（SIGTERM → 等宽限期 → SIGKILL），线上更新时对照 `shutdown_requested` 到进程退出的间隔确认即可。另外 `docs:verify` 首跑失败过一次：先改了根目录 compose 再跑校验，`examples/docker-compose.yml` 的 provenance 副本还是旧的，重跑 `docs:build` 后通过——不是产品代码问题。

## 提交

```txt
ff9389f Fix serve lock staleness and stop behavior in containers
```
