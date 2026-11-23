---
title: Search, scheduled tasks and external tools
description: Turn on web search and page fetching, schedule recurring alarms, and connect outbound MCP servers within their limits.
---

# Search, scheduled tasks and external tools

This page covers three kinds of extra reach:

- **Web search and page fetching**: the model finds sources first, then reads pages or images.
- **Scheduled work**: the bot's own one-off alarms and the recurring alarms an admin defines.
- **Outbound MCP**: tools on external MCP servers the bot may call.

All three happen inside existing tool boundaries: capability switches, read-only policies, timeouts, size limits and auditing still apply, and no configuration grants the model new authority.

## Web search

Web search lets the model look for sources when it does not know a URL, receiving titles, URLs and short snippets, then read the pages that matter with `web_fetch`. The search itself never fetches page bodies, so it costs very little context.

It is **off by default**. Once enabled, the `web_search` capability and its Skill appear in the model's index.

### Configuring it in the panel

Open **Web search**:

![Web search with a configured engine and URL filters](__DOCS_BASE__/screenshots/tools/search-settings.en.light.png)

- **Enable web search** controls the whole feature. Turning it off — or disabling every engine — has the same effect: the capability and Skill disappear at once, **running invocations stop**, and the next message starts on a rebuilt Context.
- **Search engines** holds any number of engines. Each one needs a provider, a model-visible **Engine id** (lowercase letters, digits, dashes), an **Endpoint** (empty means the provider default; SearXNG requires one), **Results** (1–10), **Timeout (s)** (5–30) and a **Note for the model**. The note appears in the tool description and the engine list to say which sites or material that engine suits; the model picks engines by it.
- **Credential** chooses where the key comes from: keep the configured key, enter a new one, or use an existing Keychain entry. A new key is stored in `key.json` next to the configuration under the engine id, and the panel and the configuration only ever show whether it is configured. Removing an engine does **not** clean up its credential; unused entries are removed on the **Keychain** page.
- **URL filters** drop results you do not want. One regular expression per line (**RE2 syntax**: no lookarounds such as `(?=…)` and no backreferences), for example `csdn` to drop every `blog.csdn.net` result. **Test URLs** previews which rules match a pasted URL and sends no request at all.

Providers come from built-in plugins: `tavily`, `brave`, `exa`, `firecrawl`, `deepseek`, `searxng` and `youcom`. An unregistered provider is rejected. All but SearXNG have a default endpoint that `endpoint` can override, for example a gateway that speaks the same protocol.

Saving takes effect immediately. Changing the provider, the key or the search parameters does **not** interrupt a running invocation: each request freezes its engine, endpoint, key, count and timeout when it starts, so in-flight searches finish on the old configuration and the next one uses the new. Only the transition from available to unavailable stops runs.

### How the model uses it

- The model sees the engines and their notes, and may name an `engine` or leave it out.
- For anything time-sensitive, the Skill asks the model to put the current year, or the period you mentioned, into the query; otherwise engines tend to rank old pages first.
- Failures are **not** retried automatically. Authentication, quota, rate limit, upstream errors, rejected requests, redirects, timeouts, oversized responses and network errors are reported separately.
- When results are dropped by URL rules, the result header says how many.
- Results are untrusted data and never count as instructions or authorization.

Fields and validation are in [Web search settings](../configuration/web-search.md) and the [`web_search` field reference](../configuration/fields-web-search.md).

## Page fetching and images

`web_fetch` retrieves one page by URL. It is neither a search nor a general HTTP client:

- It performs an HTTP(S) GET with no cookies and no authentication headers, does not run JavaScript and cannot log in. Private and loopback addresses, nonstandard ports and unsafe redirect targets are rejected by default.
- HTML pages return their main content as Markdown (sites that support content negotiation are asked for Markdown first; disable that with `web_fetch.accept_markdown: false`). Raw HTML is only fetched when explicitly requested.
- Images in the body stay as Markdown image links with full addresses. When the picture itself matters, the model may fetch that image URL: **JPEG, PNG and WebP come back as an image for the model to look at, up to 20 MiB each**. GIF, AVIF and similar formats are not supported.
- Hotlink protection is handled with `referer` (usually the page URL). Only a model that accepts image input sees the picture; otherwise it receives an explanation.
- Anything needing JavaScript rendering, a login or heavy parsing belongs behind MCP.

