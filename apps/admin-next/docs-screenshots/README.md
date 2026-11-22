# Documentation screenshots (`*.shot.ts`)

Playwright suite that photographs the built Admin Panel for the documentation
site. It is a **separate Playwright entry** on purpose:

- `pnpm run admin:test:e2e` (`playwright.config.ts`, `e2e/**/*.e2e.ts`) and
  `pnpm test` (vitest) never pick these files up;
- `pnpm run docs:screenshots` (root, and the same script in this package) builds
  the SPA, installs the Chromium shell and runs `playwright.docs.config.ts`.

A run captures into a staging directory first; only a *passed*, complete,
validated run publishes to the docs site (the bundled reporter writes the
verdict the teardown reads):

```text
apps/admin-next/.docs-shots-staging/     # per-run staging (gitignored)
  <topic>/<state>.<locale>.light.png     # locale ∈ zh-CN | en
  manifest.json

apps/docs/content/public/screenshots/    # published output, committed
  <topic>/<state>.<locale>.light.png
  manifest.json                          # what each file shows + run metadata
```

The teardown validates the staged set with `checkScreenshotAssets` (both locale
PNGs, the catalog, no stray files, real PNGs) and replaces the public directory
only then. A failed run, a killed run or a focused run leaves the committed
images untouched; set `DOCS_SHOTS_ALLOW_INCOMPLETE=1` for a focused run and the
teardown reports the staging path instead of publishing.

## Run it

```bash
pnpm run docs:screenshots        # from the repo root: build + one capture per scenario and locale
```

The root script wraps `pnpm --filter surowan-admin-next run docs:screenshots`,
which builds `dist/`, installs the Chromium shell and runs the config. While
iterating on one area, run Playwright directly and allow an incomplete set
(otherwise the teardown refuses to publish and reports what is missing):

```bash
# bash
DOCS_SHOTS_ALLOW_INCOMPLETE=1 pnpm --filter surowan-admin-next exec playwright test --config playwright.docs.config.ts -g "models"

# PowerShell
$env:DOCS_SHOTS_ALLOW_INCOMPLETE='1'; pnpm --filter surowan-admin-next exec playwright test --config playwright.docs.config.ts -g "models"
```

A focused run writes only its own files into the staging directory and never
touches the published set; re-run the full command before committing.

## What each project does

`playwright.docs.config.ts` defines one project per documentation locale
(`zh-CN`, `en`). The project name **is** the locale:

- `seedLocale` → the E2E server boots with `E2E_SEED_LOCALE`, and
  `e2e/docs-locale.ts` seeds the chat title, persona, model nicknames, Playground
  rooms, memories and keychain so a Chinese UI never shows English fake content
  (or the reverse). Only the prose differs; ids, timestamps and states are the
  shared fixture's.
- the browser language, `localStorage['admin-language']` and
  `localStorage['admin-theme'] = 'light'` are written before the first
  navigation;
- Chromium only, 1440×1000 at DPR 1, UTC, reduced motion, no retries.
  Two settings columns are framed taller (1440×1320 for the entry gate,
  1440×1400 for image settings) so the switch, the credential row and the saved
  model fit one image instead of hiding each other behind the sticky save bar.

The server is the real `AdminServer` + temporary SQLite + Faux runtime from
`e2e/` (`server.ts`, `server-boot.ts`, `server-fixtures.ts`). The browser may
only talk to that loopback server: `docs-screenshots/fixtures.ts` aborts every
other origin.

Docs mode (`E2E_SEED_LOCALE`) changes the fixture in three ways beyond the
localized prose, all in `e2e/`:

- `server-docs.ts` adds the rows the shared fixture cannot carry: the second
  (group) Chat every per-Chat dialog needs, a failed run that is the newest of
  its own Conversation (the Resume shot), and a completed tool-using run with a
  send (the Tool calls and Reviews shots). The shared fixture's failed run stays
  normalized to completed for the healthy overview.
- `server-docs-image.ts` answers the OpenRouter image catalog and images
  endpoint in-process and `server-boot.ts` starts the real `ImageService` plus
  its worker, so the image pages render real records instead of `503`.
