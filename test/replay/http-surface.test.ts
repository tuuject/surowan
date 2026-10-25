import { afterEach, expect, test } from 'vitest';
import {
  asObject,
  cleanupFixtures,
  expectSessionActivityOnly,
  fixture,
  productionTables,
  runCli,
  setupAdminSession,
} from './http-fixtures.ts';

/**
 * The HTTP surface shared by key and session auth: invocation search, preflight
 * and prompt reads, and how engine rejections and revoked keys map to status.
 */

afterEach(cleanupFixtures);

test('keyword and precise public-message time search work through key and session HTTP without model work', async () => {
  const f = await fixture();
  const admin = await setupAdminSession(f.baseUrl);
  const env = { SUROWAN_ENDPOINT: f.baseUrl, SUROWAN_API_KEY: admin.key };
  const before = productionTables(f.rows());
  const incoming = await runCli(
    ['invocation', 'list', '--search', 'plain text', '--at', '2026-09-10 07:59', '--json'],
    env,
  );
  expect(incoming.code, incoming.stderr).toBe(0);
  expect(JSON.parse(incoming.stdout)).toMatchObject({
    items: [
      expect.objectContaining({
        id: '4001',
        matched_messages: [expect.objectContaining({ source: 'incoming', telegram_message_id: '901' })],
      }),
    ],
  });
  const bot = await runCli(
    ['invocation', 'list', '--search', 'seeded invocation', '--at', '2026-09-10T08:00:03Z', '--json'],
    env,
  );
  expect(bot.code, bot.stderr).toBe(0);
  expect(JSON.parse(bot.stdout)).toMatchObject({
    items: [
      expect.objectContaining({
        id: '4001',
        matched_messages: [
          expect.objectContaining({ source: 'bot', telegram_message_id: '902', telegram_send_id: expect.any(String) }),
        ],
      }),
    ],
  });
  const noMatch = await runCli(['invocation', 'list', '--search', 'private reasoning', '--json'], env);
  expect(noMatch.code).toBe(0);
  expect(JSON.parse(noMatch.stdout)).toEqual({ items: [], next_cursor: null });
  const key = await fetch(`${f.baseUrl}/api/invocations?search=plain&at=2026-09-10T07%3A59Z`, {
    headers: { authorization: `Bearer ${admin.key}` },
  });
  const session = await fetch(`${f.baseUrl}/api/invocations?search=plain&at=2026-09-10T07%3A59Z`, {
    headers: { cookie: admin.cookie },
  });
  expect(session.status).toBe(200);
  expect(await session.json()).toEqual(await key.json());
  const invalid = await fetch(`${f.baseUrl}/api/invocations?at=2026-02-30T10%3A00Z`, {
    headers: { authorization: `Bearer ${admin.key}` },
  });
  expect(invalid.status).toBe(400);
  expect(f.faux.state.callCount).toBe(0);
  expectSessionActivityOnly(before, productionTables(f.rows()));
}, 120_000);

test('missing opening scene fails the CLI and a revoked key fails unauthenticated', async () => {
  const f = await fixture();
  const admin = await setupAdminSession(f.baseUrl);
  f.clearScene();
  const env = { SUROWAN_ENDPOINT: f.baseUrl, SUROWAN_API_KEY: admin.key };

  // The CLI preflights first and reports the engine's stable reason verbatim.
  const cleared = await runCli(['invocation', 'replay', '4001', '--json'], env);
  expect(cleared.code).toBe(1);
  expect(cleared.stdout).toBe('');
  expect(JSON.parse(cleared.stderr)).toEqual({
    error: 'replay_scene_unavailable',
    message: expect.any(String),
  });
  expect(f.faux.state.callCount).toBe(0);

  // ReplayError -> AdminQueryError yields the engine's 409; an unconverted
  // error would surface as the generic 500 internal_error.
  const direct = await fetch(`${f.baseUrl}/api/invocations/4001/replay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.key}` },
    body: JSON.stringify({}),
  });
  expect(direct.status).toBe(409);
  expect(await asObject(direct)).toMatchObject({ error: 'replay_scene_unavailable' });
  expect(f.faux.state.callCount).toBe(0);

  // Revocation over the session-authenticated panel surface disables the same
  // key for the CLI immediately.
  const revoked = await fetch(`${f.baseUrl}/api/api-keys/${admin.keyId}`, {
    method: 'DELETE',
    headers: { cookie: admin.cookie },
  });
  expect(revoked.status).toBe(200);
  const refused = await runCli(['invocation', 'list', '--json'], env);
  expect(refused.code).toBe(1);
  expect(refused.stdout).toBe('');
  expect(JSON.parse(refused.stderr)).toMatchObject({ error: 'unauthenticated' });
  expect(f.faux.state.callCount).toBe(0);
}, 120_000);

test('preflight and active prompts are read-only HTTP reads that never call the model', async () => {
  const f = await fixture();
  const admin = await setupAdminSession(f.baseUrl);
  const headers = { authorization: `Bearer ${admin.key}` };
  const before = productionTables(f.rows());

  const preflight = await fetch(`${f.baseUrl}/api/invocations/4001/replay-preflight`, { headers });
  expect(preflight.status).toBe(200);
  expect(await asObject(preflight)).toEqual({
    available: true,
    reason: null,
    message: null,
    scene: {
      cutoff_at: '2026-09-10T07:59:45.000Z',
      source_bucket_id: '3001',
      message_count: 1,
      history_count: 0,
      omitted_messages: 0,
    },
    prompt_overrides_available: true,
    omitted_images: 0,
    fidelity: {
      input: 'historical_public_chat',
      model_selection: 'current_chat_config',
      prompt_selection: 'current_chat_config',
      tool_selection: 'current_registry',
      hot_injections: 'not_replayed',
      external_tools: 'blocked',
      system_resources: 'current_read_only',
      side_effects: 'synthetic',
    },
  });

  const prompts = await fetch(`${f.baseUrl}/api/invocations/4001/prompts`, { headers });
  expect(prompts.status).toBe(200);
  expect(await asObject(prompts)).toMatchObject({
    source: 'active',
    source_invocation_id: '4001',
    global_prompt: f.stable.promptLayers.global,
    group_prompt: f.stable.promptLayers.group,
    template_values: f.stable.templateValues,
    core_read_only: true,
  });
  expect(f.faux.state.callCount).toBe(0);
  // Neither read wrote anything, apart from the API key's own last_used_at.
  expect(productionTables(f.rows())).toEqual(before);

  // Clearing the payload makes the same preflight unavailable, and a missing
  // invocation is still a 404 rather than an "unavailable" document.
  f.clearScene();
  const cleared = await fetch(`${f.baseUrl}/api/invocations/4001/replay-preflight`, { headers });
  expect(cleared.status).toBe(200);
  expect(await asObject(cleared)).toMatchObject({
    available: false,
    reason: 'replay_scene_unavailable',
  });
  const missing = await fetch(`${f.baseUrl}/api/invocations/999999/replay-preflight`, { headers });
  expect(missing.status).toBe(404);
  expect(await asObject(missing)).toMatchObject({ error: 'not_found' });
  expect(f.faux.state.callCount).toBe(0);
  // The reads themselves wrote nothing; only the explicit payload clear moved a row.
  expect(productionTables(f.rows())).not.toEqual(before);
}, 120_000);
