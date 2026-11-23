---
title: Documentation
description: "Pick the task you are here for: a first deployment, models and personas, Telegram, or the configuration and API references."
---

# Documentation

The docs come in three parts. Pick by the question you have:

| Part | When to read it | Start at |
| --- | --- | --- |
| **Guides** | You want to finish something: deploy, write a persona, connect Telegram, tune it, fix it | [Guides](guides/index.md) |
| **Configuration reference** | You want to edit `config.jsonc` by hand, or look up what a field means, defaults to and how it takes effect | [Configuration file basics](configuration/index.md) |
| **Developer reference** | You are writing a script or tool against the HTTP API, the MCP server or the two CLIs | [Developer reference](developer/index.md) |

## Common tasks

**Starting from a fresh machine**

1. [Install and sign in](guides/installation.md): bring Docker up, configure an HTTPS reverse proxy, sign in with a one-time code, connect a working model (or hand the whole VPS setup to your coding agent over SSH in [Deploy with an AI agent](guides/ai-deploy.md)).
2. [Your first persona](guides/first-persona.md): write the persona, try it in the Playground.
3. [Your first bot](guides/first-bot.md): create the Telegram bot, allow one chat, have the first real exchange.

**Already running**

- Install the CLI and skills and tune with your coding agent: [Working with coding agents](guides/agent-assisted.md)

- Switch models or adjust thinking effort: [Connect and switch models](guides/models.md)
- Too chatty, too slow, too expensive: [Tune behaviour and cost](guides/tuning.md)
- Different rules per chat: [Set boundaries per chat and topic](guides/chats.md)
- Try features without Telegram: [Try personas and tools in the Playground](guides/playground.md)
- Forgotten password, remote access, secrets: [Admin Panel, secrets and access](guides/admin.md)
- Upgrade, back up, restore: [Upgrade, back up and restore](guides/maintenance.md)

**Something is wrong**

- It will not start, the panel will not open, the bot stays silent: [Troubleshoot startup failures and silence](guides/troubleshooting.md)

## About this site

This site holds public documentation and safe examples only. Every token, API key and chat ID in an example is a placeholder; the running bot, chat history, audit data and admin API are not here. The commit these pages were built from is shown at the top of each page — check it against the version you actually run.
