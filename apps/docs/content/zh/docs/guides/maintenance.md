---
title: 升级、备份与恢复
description: 升级版本、迁移密钥与数据、理解保留清理，并按检查清单完成备份与停机恢复。
---

# 升级、备份与恢复

升级、备份与恢复是三件不同的事：升级会改动代码、配置格式与数据库结构；备份决定你能不能回到升级前的状态；恢复必须在一个与生产隔离的环境里验证过才算数。

一条贯穿全文的规则：**同一个数据目录只能有一个 `serve` 进程**。`check-config`、`doctor`、`backup` 这类一次性命令不启动 `serve`，可以和运行中的容器共存；但绝不要用 `docker compose run` 再起一个 `serve`。

## 升级

### 先记录

在动手之前记录三样东西：当前镜像标签（或源码 commit）、配置哈希（`check-config` 输出的 `config_hash`）、数据目录里 `surowan.sqlite` 的位置。数据库迁移、配置格式变化与镜像变更是不同步骤，迁移成功也不表示可以安全降级。

### 镜像标签

CI 在推送 `main` 分支与 `v*` tag 时自动发布镜像到 `ghcr.io/tuuject/surowan`：

| 标签 | 什么时候更新 |
| --- | --- |
| `latest` | 推送 `v*` 稳定版本 tag 时；同时发布 `<version>`（如 `1.2.3`）与 `<major>.<minor>`（如 `1.2`） |
| `<version>` / `<major>.<minor>` | 同上。固定具体版本可获得可复现部署 |
| `main` | 每次推送 `main` 分支，滚动开发版 |
| `0.0.0-next-<timestamp>` | 每次推送 `main` 时固定某次构建，并创建 GitHub pre-release；只保留最近 20 个 |

`latest` 只跟随 `v*` 稳定 tag，不跟随 `main`。正式版本对应 GitHub Releases 中的非 pre-release 条目。

### 步骤

1. 先做一次备份（见下文），并确认配置、Prompt 与 `key.json` 有自己的备份策略——它们不在数据库里。
2. 拉取目标镜像：

   ```bash
   docker compose pull
   ```

   自己构建的用户改为 `docker build -t surowan:local .` 并让 compose 指向该镜像，其余步骤相同。

3. 用目标版本校验现有配置：

   ```bash
   docker compose run --rm plasticwan check-config --config /config/config.jsonc
   ```

4. 替换正在运行的服务：`docker compose up -d`。替换时旧容器要先收尾进行中的运行，别把 `stop_grace_period` 压到 30 秒以下。
5. 跟踪日志，确认这三件事都发生了：数据库迁移完成、`startup_catch_up_completed`（补偿拉取结束）、`serve_started`。记下新的 `config_hash`。
6. 在一个允许的 Chat 里发一条受控测试消息，在 **运行记录（Tool sessions）** 里确认这次运行的状态与发送结果。

### 自动迁移

升级时有三类东西会自己变，不需要你手工跑迁移脚本：

- **数据库结构**：`serve` 启动时按 `schema_migrations` 应用待执行的迁移。数据库文件已存在且有迁移要跑时，会先在 `paths.backups` 里写一份 `pre-migration-<时间>-<uuid>.sqlite` 副本，再应用；这些副本按 `retention.backup_copies` 轮换，但只在这些副本之间轮换，不会删掉普通的 `surowan-*.sqlite` 备份或它们的 `.images` 快照。`check-config` 与 `backup` 不跑迁移。
- **Keychain 格式**：旧版 `key.json` 是单层 `{ "名字": "值" }`，新版是 `{ "version": 1, "entries": { … } }`。`serve`、`doctor` 与 `configure` 会就地、幂等地把它转成新格式，每个条目保留名字并补上 `created_at`。已经迁移过的文件不会再动。如果某个命令提示「key jar 仍是旧格式」，跑一次 `serve` 或 `configure` 即可。
- **配置默认值**：缺省值与继承关系随版本演进，运行时的实际值以当前版本为准。不要从示例反推默认值。

### 需要手工清理的废弃字段

以下字段仍然能被 Schema 接受、配置仍然能加载，但**完全不生效**：

| 字段 | 替代 |
| --- | --- |
| `agent.memory_ttl_warning_days` | 无（直接删除） |
| `agent.send_empty_text_fallback_enabled` | 想要旧行为就把 `agent.send_empty_text_strategy` 设为 `"random_text"` |
| `vision.background_sticker_concurrency` | 无（直接删除） |
| `mcp.servers[].required` | 无（直接删除；启动不再等待或依赖 MCP） |

它们出现时，`check-config` 的 `warnings`、`serve` 启动日志的 `config_warnings` 事件与**警告（Warnings）** 页都会列出字段路径，提示删除。建议照做：留着不会报错，但会一直挂着一条常态警告。

### 配置格式变化

很久以前的配置可能缺 `admin` 段：管理面板现在是必填项，`check-config` 会直接报错。补上 `host`、`port` 与 `session_ttl_hours` 即可，`enabled` 可以省略（默认 `true`）。`telegram` 则相反，已从必填改为可选：整段删掉后服务仍然启动，只是不连 Bot。

### 回滚

回滚镜像本身是安全的：把 compose 的 `image:` 指回上一个标签（或仍在最近 20 个之内的 `0.0.0-next-*`）后 `docker compose up -d`。

但**数据库迁移不可自动降级**。迁移过的 SQLite 要用升级前的备份恢复，这正是升级前先备份的原因。版本不匹配时先在隔离环境演练，不要在唯一副本上试。

## 保留清理

`serve` 在启动时执行一次保留清理（在 Scheduler 启动之前，这样升级后的第一次运行不会被积压的历史数据抢跑），之后**每 24 小时**再执行一次。每一轮都读当前已发布的配置，所以 `retention.online_days` 的修改**热应用**，下一轮就按新窗口清理，不需要重启。

