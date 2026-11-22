---
title: Model metadata catalog
description: What models_dev.api_url does, which addresses are valid, the JSON format a mirror must serve, the default and how a change takes effect.
---

# Model metadata catalog

`models_dev` has exactly one job: when a model is added in the panel, its context length, output limit, accepted input, thinking levels and prices are read from this catalog. It never affects a running model — the metadata saved into `providers[].models` is the only thing the runtime reads.

See the [`models_dev` field reference](fields-models-dev.md).

## Default and syntax

The whole section is optional. When `api_url` (or the section) is omitted, the default is `https://models.dev/api.json`.

```jsonc
{
  "models_dev": { "api_url": "https://models.example.com/api.json" }
}
```

The same address can be set on the panel's Developer page under **Model details source** → **Catalog address**, which has a **Use the default** button.

## Which addresses are valid

`check-config` rejects:

- anything that is not an absolute HTTP(S) URL,
- an address with a username or password, or with a `#` fragment,
- a value longer than 2048 characters.

A query string is allowed, because CDNs and gateways commonly need a static `?token=`-style parameter. Redirects are not: the catalog must answer directly, and a 3xx fails the fetch.

## The format a mirror must serve

A mirror has to return the same structure as models.dev: an object keyed by provider id, each provider with `id`, `name` and a `models` map keyed by model id; each model has `id`, `name` and optionally `reasoning`, `reasoning_options`, `modalities`, `limit` (`context`/`input`/`output`), `cost` and more.

Runtime limits:

- 30-second timeout, 32 MiB response ceiling, `accept: application/json`.
- The parsed body is validated against a schema; a wrong structure reports "the catalog failed validation" rather than a missing field.
- Each address is cached for an hour and concurrent lookups share one download. A new address is fetched on the very next lookup, and switching back still finds the earlier entry cached.

```jsonc
{
  "models_dev": { "api_url": "https://cdn.example.com/models.dev/api.json?tenant=internal" }
}
```

## When the catalog cannot be read

A failed lookup never fails the add-model flow; it only removes one metadata source:

- The panel reports the catalog error (the response's `metadata_source_error`) and still lists the provider's own models.
- Fields that must be confirmed — context length, max output, input modalities — still need to be filled in or confirmed, and the panel marks how many are pending.
- A price that cannot be found is written as 0; a matched price can be used as-is and edited afterwards in the dialog.

## How a change takes effect

`models_dev` and `models_dev.api_url` are hot: the panel's next metadata lookup uses the published address, with no restart and no need to re-save the provider. Models already saved are never rewritten because the catalog changed.

Adding providers, fetching models and running health checks from the panel are covered in [connect and switch models](../guides/models.md).