`web_fetch.dangerously_allow_all_ip_addresses: true` removes every address restriction, letting anyone who can trigger the bot reach your internal network through the model. Enable it only when you fully trust those people. Full fields are in [Web fetch settings](../configuration/web-fetch.md) and the [`web_fetch` field reference](../configuration/fields-web-fetch.md).

## Scheduled work: alarms and recurring alarms

These are two different things:

| | Alarm | Recurring alarm |
| --- | --- | --- |
| Created by | Someone in the chat asking the bot to remind them | An admin in the panel |
| Schedule | Once, at a specific moment | Repeated by rules or cron |
| Prompt | The user's own words | A trusted prompt written by the admin |
| Can the bot change it | Yes (`alarm` / `list_alarm` / `delete_alarm`) | No, and it cannot even see the panel title |
| Panel page | **Alarms**, read-only audit | **Recurring alarms** |

An alarm creates a persistent task. When it comes due, a completion receipt is produced: if the conversation already has a run that can take an injection, the receipt is injected as its own block after the current tool chain; otherwise a new run starts when one can. The model decides whether to follow up with `send`; nothing is pre-written. It is not a general background worker. Each invocation may create at most 3 alarms.

## Recurring alarms

Recurring alarms make the bot act on a timetable: greeting the group at 08:00, or posting a short brief at 18:00. Each one has four parts: which conversation to post in, when to fire, which time zone, and the prompt handed to the bot.

Only admins can create or change them, on the **Recurring alarms** page. Group members cannot request them, and the bot can neither create, read nor delete them.

### Creating one

![The recurring alarm dialog with rules, cron and the next five runs](__DOCS_BASE__/screenshots/tools/recurring-alarm.en.light.png)

1. Choose **New recurring alarm**.
2. Fill in the **Title**. It is only shown in the panel; the bot never sees it.
3. Pick a **Target**: a configured Chat the bot has already seen (a Chat with a Topic allowlist is listed per Topic), or a Playground room, so you can test without disturbing a real group. Targets that cannot receive messages right now are marked with the reason and cannot be selected. **A saved alarm keeps its target**; create a new one to change it.
4. Set the **Time zone** (an IANA name such as `Asia/Shanghai`); a new alarm starts from the global time zone. Each alarm remembers its own zone, so later changes to the global zone never move an existing "8 a.m.".
5. Write the **Prompt**, up to 4000 characters. It is a trusted instruction from you: the bot carries it out as if you had asked in the chat, but it still only has the tools it already had. The prompt never grants new permissions.
6. Decide whether it is **Enabled**, then create it.

Each conversation holds at most 20 recurring alarms. A Chat with a Topic allowlist counts per Topic, and each Playground room counts separately.

### The schedule

A schedule has two views of the same rules:

- **Rules**: five fields — minute, hour, day, month, weekday — each set to "every" or "at". An empty "every" fires on every unit, a number fires every N units; "at" takes explicit values, comma separated, so `0,30` in minutes means on the hour and on the half hour. Weekdays are checkboxes.
- **Cron**: one standard five-field expression per line, `minute hour day month weekday`. `0 8 * * *` is 08:00 daily, `30 9 * * 1-5` is 09:30 on weekdays, and weekday `0` is Sunday.

Details:

- Several rules add up: the alarm fires whenever any rule matches.
- When one rule restricts both day and weekday, either may match — the usual cron behaviour.
- Seconds and years are not supported, nor are `L`, `W`, `#` or `?`.
- Once a line uses syntax the rule builder cannot represent (a range such as `1-5`), keep editing it as cron.
- Editing shows **Next runs**, the next five occurrences in the chosen zone. Two runs less than 5 minutes apart raise a warning that does not block saving.

### What happens when it fires