清理窗口是 `retention.online_days`（项目按 30 天设计，代码里没有默认值）。清理的对象：

- 已经结束、且早于窗口的**运行记录（Invocation）**、它们的工具调用与发送记录。
- 已经结束、早于窗口的**消息批次（Bucket）**。
- 过期的一次性记账（`daily_usage`）、已结束的群聊记忆整理批次记录、已处理完的长时间任务与循环闹钟触发记录。
- 过期的 **Memo Pad 短期条目**、过期的上下文引用与会话注意力窗口。
- 过期的图片分析缓存，以及不再被引用的发送者行。
- 已用掉或已作废、早于窗口的一次性登录码与已过期的配对 nonce。

**不清理**的对象（这是有意设计）：

- 聊天消息、消息修订、Media 与**Conversation Context**：它们只随 Chat 删除或显式截断消失。
- 群聊记忆的事件摘要。
- 原始 Update。
- 管理员账号、Passkey、API key 与已配对的客户端身份：它们只在显式撤销时删除。

所以磁盘占用会随聊天量增长，`online_days` 并不是「聊天记录保留天数」。`backup` 在创建 SQLite 备份前会执行同一个清理。

## 备份

`backup` 做四件事：执行保留清理、用 `VACUUM INTO` 生成一致的 SQLite 快照、把图片目录一起快照、按 `retention.backup_copies` 轮换旧备份。

```bash
docker compose run --rm plasticwan backup --config /config/config.jsonc
```

宿主机运行：

```bash
node src/cli.ts backup --config /path/to/config.jsonc
```

产物是 `paths.backups` 下的 `surowan-<时间>-<uuid>.sqlite`，以及配套的 `surowan-<时间>-<uuid>.images/` 目录：

- `.images/` 是 `<data_dir>/images` 的完整拷贝，包含生图原图与 Memo Blob。目录不存在时跳过；拷贝失败只记日志，不影响 SQLite 备份的有效性。
- 两个快照之间**没有跨库原子性**：恢复后个别最新记录可能引用尚未拷入的图片文件。
- 图片目录可能很大，确认 `paths.backups` 所在磁盘放得下。

`backup` **不包含**这些内容，必须另外备份并妥善保护：

- `config.jsonc`
- Prompt 文件（`system_prompt_file`、每群 `instructions_file`）
- `key.json`（Keychain）
- 通过环境变量提供的外部凭据

镜像不自带定时备份。需要时用宿主机 cron 每天跑一次。

「命令成功」只说明备份已生成，不代表恢复路径已被验证。

## 恢复

恢复没有专门的命令：把备份文件放回原位，让 `serve` 打开它。

### 检查清单

1. **停止**正在使用目标数据目录的服务。两个进程写同一个 SQLite 会出问题。
2. 保留原始目录的只读副本；不要直接覆盖唯一副本。
3. 准备一个**新建且为空**的隔离目录，复制 `config/` 与 Prompt 文件进去，然后编辑这份配置：
   - `data_dir`、`paths.database`、`paths.media_cache`、`paths.backups` 全部指向隔离目录内。
   - Prompt 的相对路径以配置目录为基准，所以放在新配置旁边即可。
   - 密钥仍通过安全环境或 `key.json` 提供，绝不放进工单或公开存储。
4. 把候选备份复制为新的 `paths.database`，把配套的 `.images/` 目录复制为新 `data_dir` 下的 `images/`。
   **不要**复制旧目录里的 `-wal`、`-shm` 或锁文件。
5. 启动前先做离线完整性检查（安装 SQLite CLI 时）：

   ```bash
   sqlite3 -readonly /restore/data/restored.sqlite 'PRAGMA integrity_check;'
   ```

   应返回 `ok`。任何错误都先保留证据，不要启动服务。
6. 用这份配置跑 `check-config`，并人工核对全部路径。

   ```bash
   node src/cli.ts check-config --config /restore/config/config.jsonc
   ```

   校验成功**不证明**数据目录隔离或备份完整。
7. 只有得到许可后才启动隔离服务，验证审计与一条受控消息。**同一个 Telegram Token 只能有一个轮询实例**；数据目录不同也不能与原 Bot 同时轮询。

Docker 演练要另建 Compose 项目（不同的 `-p` 与端口），把配置与数据卷绑定到**新的宿主机目录**。不要复用生产 Compose 的 `./data`，也不要因为改了配置副本就以为卷已经隔离。

### 恢复后检查隔离

- 日志里不应出现任何生产路径。
- **概览（Overview）** 的用量与运行记录数量应与备份时点相符，而不是继续增长。
- 用**记忆（Memories）** 与**群聊记忆（Group memory）** 抽查几条记录，确认 `.images/` 里的图片能打开。
- 确认原生产实例仍然停机，或已切换到别的数据目录。

## 常见问题

- **升级后一直报配置错误？** 先看 `check-config` 的 `warnings`：废弃字段与缺失的必填段都会在这里出现。
- **设置页显示已启用，但某个功能仍不可用？** 看启动日志里的 `*_warning` 事件（例如 `image_service_warning`），修好后在 **设置（Settings）** 应用配置。
- **备份文件比数据库小很多？** 正常：`VACUUM INTO` 会压掉空闲页与 WAL。
- **能不能只回滚镜像？** 可以，但数据库迁移不回退；需要回到升级前状态就用升级前的备份。

相关页面：[数据路径与保留](../configuration/storage.md)、[配置生命周期](../configuration/lifecycle.md)、[密钥与路径](../configuration/secrets.md)、[管理面板、密钥与访问安全](admin.md)、[排查启动失败和不回复](troubleshooting.md)