- specs that photograph live MCP state opt into `test.use({ mcpManager: true })`,
  which runs the stdio fixture and the unreachable HTTP endpoint exactly as the
  ordinary E2E specs do.

## Add a scenario

1. Add an entry to `docs-screenshots/scenarios.ts` (the id is
   `<topic>/<state>`, e.g. `tuning/entry-gate`), with a one-line description,
   the target state and the doc pages that will embed it.
2. Write the test in the matching `docs-screenshots/*.shot.ts` file (split by
   area, not one file per shot). Reach the state by really clicking, typing and
   saving — or with the real API where the UI is not the point — then read it
   back through the API or the rendered text.
3. Capture:

   ```ts
   await captureScreenshot(page, docLocale, 'tuning/entry-gate');
   await captureScreenshot(page, docLocale, 'first-bot/chat-allowlist', page.getByRole('main'));
   await captureScreenshot(page, docLocale, 'playground/release-result', 'viewport', { scrollTo: runs });
   ```

   Pass a `Locator` to shoot one card/dialog (it is clipped with a small white
   margin), `'page'` for a full page, or nothing for the viewport. Pass
   `{ scrollTo }` when the documented part is lower on a long page.
4. Add UI strings the spec looks up to `docs-screenshots/labels.ts`, copied
   verbatim from `src/locales/<locale>/`. Structural hooks
   (`[data-model-list]`, `#id`, `role="dialog"`) are preferred where they exist.
5. Run the full suite; both locale images must appear, and a human must look at
   them before they are committed.

Every test runs twice (once per project) and writes the file for its project's
locale. Use `test.use({ ... })` per file for server options (`signedIn: false`
for the login page, `passkeys: true` for the WebAuthn scenario). The first test
that needs the server starts it for the whole file, so a file shares one server:
order the tests so a config write (which leaves the fixture's known
`admin.port` restart entry pending) comes last, or move the scenario to its own
file.

## Determinism rules

- No dates, database ids or ports in file names; `manifest.json` stores the
  commit, Playwright/Chromium version, platform, viewport and DPR, never a
  timestamp.
- Time comes from the fixture or the live clock; never hard-code an absolute
  time that must stay "in the future" (the E2E fixture rule applies here too).
- `captureScreenshot` waits for `document.fonts.ready`, an empty toast stack and
  no route error, disables animations/transitions/carets with an injected
  stylesheet and captures with `animations: 'disabled'`. Do not add sleeps to
  compensate; wait for the target text or data instead.
- Never edit the DOM to produce data. The one injected stylesheet is cosmetic
  (still frames, caret).
- `captureScreenshot` rejects an id outside `scenarios.ts`, a second capture of
  the same `(id, locale)` in one worker, and a `scrollTo` target that does not
  fit the viewport with its margin.
- The manifest records the source commit plus `worktree_dirty`: a local run
  builds the working tree, so the commit alone would misattribute the images.
- Regenerated PNGs are not byte-identical: the panel prints live values (the
  Telegram "since" time, the overview "generated at", API-key and passkey
  creation times, random key prefixes). That churn is accepted; images are not
  pixel-gated. Names, ids and the manifest are stable.

## What the screenshots do not prove

They show the real panel rendering real `AdminServer` data for a fixture
deployment. They are **not** evidence that:

- a real Provider or model connection works (every model call stays on the
  loopback fixture, which is also why the Providers page shows a loopback URL on
  purpose outside the shots);
- a real image vendor works: the catalog, the generation call and the return
  image are answered by `e2e/server-docs-image.ts`;
- Telegram delivers or receives anything (the connection state comes from a
  fixture hook; this process runs no live connection manager);
- a real one-time code, pairing code, API key plaintext, passkey or Cookie was
  used. None of those are captured, and the login shot never mints a code.

Screenshots are committed assets: a human reviews the PNGs (right language, no
English placeholder text in a Chinese panel or the reverse, the intended state
visible) before they are added to the repository.
