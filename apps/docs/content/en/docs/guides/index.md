---
title: Start here
description: Who Surowan is for, the order to do things in the first time, and where to continue once it runs.
---

# Start here

Surowan Harness is a persona-agnostic harness server. One deployment connects one Telegram bot, collects the messages of a short window into a batch, and hands that batch plus the conversation context to the model you chose; the model decides whether the batch deserves a reply. Who the bot is, how it speaks and where it takes part all live in the persona prompt and the configuration — the product itself ships no character.

## Who it is for

- People who want a Telegram bot on their own machine, with their own model API key and their own bill.
- People who want to write the persona themselves and tune behaviour per chat, rather than pick a character card.
- People willing to read a configuration file and glance at audit data or logs. Most day-to-day work happens in the Admin Panel, but the first deployment needs one shell session.

Telegram is the only real platform for now. Without it, the Admin Panel and the built-in Playground still work.

## Three paths

| Your situation | Start at |
| --- | --- |
| Not deployed yet | [Install and sign in](installation.md) |
| Running, and you want different behaviour or boundaries | [Connect and switch models](models.md), [Tune behaviour and cost](tuning.md), [Set boundaries per chat and topic](chats.md) |
| It will not start, the panel will not open, the bot stays silent | [Troubleshoot startup failures and silence](troubleshooting.md) |

## The order for the first time

1. Install it and sign in to the panel: [Install and sign in](installation.md).
2. Connect an Agent model that actually replies: [Connect and switch models](models.md).
3. Write a persona, and try it in the Playground first: [Your first persona](first-persona.md).
4. Connect Telegram and check it in a real chat: [Your first bot](first-bot.md).

The first two are not optional: without a working Agent model, the bot will not start a run even when messages arrive.

:::tip Rather go straight to Telegram?
Once the model works, you can skip the Playground and follow [Your first bot](first-bot.md). Trying it in a room first only separates the failure modes: a room has no group permissions, message visibility or allowlist in the way.
:::

## The few concepts you need

| Concept | In one sentence |
| --- | --- |
| Instance | One deployment: the process, the configuration file and the data directory. An instance connects exactly one Telegram bot. |
| Bot | The Telegram account you talk to. You may leave the token out at first; then only the Admin Panel and the Playground run. |
| Persona | The global persona file plus each chat's extra instructions. It defines identity and tone and grants no permissions. |
| Providers and models | A provider is a connection plus its secret; a model is an explicitly enabled entry. Three roles exist: Agent, Vision and Tool model. |
| Secrets | Named entries in `key.json` (the Keychain). The configuration only refers to them, as `{ "jar": "name" }`. |
| Chat and topic | The scope the bot may act in. Topics share the chat's model, memory and participation settings but keep separate conversation context. |
| Invocation | One run that hands a message batch and the current context to the model. The model may speak, or deliberately stay silent. |
| Context and memory | Conversation context, Memo entries, group memory and the dictionary are four different things; do not treat them as one. |
| Alarms and recurring alarms | A one-off alarm is created by the bot during a conversation; a recurring alarm is a schedule you define in the panel. |
| Entry gate | An optional small-model pre-check that decides whether a batch deserves the main model at all, and can drop it. |

## Where to go next

- The panel pages you will use every day: [Admin Panel, secrets and access](admin.md)
- Try personas and tools without Telegram: [Try personas and tools in the Playground](playground.md)
- Prefer fields over clicks: start at [Configuration file basics](../configuration/index.md)