- If the bot is already running in that conversation, the task joins after the current tool chain; otherwise a new run starts.
- It **does not consume the daily token budget** and runs even while the bot is in its sleep window. Playground rooms behave the same way.
- The prompt arrives as the trusted `<admin_scheduled_task>` block, with the planned time and how many missed occurrences were folded in.
- As always, a message only appears in the chat if the model actually calls the send tool.

An occurrence is skipped — the alarm stays and fires again next time — when:

- The service was down or disconnected and recovery came more than 30 minutes after the planned time. If it is less late, the occurrences missed meanwhile are coalesced into a single delivery, whose count is recorded.
- The target Chat is paused or removed from the configuration, its Topic is no longer allowlisted, or the agent identity is incomplete.
- The previous occurrence has not been delivered yet.

### Running once, editing, deleting

- **Run now** on a row executes the saved prompt immediately, which is useful while tuning it. It goes through exactly the same path and the bot sees the same content; it does not change the schedule and works even while the alarm is disabled. It is refused while a previous run is still undelivered.
- Editing the schedule or time zone recomputes the next run from now; editing only the prompt affects later runs. The row switch disables and enables an alarm: a disabled alarm keeps its schedule but never fires, and an occurrence that has not started delivering is cancelled.
- Deleting removes the schedule and its run history, and also cancels an undelivered occurrence.
- **Details** shows the **Recent runs**: planned time, source (Scheduled or Manual), result, who ran it, and the invocation that handled it.

### Managing it with an API key

