---
title: 调试记录配置
description: developer 段的两个记录开关、各自默认值、记录内容、批量清除行为与作用范围。
---

# 调试记录配置

`developer` 段只有两个开关，都用来在排查问题时多记一点东西。两者互不影响，都可以省略，省略即关闭。

```jsonc
{
  "developer": {
    "record_model_payloads": true,
    "record_agent_thinking": true
  }
}
```

## 字段

| 字段 | 默认 | 记录什么 |
| --- | --- | --- |
| `record_model_payloads` | `false` | 每次模型调用的原始请求报文与 HTTP 响应状态。请求报文里的内联图片正文会被替换成摘要，不保存图片字节。 |
| `record_agent_thinking` | `false` | 助手消息的思考文本（CoT），与回复正文分开保存，可以在对话记录与时间线里展开查看。 |

两个开关都只影响**之后的**记录，打开前的调用没有报文可补，关闭后新产生的报文不再保存，已经存下来的也**不会自动删除**。

关闭它们不会丢掉常规审计，Invocation、模型与工具调用、Token 与缓存用量、费用、状态和错误照常记录。

## 生效方式

`developer` 段是热更新，而且两个值在真正用到的那一刻才读：

- `record_model_payloads` 在每次模型调用前读一次。
- `record_agent_thinking` 在每条助手消息落库时读一次。

所以应用配置后的下一个模型调用、下一条助手回复就按新值走，不需要重启，也不会重写已经写下的记录。面板上如果提示「文件设置与运行状态」不同，说明配置还没应用，去「设置」页点「应用配置文件」即可。

## 批量清除

面板「开发者」页的「清除报文」会删掉**已保存的**模型请求与响应快照（`DELETE /api/developer/model-payloads`）：

- 只清 `request_json` / `response_json` 两列，模型调用记录、关联关系、用量与统计都保留。
- 清除按 100 条一批处理，批次之间让出写锁，所以 Bot 不会被长时间卡住，中途失败时已完成的批次不会回滚，可以再点一次。
- 范围以操作开始时最大的调用 ID 为界，清除期间新产生的报文不会再被卷进去。
- 受影响的运行**不能再重放**，因为它们缺了原始报文。
- 开关仍然开着的话，新报文会继续保存。

清除不会执行 `VACUUM`，数据库文件不一定立即变小，释放出来的页会被后续写入复用。

## 作用范围

两个开关是全局的，对所有 Chat、所有宿主（Telegram 与虚拟群聊）、所有模型生效，没有按群开关。会话上下文里也看不到这些报文，它们属于审计数据，只出现在面板的运行详情里。

`record_agent_thinking` 存下的思考文本挂在对应 Invocation 的 Agent transcript 上，随该 Invocation 按 `retention.online_days` 清理（见[数据路径与保留](storage.md)）。

## 示例

只在复现某个诡异问题时临时打开，查完再关：

```jsonc
{
  "developer": {
    "record_model_payloads": true
  }
}
```

这段配置只打开了报文记录，`record_agent_thinking` 保持缺省的关闭。

## 与其他段的关系

- 面板「开发者」页下半部分的「模型参数来源」写的是 `models_dev.api_url`，不在这一段里，见[模型元数据目录](models-dev.md)。
- 报文会明显增加数据库占用，容量与备份的体积影响见[数据路径与保留](storage.md)。
- 重放的使用方式见[Invocation 预检与重放](../developer/replay.md)。

字段类型见[调试记录字段参考](fields-developer.md)。
