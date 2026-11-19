/**
 * The discovery search `execute.search` and `mcp.search` share.
 *
 * Ways it could fail: a CJK query has no spaces, so splitting on non-ASCII
 * characters left it with no tokens and it could only match as a whole phrase;
 * function words would then match every Chinese description; `_`-joined tool
 * names must still match their spaced form; and the old English ranking (name
 * over label over description) must not move.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import Type from 'typebox';
import { expect, test } from 'vitest';
import { capability, createExecuteTool } from '../../src/capabilities/execute-tool.ts';
import { searchQuery, searchScore, searchTokens } from '../../src/platform/text-search.ts';
import { createToolAudit } from '../../src/store/tool-audit.ts';
import { fixture } from '../admin/fixtures.ts';
import { seedAdminFixture } from '../fixtures/admin-seed.ts';

test('queries are cut into words in any script, without function words or lone kana', () => {
  expect(searchTokens('帮我查一下北京明天的天气')).toEqual(['查', '北京', '明天', '天气']);
  expect(searchTokens('天气预报')).toEqual(['天气', '预报']);
  expect(searchTokens('検索して')).toEqual(['検索']);
  expect(searchTokens('Fetch a web_fetch PAGE')).toEqual(['fetch', 'web fetch', 'page']);
  expect(searchTokens('send-reply')).toEqual(['send', 'reply']);
  expect(searchTokens('  ')).toEqual([]);
});

test('each token scores the first field that holds it; the whole phrase adds ten', () => {
  const fields = [
    ['weather_forecast weather forecast', 3],
    ['Weather', 2],
    ['查询城市天气预报', 1],
  ] as const;
  expect(searchScore(searchQuery('天气'), fields)).toBe(10 + 1);
  expect(searchScore(searchQuery('明天天气'), fields)).toBe(1);
  expect(searchScore(searchQuery('forecast'), fields)).toBe(10 + 3);
  expect(searchScore(searchQuery('下雨'), fields)).toBe(0);
});

function fakeCapability(name: string, label: string, description: string): AgentTool {
  return {
    name,
    label,
    description,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  };
}

test('execute.search finds a capability from a Chinese request', async () => {
  const f = await fixture();
  try {
    const seed = seedAdminFixture(f.store);
    const execute = createExecuteTool({
      audit: createToolAudit(f.store, seed.invocationA),
      capabilities: [
        capability(fakeCapability('city_weather', 'City weather', '查询城市的天气与明天的预报'), false),
        capability(fakeCapability('draw_picture', 'Draw a picture', '根据描述生成一张图片'), true),
        capability(fakeCapability('web_fetch', 'Fetch a web page', 'Fetch one HTTP(S) page'), false),
      ],
    });
    const run = async (query: string) =>
      JSON.parse(
        (await execute.execute(`q-${query}`, { action: 'search', query })).content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join(''),
      ) as { readonly name: string }[];
    expect((await run('帮我查一下北京明天的天气')).map((entry) => entry.name)).toEqual(['city_weather']);
    expect((await run('画一张猫的图片')).map((entry) => entry.name)).toEqual(['draw_picture']);
    // The English ranking is unchanged: the name match wins.
    expect((await run('fetch a web page')).map((entry) => entry.name)).toEqual(['web_fetch']);
    expect(await run('下雨了吗')).toEqual([]);
  } finally {
    await f.server.stop();
    f.store.close();
  }
});