API keys can manage recurring alarms too (`surowan-utils`' `recurring-alarm` commands, or MCP tools). Listing and previewing need read access; creating, editing and running now make the bot call a model unattended, so they need both write and paid-operation permission; deleting needs write access.

## Outbound MCP

Outbound MCP lets the bot call tools on external MCP servers. A server is configured explicitly by an admin, over stdio (a command on the host) or Streamable HTTP, and the model stays inside the servers and tools allowed there.

### Managing it in the panel

Open **MCP servers**:

![MCP servers with state, progressive exposure and skills](__DOCS_BASE__/screenshots/tools/mcp-servers.en.light.png)

The page lists each server's live state (**Ready** / **Connecting** / **Degraded** / **No live state**, with an error code), a connection summary, every tool it has advertised (including those hidden by its tool selection), and **Used by**: which Chats bind it explicitly and which inherit it.

- **Add server** accepts Streamable HTTP servers only: alias, URL, header secrets, tool selection, size limits and policies. A stdio server runs a command on the host, so it must be added to `config.jsonc` on the server itself.
- **Edit** lets an HTTP server change its URL and headers; a stdio server can only change its tool selection, limits and policies. Its command, arguments, environment and transport stay read-only, and the page says so. Both kinds can change the exposure, the description and the skills switch.
- **Remove** requires unbinding first: if a Chat binds the server explicitly, the error lists those Chats. Chats without an `mcp` field inherit every server, so they simply lose this source.
- Tool names are `alias__tool`, so an alias must start with a letter and may only use letters, digits, underscores and dashes.

### Direct and progressive exposure

Each server chooses an **exposure**:

- **Direct** (the default): every tool is handed to the model as its own `alias__tool` tool, with its full definition on every request.
- **Progressive**: the server's tools stay out of the tool list. The model sees a single `mcp` tool whose description lists every progressive server's alias, tool count and description; it then finds a tool with `mcp` `search`, reads the full description and parameters with `help`, and calls it with `call`.

Progressive exposure suits servers with many tools: all of them together occupy one slot instead of pushing dozens of definitions onto every request. The cost is one extra lookup, and the model starts out knowing only what the **description** says, so write a good one (up to 1000 characters). Without a description the model sees only a few tool names, and the **Warnings** page reports `mcp_description_missing`.

Write the description yourself, or draft it from the tools the server advertises with **Draft with tool model**. Drafting is a **billed** tool model call whose output is only a draft: it fills the input box and is stored only when you confirm and save.

Progressive exposure grants nothing extra: `mcp` can only find and call the tools this Chat could already use (per-Chat bindings still narrow the set), and calls go through the same argument validation, read-only policies, timeouts, size limits and auditing as direct tools. The audit shows two rows: the outer `mcp` call, and the `alias__tool` that actually ran.

### Skills published by a server

A server that supports the "MCP with Skills" extension can publish Skills too — documents describing how to use its tools. Every connection discovers them and verifies each file's content, size and digest; a file that fails verification is dropped without affecting the server's tools.

The model reads these documents (under `mcp-skill://`) with `read`, and only for servers this Chat can reach. **They come from an external server**: they may explain how to use that server's tools, but they can never override tool constraints or authorization rules.

Each server has a **Skills for the model** switch, on when omitted. Turning it off hides that server's Skills from the model; changing it does not reconnect the server and takes effect on the next run.

### Background connection, degradation and recovery

Startup **never** waits for a server or fails because of one: every server connects in the background, and an unreachable or invalid instance is shown as **Degraded** and retried with backoff without disturbing other servers, startup or the current apply.

Only **Ready** servers hand their tools to the model: while a server is unreachable its tools disappear from the next run's registry and come back automatically once it recovers. During that time the **Warnings** page reports `mcp_server_unavailable` (Connecting does not warn).

### Hot application and per-Chat binding

`mcp.servers` and each Chat's `mcp` are both hot-applied, with no restart: after you apply the configuration from **Settings**, or after any panel save, added servers are connected, removed ones are closed, changed ones are replaced, and untouched ones stay connected.

Changing which tools a Chat may use (removing a binding, changing the tool list or a policy, or changing a server it reaches) **stops that Chat's running invocations, rebuilds their Context and then resumes each of them once**: the model sees the current history, is told that the operator changed the MCP configuration, and receives the names of MCP tools whose outcome is unknown, so it does not repeat side effects. Merely adding servers or widening a tool list does not interrupt running conversations. Changing only the exposure or description neither reconnects a server nor interrupts anything; it applies to the next run.

Per-Chat binding lives behind the **MCP servers** entry on each row of the **Chats** page:

- **Inherit everything** (no `mcp` field): every server, with its own settings.
- **Off** (an empty array): this Chat has no MCP tools at all.
- **Explicit binding**: pick servers and narrow their tools, optionally giving a tool its own read-only policy and timeout in this Chat.

A binding only narrows; it never changes the connection. Command, URL, environment and headers stay with the server, so two connections mean two aliases. Playground rooms never have MCP tools.

Fields are in [External MCP settings](../configuration/mcp.md) and the [`mcp` field reference](../configuration/fields-mcp.md), and the per-Chat shape is in [Telegram settings](../configuration/telegram.md) and the [`telegram` field reference](../configuration/fields-telegram.md).

## Read-only documentation versus external tools

"Extensions" has strict boundaries here; do not mix them up:

- **System Skills** are **read-only** Markdown documentation shipped with the release. The system prompt carries only the index; the model reads `system:///skills/<name>/SKILL.md` with `read` and then calls internal capabilities through `execute`. A Skill is a manual, not a permission file: it cannot bypass tool schemas, reference validation, allowlists, budgets or send rules.
- **Built-in plugins** (page fetching, web search and its seven providers, image generation, alarms, the dictionary) are compiled into the release. Configuration is the only way to enable or tune them, and they may declare dependencies and extension points, but there is no plugin marketplace.
- **Outbound MCP** is the only external tool source an admin can add, and it must be configured explicitly, then passes through allowlists, read-only policies, timeouts and size limits.
- There is currently **no** way to upload a Skill, hot-install a plugin or reach a third-party marketplace.

## Common mistakes

- Web search does not fetch pages: it returns titles, URLs and snippets, and the body needs `web_fetch`.
- `web_fetch` is not a general HTTP client and does not run JavaScript; use MCP when you need a login or rendering.
- A recurring alarm is not the bot's one-off alarm, and group members cannot create one. A trusted prompt does not widen tool permissions.
- Progressive exposure changes discovery, not permissions.
- "The model saw the tool name" is not "the call succeeded": check **Tool sessions** for the call and its result.

Related pages: [Web search settings](../configuration/web-search.md), [Web fetch settings](../configuration/web-fetch.md), [External MCP settings](../configuration/mcp.md), [Set boundaries per chat and topic](chats.md), [Troubleshoot startup failures and silence](troubleshooting.md).
