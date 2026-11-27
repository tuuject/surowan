---
title: Web fetch settings
description: The three web_fetch switches — Markdown negotiation, fake-IP proxy addresses and the dangerous all-address escape hatch — plus image fetching limits and the referer boundary.
---

# Web fetch settings

`web_fetch` reads one specific URL on the model's behalf and returns the page's main content as Markdown. It has no master switch: the capability is always mounted on Telegram and Playground. This section only tunes three protocol and safety switches.

```jsonc
{
  "web_fetch": {
    "accept_markdown": true,
    "allow_proxy_synthetic_addresses": false,
    "dangerously_allow_all_ip_addresses": false
  }
}
```

Every field is optional, and the values above are what you get by omitting them. **The whole section needs a restart**: it is not on the hot-apply list, so apply the configuration on the **Settings** page and restart the service — the panel offers **Restart now** when the deployment runs under a supervisor.

## Fields

| Field | Default | Meaning |
| --- | --- | --- |
| `accept_markdown` | `true` | Advertises `text/markdown` in the request headers, so sites that negotiate Markdown (Cloudflare's Markdown for Agents, for instance) serve it directly and the local HTML extraction step disappears. A call with `raw: true` ignores the preference and takes the original HTML. |
| `allow_proxy_synthetic_addresses` | `false` | Accepts hostnames that resolve into `198.18.0.0/15`, the fixed answer range of fake-IP proxies such as Clash and Surge. Only those deployments should turn it on. |
| `dangerously_allow_all_ip_addresses` | `false` | Skips every destination address check, so loopback, LAN and cloud metadata endpoints become reachable. For trusted single-user deployments that fetch their own services. |

### Why the two escape hatches differ

By default every hostname is resolved, and one non-public address is enough to refuse it: loopback, private ranges, carrier-grade NAT, link-local (including `169.254.0.0/16` cloud metadata), reserved blocks, multicast, and IPv6 ULA, link-local and transition prefixes are all rejected.

- `allow_proxy_synthetic_addresses` opens only `198.18.0.0/15`, and **only for a resolved hostname**: a literal `http://198.18.x.x/` stays refused. It fixes exactly one situation — a proxy that answers every DNS lookup with a fake IP.
- `dangerously_allow_all_ip_addresses` turns the deny table off, including the address check on every redirect hop. It does not open anything else: non-standard ports, credentials in the URL and `#` fragments are still refused. The `dangerously` in the name is literal — anything this machine and its network can reach becomes a resource the model can read through page content.

## Boundaries that always apply

Independent of configuration:

- `GET` only, HTTP(S) only, default ports only (80/443), and the URL may not carry a user name, password or `#` fragment.
- No cookies and none of the configured credentials; the User-Agent is `Mozilla/5.0 Surowan/<version>` so sites serve their normal page.
- At most 3 redirects, and under the default policy **every hop is address-checked again**, so "public URL 302s to 127.0.0.1" does not work.
- Only text-ish responses (`text/*`, JSON, XML, JavaScript) and images are accepted; other binary types and any `content-encoding` other than `identity` fail.
- Pages in GBK, Big5, Shift_JIS and other non-UTF-8 encodings read fine as long as the response header, the page's `<meta charset>` or its XML declaration names the encoding; a stray bad byte shows up as `�`. A page that names no encoding and is not UTF-8 fails with `invalid_text_encoding`; the encoding is never guessed.
- The returned text is capped at 32 KiB with a `[content truncated]` marker; an HTML body is read up to 2 MiB (conversion needs the whole page); one request times out after 15 seconds and never outlives the Invocation's remaining time.
- Everything returned is wrapped as untrusted web content: quotable, never an instruction or an authorization.

## Fetching images

Images inside a page stay as Markdown image links — an exclamation mark, a caption in brackets and the URL in parentheses — and are not downloaded automatically. To look at one, the model calls `web_fetch` again with the image URL:

- one image per call, attached as model input;
- JPEG, PNG and WebP are accepted and sniffed from the **content bytes**, never from `Content-Type`; SVG and other `+xml` types stay text;
- the limit is 20 MiB; a larger image fails with `image_too_large` instead of returning half a picture;
- when a site refuses hotlinks, the model may also pass `referer`: an absolute HTTP(S) URL without credentials, whose `#` fragment is dropped.

The image is handed to the current Agent model as one input, so the call only helps when that model accepts image input. The image links in the text cost nothing on their own.

## Example

A deployment with internal services and a strict isolation requirement usually keeps the defaults:

```jsonc
{
  "web_fetch": {
    "accept_markdown": true,
    "allow_proxy_synthetic_addresses": false,
    "dangerously_allow_all_ip_addresses": false
  }
}
```

If outbound traffic goes through a fake-IP proxy and page fetches keep failing with "resolves to a non-public address", add only `"allow_proxy_synthetic_addresses": true`.

## Interactions

- Search discovers results; this tool reads the page: [Web search settings](web-search.md).
- Failure codes and troubleshooting: [Troubleshoot startup failures and silence](../guides/troubleshooting.md).
- How images become context input: [Vision settings](vision.md).

Types: [Web fetch field reference](fields-web-fetch.md).
