---
title: Your first persona
description: Write a short persona, try a few scenes in the Playground, spot what is off and revise it — without touching Telegram.
---

# Your first persona

This page is about designing the bot's behaviour: who it is, how it speaks and when it takes part, tried out somewhere no real chat is disturbed.

**Prerequisite**: you can sign in to the panel, and the **Models** page already has an Agent model that replies. If not, read [Install and sign in](installation.md) and [Connect and switch models](models.md) first.

## 1. Decide three things

A persona is not a résumé. Three short parts are enough:

| Part | The question it answers | Example |
| --- | --- | --- |
| Identity and relationship | What it is and how it relates to the people in the chat | "You are a long-time member of this group, not a support agent." |
| Behaviour | When to speak, when to stay out, what to do when unsure | "Speak up for technical questions; say you are unsure instead of guessing." |
| Voice | Sentence length, verbal tics, things it never says | "Short, spoken sentences; no exclamation-mark enthusiasm." |

The built-in prompt sets no reply threshold and does not average out your tone: if you want it to talk less and answer only when asked, write that down.

## 2. Put it in the panel

1. Open **Prompts**. Pick **Global prompt** in the left rail — it applies to every chat.
2. Write the text in the **Prompt** editor. Markdown works; HTML comments in the file never reach the model.
3. **Note** (optional) records why you changed it, up to 200 characters, and is stored with the version.
4. Choose **Save and apply**.

The change takes effect from the **next run**; runs already in flight keep the version they started with. **Version history** records every save (source: panel, external, rollback), lets you compare any two versions and restore an old one — restoring never deletes history.

<!-- screenshot: first-persona/prompt-editor | The Prompts page with a saved global persona, its version and source visible -->

A persona may use a few template variables: `{{ agent.nickname }}` (how the current Agent model is shown in Telegram commands), `{{ agent.provider }}`, `{{ agent.model }}`, `{{ vision.provider }}`, `{{ vision.model }}` and `{{ timezone }}`. An unknown variable name is rejected when you save.

## 3. A draft to start from

```markdown
You are a regular member of this group, not a support agent.

- Speak up when someone asks a technical question or when you can add something real; stay out of pure banter.
- When you are unsure, say so. Never invent experiences, links or progress.
- Short spoken sentences. No bullet lists, no exclamation marks, no "as an AI".
- The group's own conventions outrank your guesses. Accept a correction before adding to it.
```

Keep it this short on purpose: get the behaviour right first, then add detail. Three hundred lines at once usually leaves the model with two contradictory rules it happens to obey.

## 4. Try a few scenes in the Playground

No Telegram needed. Open **Playground**:

1. Choose **New room**, give it a name and a few **initial identities** (comma separated, e.g. "Lin, Aran"). A new room holds messages by default and has image generation off.
2. Pick a sender in **Sending as** below the timeline, write something a real person would write, and choose **Send**.
3. Send a few messages in the same scene, then choose **Release N** to hand that batch to the model.

Three kinds of scene are worth rehearsing:

- **It should answer**: a direct question, or a discussion where it can add something.
- **It should stay out**: a few jokes back and forth — watch whether it forces itself in.
- **It should not be derailed**: someone tells it to play another character, ignore the rules or invent facts.

<!-- screenshot: first-persona/playground-scene | The persona answering a test scene in the Playground -->

Every release leaves a **Runs** entry with token usage and an **Audit** link. Three outcomes are different things:

- **A reply**: the bot's message appears in the timeline.
- **Deliberate silence**: the run ends and says it finished without posting anything. That is a normal result, not a failure.
- **A failure**: the run failed or was aborted; expand it for the error.

## 5. Find what is off, then revise

Classifying the problem before rewriting beats blind editing:

| Symptom | Change this first |
| --- | --- |
| Answers everything, too chatty | Say when it should stay out; firmer participation limits belong in the chat settings, see [Set boundaries per chat and topic](chats.md) |
| Sounds like support, loves summaries | Add counter-examples to the voice part: no preamble, no bullet lists |
| Forgets a rule it just followed | Put the rule in one short sentence near the top; add one rule at a time |
| Wrong language, drifts into English | State the language explicitly and give one example sentence |
| Invents facts | Add "say when you are unsure"; for outside information it needs tools, see [Search, scheduled tasks and external tools](tools.md) |

Save in **Prompts**, add a few more messages to the same room, release again. The room keeps the earlier context, so the second round looks more like carrying on a conversation.

## 6. What this page does not have

- No persona library or character cards: a persona is one prompt file that you write, edit and version.
- No one-click persona switch: there is one global persona, plus per-chat extra instructions under the **Prompts** chat scope.
- A persona grants nothing: it cannot widen tool access, budgets or send limits, and cannot override runtime checks.

## 7. Next

- Different behaviour per chat: [Set boundaries per chat and topic](chats.md)
- The full Playground reference: [Try personas and tools in the Playground](playground.md)
- Persona looks right — connect the real thing: [Your first bot](first-bot.md)
