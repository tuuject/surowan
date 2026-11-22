---
title: Telegram commands
description: How the bot recognises commands, who may use them, their arguments, chat and topic scope, and the replies on success and failure.
---

# Telegram commands

The bot ships a set of control commands. Their replies are **deterministic**: they bypass the `send` tool, never reach the model and are not stored as chat messages. Each reply is a direct reply to the command message in the same forum topic, and a failure only writes a log line.

The reply strings in the source are Chinese-only — this page quotes them verbatim and explains them in English.

## How a command is recognised

- Only a Telegram command entity at the **start of the message text**: `/pause`, `/Pause` and `/pause@ThisBot` all work; the username after `@` must be this bot, and another bot's name makes the message irrelevant.
- A command in a caption does not count, and an edited message never runs a command (`/ask` included: an `/ask` edited into a message later does not trigger).
- Commands from other bot accounts do not count.
- Trailing text is parsed as an argument only by `/model` and `/effort`; every other command ignores it.
- Commands only run in a chat the allowlist already accepts — `/allowlist` is the single exception.

The commands are also registered as the Telegram command menu, in the same order `/help` uses.

## Who may use them

| Tier | Who | Commands |
| --- | --- | --- |
| Admin | Telegram user IDs in `telegram.admins`, read from the live configuration so a list change applies at once | `/pause`, `/resume`, `/model`, `/effort`, `/cut_topic`, `/rebuild_context`, `/allowlist` |
| Member | A sender the bot can identify as a personal account | `/whoami`, `/ignoreme`, `/unignoreme` |
| Anyone | Any sender that can reach the bot | `/ask`, `/help`, `/status` |

An anonymous administrator (`sender_chat`) or a channel identity is nobody to the permission check: it gets no admin command, `/whoami` answers `无法识别发送者。` and `/ignoreme` asks for a personal account. `/ask` is the one exception that accepts anonymous administrators and channel identities.

Admin status is decided by sender ID, not by being a group owner or a Telegram administrator. A non-admin sending an admin command only gets `该命令仅对本 Bot 的管理员可用。`

## /help

```text
/ask — 显式唤起 Bot 回答这条消息
/help — 查看你可以使用的命令
/status — 查看当前模型、thinking effort 与本日 token 用量
/whoami — 查看你的 Telegram 数字 ID
/ignoreme — 让 Bot 忽略你在本 Chat 的消息
/unignoreme — 恢复 Bot 接收你在本 Chat 的消息
```

- Only the commands the sender can actually use in this chat are listed, in menu order. An admin gets an extra block: a blank line, the `管理员命令：` heading, then all seven admin commands (no repeated "admin only" marker there).
- Without an identifiable personal account, `/whoami`, `/ignoreme` and `/unignoreme` are omitted.
- A member listed in the chat's `ignored_user_ids` still gets `/help`, but it lists only `/ask`, `/help`, `/ignoreme` and `/unignoreme`, ending with `你已让 Bot 忽略你在本 Chat 的消息，发送 /unignoreme 可恢复。`

Both the permission and the ignore state are read live, so `/help` right after `/ignoreme` already reflects the change.

## /ask

An explicit request for the bot to answer this message. The message is **ordinary input**: its text (including the `/ask` prefix) is stored as is, enters the context, and the model may still choose to stay silent.

- `/ASK` and `/ask@ThisBot` work. Only the start of the text counts; captions and edits do not.
- With `ask_only` enabled, only `/ask` may open or join a batch. That batch has a 0-second window, contains only this message, leaves no attention window behind, and does not adopt pending bot messages. Without `ask_only`, `/ask` uses the normal collection window like a direct mention, and outside active hours it opens or refreshes the attention window.
- Private chats ignore `ask_only` and the participation gate; pause and sleep still apply.
- A member who used `/ignoreme` can still send `/ask`: that one message is stored and triggers. Continuing the conversation needs another `/ask`, or `/unignoreme` first.
- Anonymous administrators and channel identities work; other bots do not.

The full participation semantics are in [Set boundaries per chat and topic](../guides/chats.md) and [Telegram settings](../configuration/telegram.md).

## Command details

### /status

Lists the chat's model (its nickname when it has one), the thinking level and whether either is inherited, the chat's token usage for the day, global usage against the daily budget as a percentage, and the read/write/cache-read/cache-write split. It then adds whatever applies: `互动: 已暂停`, `参与模式：仅 /ask 唤起`, `互动: 活跃时段内` or `互动: 注意力窗口至 …`. Finally it prints one context line per topic (message count, retained sends, `head_seq`, last GC time or `未 GC`).

With no context at all it says `Context: 尚未建立`. While paused it still lists contexts but stops computing participation.

### /model

```text
/model            → list the available text models (20 per page, nickname or provider / model)
/model 3          → set this chat's model override to entry 3
/model page 2     → turn the page
/model default    → clear the override and follow the global model
```

