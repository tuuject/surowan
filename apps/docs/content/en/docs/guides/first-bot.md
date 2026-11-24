---
title: Your first bot
description: Bring the persona you tested to Telegram — create the bot, store its token, make it see group messages, allow one chat, and have the first real exchange.
---

# Your first bot

This page connects the persona you tested to the real platform. Telegram is currently the only real platform.

**Prerequisite**: the panel signs in, the Agent model replies, and the persona is saved. You do not have to have used the Playground, but the model has to work — see [Connect and switch models](models.md).

## 1. Create the bot with BotFather

1. Open [@BotFather](https://t.me/BotFather) in Telegram and send `/newbot`.
2. Give it a display name, then a username ending in `bot`, for example `my_surowan_bot`.
3. Keep the token it returns, shaped like `123456:ABC-DEF…`.

That token is the whole authority of this bot. Never paste it into a chat, a screenshot, an issue, or a "deploy this for me" bot. The panel field below is the only place it belongs.

## 2. Store the token in the panel

Open **Telegram**:

![The Telegram page before a token is configured](__DOCS_BASE__/screenshots/first-bot/telegram-token-empty.en.light.png)

1. In the **Bot Token** card, paste the token into **New Bot Token**.
2. **Entry name** defaults to `telegram`; you may change it. The token goes into the Keychain, and `config.jsonc` only names the entry, never the value.
3. Choose **Save token**. It applies immediately; no restart.

Once saved, the **Connection** card shows **Status: Connected**, the bot's `@username` and numeric ID, and `Since` for when the connection was made. If the status is **Config error** with "Token rejected", the token was copied wrong or revoked; "This token is used by another process" means a second instance is polling the same bot — stop that one first.

![The connection status after the token takes effect](__DOCS_BASE__/screenshots/first-bot/telegram-connected.en.light.png)

The first save creates the whole `telegram` section in the configuration file, with the default batch timing: a 15-second minimum wait, no extension per message, and a maximum equal to the minimum.

## 3. Let it see group messages

A bot always receives private messages. In groups, Telegram's own privacy mode decides: **by default a bot only receives messages addressed to it** — commands, mentions and replies. Ordinary conversation never reaches it.

To let it see ordinary messages, do one of these:

- Run `/setprivacy` for this bot in BotFather and choose **Disable**;
- or make the bot an administrator of that group.

Both are Telegram's delivery rules, unrelated to Surowan's configuration. Afterwards, verify with a message from a normal member account. Note that even a delivered message is only processed when its chat is allowed in `telegram.chats` — that is the next step.

## 4. Allow one chat

Two methods, same effect: the chat is written into `telegram.chats` and applied immediately. The fields that entry accepts are in the [`telegram` field reference](../configuration/fields-telegram.md).

**Let the bot add it.** First add your numeric Telegram user ID under **Bot admins** (same Telegram group in the panel), then send this in the target group from your own account:

```text
/allowlist
```

It adds the current chat to the allowlist right away, so no chat ID is needed. `/allowlist` is the only command that runs in a chat the allowlist does not name yet, and only a Bot admin can use it.

Don't know your numeric user ID yet? Surowan cannot show it before any chat is allowed (`/whoami` only works where the bot answers), so message any Telegram ID lookup bot (such as @userinfobot) once to get it.

**Or type it in the panel.**

1. Open **Chats** (the page title is **Chat allowlist**) and choose **Add Chat**.
2. Enter the **Telegram chat ID**: groups are negative, private chats positive, never 0.
3. To restrict forum topics, list the allowed ones under **Topic IDs**; leave it empty to allow every topic.
4. Save.

Telegram clients do not show chat IDs: a private chat's ID is the numeric user ID of the person you are chatting with, which `/whoami` reports in any chat the bot answers in; for a group, `/allowlist` above is the easy way. Once a chat is on the allowlist, its ID is also shown under its name on the **Chats** page, so you can check it there.

![The Chats page with two allowed chats](__DOCS_BASE__/screenshots/first-bot/chat-allowlist.en.light.png)

## 5. Check with `/help`

In the chat you just allowed, send:

```text
/help
```

The bot lists the commands you can use there, one per line, based on your permissions in that chat. Commands are answered by Surowan itself: they never reach the model and never become chat history. In a chat that is not on the allowlist, `/help` gets no reply at all — if nothing comes back, go back to step 4.

## 6. The first real exchange

1. Post an ordinary message worth answering in the group, such as a concrete question.
2. Wait a moment: the bot does not answer message by message. It collects a window of messages into one batch. The default minimum wait is 15 seconds; change it under **Telegram → Message batches**, and it applies from the next batch.
3. Watch what happens. The model may answer, or deliberately stay silent — silence is a normal outcome, not a fault.

To see what actually happened, open **Tool sessions**: one invocation lists its tool calls, model calls and send results. That is how you tell "never triggered" from "triggered but the model chose not to speak" and from "it spoke but the send failed".

## 7. Works in the Playground, silent in the real group?

Check in this order; most problems sit in the first two steps:

1. **Is the chat allowed?** Does it have a row on **Chats**?
2. **Did the bot receive the message?** Is group privacy mode still on, and is the bot an administrator?
3. **Was it triggered?** Active hours, `/ask`-only and the ignore list all drop ordinary messages.
4. **Is the model working?** Check the Agent model on **Models**, and **Test** it on **Providers**.

The full evidence trail is in [Troubleshoot startup failures and silence](troubleshooting.md); per-chat rules are in [Set boundaries per chat and topic](chats.md).

## Next

- Talk less, spend less: [Tune behaviour and cost](tuning.md)
- Different rules per chat: [Set boundaries per chat and topic](chats.md)
- Change the model or thinking effort: [Connect and switch models](models.md)
