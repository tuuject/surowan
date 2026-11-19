/**
 * The `mcp` gateway at its edges: names two servers would share, result pages
 * larger than one tool result, queries that are tool names, and side effects
 * whose outcome is unknown.
 */
import { expect, test } from 'vitest';
import {
  auditRows,
  bulkServer,
  gatewayOf,
  progressiveFixture,
  progressiveServer,
  search,
  text,
} from './progressive-fixtures.ts';

test('a name two progressive servers would both expose is refused like a duplicate registry tool', async () => {
  // `pair` + `x__tool1` and `pair__x` + `tool1` both expose `pair__x__tool1`.
  const f = await progressiveFixture([bulkServer('pair', ['2', 'x__']), bulkServer('pair__x', ['2'])]);
  const states = new Map(f.manager.serverStates().map((server) => [server.alias, server.state]));
  // Whichever discovered second failed the registry check and stays out.
  expect([...states.values()].sort()).toEqual(['degraded', 'ready']);
  const gateway = gatewayOf(f.tools());
  const listed = await search(gateway, 'p1', { query: 'pair__x__tool1' });
  expect(listed.tools.map((tool) => tool.tool)).toEqual(['pair__x__tool1']);
}, 60_000);

test('search pages stay parseable under the byte budget and continue through next_offset', async () => {
  // 130 tools whose 160-character CJK summaries would overflow one 32 KiB result.
  // The discovery response itself is large, so the server's payload limit is too.
  const f = await progressiveFixture([{ ...bulkServer('wide', ['130', '', '200']), payload_max_bytes: 1_048_576 }]);
  const gateway = gatewayOf(f.tools());
  const seen: string[] = [];
  let offset: number | undefined = 0;
  let pages = 0;
  while (offset !== undefined) {
    const raw = text(await gateway.execute(`page-${pages}`, { action: 'search', server: 'wide', offset }));
    expect(Buffer.byteLength(raw)).toBeLessThan(32_768);
    const page = JSON.parse(raw) as Awaited<ReturnType<typeof search>>;
    expect(page.total).toBe(130);
    expect(page.tools.length).toBeLessThanOrEqual(100);
    seen.push(...page.tools.map((tool) => tool.tool));
    offset = page.next_offset;
    pages += 1;
  }
  expect(pages).toBeGreaterThan(2);
  expect(seen).toEqual(Array.from({ length: 130 }, (_, index) => `wide__tool${index + 1}`));
  // A query pages the same way, ten matches at a time.
  const first = await search(gateway, 'q1', { query: 'bulk tool' });
  expect(first.tools).toHaveLength(10);
  expect(first.next_offset).toBe(10);
  const second = await search(gateway, 'q2', { query: 'bulk tool', offset: 10 });
  expect(second.tools[0]?.tool).toBe('wide__tool11');
}, 60_000);

test('the exact exposed name finds its tool, and a dotted query still splits into words', async () => {
  const f = await progressiveFixture();
  const gateway = gatewayOf(f.tools());
  expect((await search(gateway, 'n1', { query: 'prog-b__wait' })).tools[0]?.tool).toBe('prog-b__wait');
  expect((await search(gateway, 'n2', { query: 'prog-b.images' })).tools[0]?.tool).toBe('prog-b__images');
}, 60_000);

test('an unknown outcome inside the gateway leaves the outer row unknown too', async () => {
  const f = await progressiveFixture([progressiveServer()]);
  const chats = f.config.telegram.chats.map((chat, index) =>
    index === 0
      ? {
          ...chat,
          // The side-effecting tool times out after its request was sent.
          mcp: [
            {
              server: 'prog-b',
              tools: ['wait'],
              tool_policies: [{ name: 'wait', read_only: false, timeout_seconds: 0.2 }],
            },
          ],
        }
      : chat,
  );
  const gateway = gatewayOf(f.tools({ ...f.config, telegram: { ...f.config.telegram, chats } }));
  await expect(gateway.execute('u1', { action: 'call', tool: 'prog-b__wait', input: { ms: 3_000 } })).rejects.toThrow(
    /failed: timeout/,
  );
  const rows = new Map(auditRows(f).map((row) => [row.toolCallId, row]));
  expect(rows.get('u1:prog-b__wait')).toMatchObject({ state: 'outcome_unknown', errorCode: 'timeout' });
  expect(rows.get('u1')).toMatchObject({
    toolName: 'mcp',
    state: 'outcome_unknown',
    errorCode: 'timeout',
    sideEffect: true,
  });
}, 60_000);
