import { expect, test } from 'vitest';
import { createReplayTools } from '../src/orchestration/replay-tools.ts';
import { emptySystemResources } from '../src/platform/system-resources.ts';
import { BUNDLED_SYSTEM_RESOURCES_DIR, FileSystemResources } from '../src/adapters/local-monolith/system-resources.ts';
import { ReadParameters, definition, replayInput, textOf, toolOf } from './replay-tools-fixtures.ts';

test('zzz reports a synthetic sleep transition without writing global state', async () => {
  const replay = createReplayTools(replayInput({ tools: [definition('zzz')] }), emptySystemResources());
  const result = await toolOf(replay.tools, 'zzz').execute('zzz-1', {});
  const details = result.details as { sleep_until: string; entered: boolean };
  expect(details.entered).toBe(true);
  expect(Date.parse(details.sleep_until)).toBeGreaterThan(Date.now());
  expect(textOf(result)).toBe(`Sleeping until ${details.sleep_until}`);
  expect(replay.dispatches).toEqual([{ tool_call_id: 'zzz-1', tool_name: 'zzz', mode: 'synthetic' }]);
});

test('read serves bundled system resources and refuses paths outside the tree', async () => {
  const resources = await FileSystemResources.load(BUNDLED_SYSTEM_RESOURCES_DIR);
  const skill = resources.skills[0];
  if (skill === undefined) {
    throw new Error('Bundled system skills are missing');
  }
  const replay = createReplayTools(replayInput({ tools: [definition('read', ReadParameters)] }), resources);
  const read = toolOf(replay.tools, 'read');
  const result = await read.execute('read-1', { uri: skill.uri });
  expect(textOf(result).length).toBeGreaterThan(0);
  expect(result.details).toMatchObject({ uri: skill.uri });
  await expect(read.execute('read-2', { uri: 'file:///etc/passwd' })).rejects.toThrow('read failed: invalid_uri');
  await expect(read.execute('read-3', { uri: 'system:///skills/../../etc/passwd' })).rejects.toThrow(
    'read failed: invalid_uri',
  );
  await expect(read.execute('read-4', { uri: 'system:///skills/memory/missing.md' })).rejects.toThrow(
    'read failed: resource_not_found',
  );
  expect(replay.dispatches).toEqual([
    { tool_call_id: 'read-1', tool_name: 'read', mode: 'live_read' },
    { tool_call_id: 'read-2', tool_name: 'read', mode: 'live_read' },
    { tool_call_id: 'read-3', tool_name: 'read', mode: 'live_read' },
    { tool_call_id: 'read-4', tool_name: 'read', mode: 'live_read' },
  ]);
});
