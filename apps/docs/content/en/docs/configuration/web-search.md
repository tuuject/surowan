---
title: Web search settings
description: What enables web_search, the built-in providers and their default endpoints, keys and endpoints, RE2 URL filters, and which changes interrupt a run.
---

# Web search settings

The `web_search` section lets the agent find sources first — titles, URLs and short snippets — and then read the page it picked with `web_fetch`. A search never fetches a page body, so it costs very little context.

Search is off by default. When it is available, the `web_search` capability and its skill appear in the model's index together; when it is not, both disappear, so the model is not even told that searching exists.

## When it is available

All three must hold:

1. the `web_search` section exists;
2. `enabled` is not `false` (omitted means on);
3. at least one engine has `enabled` not `false`.

An absent section, `"enabled": false`, and "every engine disabled" are the same state: neither the capability nor the skill is visible, and a model call is refused outright (`search_disabled`).

## Fields

| Field | Meaning |
| --- | --- |
| `enabled` | Optional, on by default. `false` is the explicit off switch. |
| `engines` | The engine list, at most 32 entries. |
| `engines[].id` | Engine identifier the model uses to pick one: starts with a lowercase letter, at most 32 lowercase letters, digits or hyphens. Unique within the section. |
| `engines[].provider` | Provider id; must be one of the table below. An unregistered provider fails at load. |
| `engines[].enabled` | Optional, on by default. |
| `engines[].endpoint` | Service address. An HTTP(S) URL without credentials, query or fragment. Omit to use the provider default; a provider without a default must set it. |
| `engines[].api_key` | A SecretRef. Whether it is required depends on the provider; see the table. |
| `engines[].results` | Default results per search, 1–10, default 5. Not allowed for a provider that chooses its own page size. |
| `engines[].timeout_seconds` | Per-search timeout, 5–30 seconds, default 15. The effective timeout never exceeds the Invocation's remaining time. |
| `engines[].note` | Optional, at most 1,000 characters. A note written for the model about what this engine is good for. |
| `url_filters` | Regexes that drop result URLs, at most 50, each at most 512 characters. |

### Built-in providers

| `provider` | Default endpoint | API key | Query limit | Accepts a result count |
| --- | --- | --- | --- | --- |
| `tavily` | `https://api.tavily.com/search` | required | 400 | yes |
| `brave` | `https://api.search.brave.com/res/v1/web/search` | required | 400 | yes |
| `exa` | `https://api.exa.ai/search` | required | 500 | yes |
| `firecrawl` | `https://api.firecrawl.dev/v2/search` | required | 500 | yes |
| `deepseek` | `https://api.deepseek.com/v1/tools/search` | required | 128 | yes |
| `searxng` | none | not accepted | 500 | no (the instance decides) |
| `youcom` | `https://ydc-index.io/v1/search` | required | 500 | yes |

The query limit is a silent trim applied before the request is sent: the tool's query field accepts at most 500 characters, and anything above the provider's limit is cut rather than refused. The audit row keeps both the original query (`requested_query`) and the query actually sent.

### URL filters

Each entry in `url_filters` is a regex in [RE2](https://github.com/google/re2) syntax:

- It matches **anywhere** in the URL, so no anchors are needed: `csdn` drops every `blog.csdn.net` hit, and `/wiki/` drops only hits whose path contains `/wiki/`.
- It applies to result URLs the provider returned; it never rewrites the request.
- The list is a deny list: a match drops the hit. It is not an allow list.
- A pattern that does not compile fails the whole configuration load instead of being ignored. RE2 has no lookaround (`(?=…)`, `(?<=…)`) and no backreferences, so those also fail.

The cost is why: matching runs synchronously on provider-supplied URLs, and a backtracking engine would let a pattern such as `(a+)+$` stall the entire process. RE2 is linear in the input.

## How it takes effect

The section is hot. The next apply reaches the next search without a restart:

- Each search freezes its engine, endpoint, key, count and timeout when it starts. A request already in flight finishes with the old settings; the next search uses the new ones.
- Disabling one engine does not interrupt a running Invocation. If that run asks for the engine that just went away, it is steered to re-read the current engine list.
- Going from available to unavailable — the switch turned off, or the last enabled engine disabled — **aborts every running Invocation** (reason `web_search_disabled`) and the next message starts from a rebuilt context. The skill index changed, so the old context must not keep pretending search exists.
- Coming back from unavailable to available changes the same index, so every conversation rebuilds its context on its next Invocation.

## Example

```jsonc
{
  "web_search": {
    "engines": [
      {
        "id": "main",
        "provider": "tavily",
        "api_key": { "jar": "tavily" },
        "results": 5,
        "note": "Chinese technical blogs and changelogs"
      },
      {
        "id": "local",
        "provider": "searxng",
        "endpoint": "https://searx.example.com",
        "note": "Private instance, reliable for documentation sites"
      }
    ],
    "url_filters": ["csdn", "/wiki/"]
  }
}
```

The panel page is **Web search**. It edits engines, chooses where a key comes from (keep the stored one, enter a new one, or reuse a Keychain entry) and previews URL filters without sending any request.

## Interactions

- `web_fetch` reads page bodies; its three switches are in [Web fetch settings](web-fetch.md).
- A failed search is never retried automatically. Authentication, quota, rate limit, timeout, oversized response and redirect are reported separately.
- Results are untrusted data that may never be treated as instructions or authorization; that holds regardless of configuration.

Types and ranges: [Web search field reference](fields-web-search.md).