- Only registered models that accept text input are listed. A model with a `nickname` shows only the nickname, so the provider and model id never leak.
- Switching writes `telegram.chats[<id>].provider` and `.model`, applies at once, and resets the thinking level to the weakest level the new model supports.
- Once applied, this chat's invocations still running on the replaced model are **stopped without asking**: the messages they were answering get no reply, and the receipt says how many runs were stopped. The command is the admin's decision, so there is no second confirmation.
- The receipt also lists other configuration changes that came in with the same apply, and how many items still need a restart.

### /effort

```text
/effort           → current level, the levels this model accepts, and how to change either
/effort high      → write this chat's thinking_level override
/effort default   → remove the override and inherit the global level again
```

- The level is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` and must be one the **registered** model accepts; a non-reasoning model only accepts `off`.
- Only `telegram.chats[<id>].thinking_level` is written; the chat's model override is untouched. The change takes effect on the **next agent session**; a running session keeps the old value.
- `default` does not need a working model, which is what makes it usable when an incomplete model entry is exactly why the override is stuck.

### /allowlist

Appends the current chat to `telegram.chats` and hot-applies it:

- Already allowed: `本群已在白名单中。`
- Success: `已将本群加入白名单，配置已立即生效。`, plus a line with the number of items that still need a restart if the same apply carried any.
- File written but apply failed: `已写入 config.jsonc，但应用失败: …`, and the running process keeps the old configuration.

This is the **only** command usable in a chat the allowlist does not name, and it is admin-only: a non-admin `/allowlist` is dropped silently with no reply at all. If runtime configuration apply is not wired, the reply is `运行时配置应用不可用。`

### /ignoreme and /unignoreme

Adds or removes the sender's own Telegram user ID in the chat's `ignored_user_ids` and hot-applies it:

- Once applied, later ordinary messages, edits, mentions and replies no longer reach the model; `/ask`, `/help`, `/ignoreme` and `/unignoreme` remain reachable.
- It applies to every forum topic of that chat and to no other chat, and is written back to `config.jsonc`, so it survives a restart.
- Repeating the command does not add the ID twice.
- The receipt also reports other configuration changes applied in the same go, and pending restarts.

Existing messages and contexts are not deleted retroactively, and the update audit is untouched.

### /pause and /resume

`/pause` stops interaction in the chat. It expires every batch of the chat that is still collecting or queued (including running invocations' batches not yet injected), cancels queued task receipts, marks queued invocations aborted, and aborts the one already running (the messages it was answering get no reply). The reply is `已暂停本群互动，发送 /resume 可恢复。`

`/resume` deletes the pause record and replies `已恢复本群互动。` Messages received while paused were still stored, so they become visible history after resuming.

### /cut_topic

```text
/cut_topic
已切掉此消息及更早的历史，并清空该话题的连续 Context。
```

The scope is the **conversation (forum topic) the command was sent in**; the chat's other topics keep their history, and the command message itself is inside the cut. The same command also:

- Writes a history cutoff that only moves forward, so a late or redelivered older command cannot bring history back.
- Aborts the conversation's running invocation before clearing the continuous context. Otherwise the run would keep answering from the history just cut and could write a lower `head_seq` back over the cut.
- Drops the in-memory transcript.

A topic that has never stored anything still gets the success reply, because it has no history to cut.

### /rebuild_context

```text
/rebuild_context
已终止当前 Invocation 并丢弃连续 Context；下一条消息会基于最近的聊天记录重新构建。
```

This discards only the **current topic's** continuous context: it does not move the history cutoff and does not delete chat messages, which makes it the right command after lowering a model's context window. It aborts the topic's running invocation first and then bumps the context generation, so that run's late writes are refused.

A chat with nothing stored answers `当前 Chat 尚未入库，无需重建连续 Context。`; a topic without a context answers `当前话题还没有连续 Context，无需重建。`

### /whoami

Replies with the sender's numeric Telegram ID, ready to paste into `telegram.admins`. Without an identifiable personal account it replies `无法识别发送者。`

## Backlog at startup

On startup the service first drains the Telegram updates that accumulated while it was down. Among them:

- `/pause` and `/resume` are **replayed** in update order, still passing the same admin, chat/topic and sender checks. Their state is the only thing that has to survive downtime.
- Every other recognised command (`/allowlist`, `/model`, `/effort`, `/cut_topic`, `/rebuild_context`, `/help`, `/ignoreme`, `/unignoreme`) is audited and then dropped: the effect is not replayed, and the message is not handed to the model as chat content. Send it again after startup.
- The backlog sends no command replies, so a replayed `/pause` looks silent.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| No reaction to any command | The chat is not on the allowlist (`/allowlist` excepted), or the topic is not in `topic_ids` |
| `该命令仅对本 Bot 的管理员可用。` | The sender ID is not in `telegram.admins`, or an anonymous/channel identity was used |
| `无法识别发送者。` | Anonymous administrator or channel identity; use a personal account |
| `已写入 config.jsonc，但应用失败: …` | The running process kept the old configuration; fix the file and resend, or apply it in the panel |
| Nothing at all after `/ignoreme`, not even `/help` | Only `/ask`, `/help`, `/ignoreme` and `/unignoreme` pass, and only from live new messages |

For the full "the bot is online but silent" triage, see [Troubleshoot startup failures and silence](../guides/troubleshooting.md).
