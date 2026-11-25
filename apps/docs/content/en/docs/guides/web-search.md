---
title: Web search and page fetching
description: Enable web search, configure search engines and URL filters, and fetch page content or images by URL.
---

# Web search and page fetching

This page covers two paired web capabilities:

- **Web search (`web_search`)**: the model looks up sources when it does not know a URL, receiving titles, URLs and short snippets.
- **Page fetching (`web_fetch`)**: fetches one page body or image by URL when a snippet is not enough.

Both are subject to their feature switches, timeouts and size limits, and are audited; no configuration grants the model new authority.

## Web search

Web search lets the model look for sources when it does not know a URL, receiving titles, URLs and short snippets, then read the pages that matter with `web_fetch`. The search itself never fetches page bodies, so it costs very little context.

It is **off by default**. Only once it is enabled can the model see and use `web_search`.

### Configuring it in the panel

Open **Bot → Web search**:

![Web search with a configured engine and URL filters](__DOCS_BASE__/screenshots/tools/search-settings.en.light.png)

- **Enable web search** controls the whole feature. Turning it off — or disabling every engine — has the same effect: the model loses search at once, **running invocations stop**, and the next message starts on a rebuilt Context.
- **Search engines** holds any number of engines. Each one needs a provider, a model-visible **Engine id** (lowercase letters, digits, dashes), an **Endpoint** (empty means the provider default; SearXNG requires one), **Results** (1–10), **Timeout (s)** (5–30) and a **Note for the model**. The note appears in the tool description and the engine list to say which sites or material that engine suits; the model picks engines by it.
- **Credential** chooses where the key comes from: keep the configured key, enter a new one, or use an existing Keychain entry. A new key is stored in `key.json` next to the configuration under the engine id, and the panel and the configuration only ever show whether it is configured. Removing an engine does **not** clean up its credential; unused entries are removed on the **Keychain** page.
- **URL filters** drop results you do not want. One regular expression per line (**RE2 syntax**: no lookarounds such as `(?=…)` and no backreferences), for example `csdn` to drop every `blog.csdn.net` result. **Test URLs** previews which rules match a pasted URL and sends no request at all.

The supported providers are `tavily`, `brave`, `exa`, `firecrawl`, `deepseek`, `searxng` and `youcom`; any other provider is rejected. All but SearXNG have a default endpoint that `endpoint` can override, for example a gateway that speaks the same protocol.

Saving takes effect immediately. Changing the provider, the key or the search parameters does **not** interrupt a running invocation: a search already under way finishes on the old settings and the next one uses the new. Only the transition from available to unavailable stops runs.

### How the model uses it

- The model sees the engines and their notes, and may name an `engine` or leave it out.
- For anything time-sensitive, the model is told to put the current year, or the period you mentioned, into the query; otherwise engines tend to rank old pages first.
- Failures are **not** retried automatically. Authentication, quota, rate limit, upstream errors, rejected requests, redirects, timeouts, oversized responses and network errors are reported separately.
- When results are dropped by URL rules, the result header says how many.
- Results are untrusted data and never count as instructions or authorization.

Fields and validation are in [Web search settings](../configuration/web-search.md) and the [`web_search` field reference](../configuration/fields-web-search.md).

## Page fetching and images

`web_fetch` retrieves one page by URL. It is neither a search nor a general HTTP client:

- It performs an HTTP(S) GET with no cookies and no authentication headers, does not run JavaScript and cannot log in. Private and loopback addresses, nonstandard ports and unsafe redirect targets are rejected by default.
- HTML pages return their main content as Markdown (sites that support content negotiation are asked for Markdown first; disable that with `web_fetch.accept_markdown: false`), preceded by a separate list of page metadata: title, description, author, publish time, preview image, Schema.org structured data and similar. Raw HTML is only fetched when explicitly requested.
- Images in the body stay as Markdown image links with full addresses, and the preview image (`og:image`) is given as a full address too, so pages whose body yields no image, such as posts on X, can still have their picture opened. When the picture itself matters, the model may fetch that image URL: **JPEG, PNG and WebP come back as an image for the model to look at, up to 20 MiB each**. GIF, AVIF and similar formats are not supported.
- Hotlink protection is handled with `referer` (usually the page URL). Only a model that accepts image input sees the picture; otherwise it receives an explanation.
- Anything needing JavaScript rendering, a login or heavy parsing belongs behind an MCP server; see [Connect MCP servers](mcp.md).

`web_fetch.dangerously_allow_all_ip_addresses: true` removes every address restriction, letting anyone who can trigger the bot reach your internal network through the model. Enable it only when you fully trust those people. Full fields are in [Web fetch settings](../configuration/web-fetch.md) and the [`web_fetch` field reference](../configuration/fields-web-fetch.md).

## Common mistakes

- Web search does not fetch pages: it returns titles, URLs and snippets, and the body needs `web_fetch`.
- `web_fetch` is not a general HTTP client and does not run JavaScript; use [Connect MCP servers](mcp.md) when you need a login or rendering.

Related pages: [Web search settings](../configuration/web-search.md), [Web fetch settings](../configuration/web-fetch.md), [Connect MCP servers](mcp.md), [Troubleshoot startup failures and silence](troubleshooting.md).
