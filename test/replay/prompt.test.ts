import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { clearModelPayloads } from '../../src/ingress/admin/developer.ts';
import type { ReplayPromptOverrides } from '../../src/orchestration/replay/index.ts';
import { composeAgentPrompt } from '../../src/platform/agent-prompt.ts';
import { CORE_AGENT_PROTOCOL } from '../../src/platform/agent-protocol.ts';
import {
  BUNDLED_SYSTEM_RESOURCES_DIR,
  FileSystemResources,
} from '../../src/adapters/local-monolith/system-resources.ts';
import { modelCalls } from '../../src/store/schema/index.ts';
import { HISTORY_CAPTION, OPENING_TEXT, fixture, messageText, stablePrompt } from './fixtures.ts';

test('the scene prompt is the current config and an override replaces only its own layer', async () => {
  const f = await fixture();
  const stable = stablePrompt(f.store, f.loaded.config, f.seed.invocationA);
  expect(stable.promptLayers.prefix.startsWith(CORE_AGENT_PROTOCOL)).toBe(true);
  expect(stable.systemPrompt).toContain('Participate safely.');
  expect(stable.systemPrompt).toContain('Conversation mode: group chat.');
  expect(stable.systemPrompt.endsWith('\n\nprivate')).toBe(true);

  const globalOverride = composeAgentPrompt(
    { ...stable.promptLayers, global: 'Replacement global layer.' },
    stable.templateValues,
  );
  f.faux.setResponses([
    (context) => {
      expect(getCurrentSystemPrompt(context.messages)).toBe(globalOverride);
      // Fixed runtime layers survive an override byte for byte.
      expect(getCurrentSystemPrompt(context.messages)).toContain(CORE_AGENT_PROTOCOL);
      expect(getCurrentSystemPrompt(context.messages)).toContain('Conversation mode: group chat.');
      expect(getCurrentSystemPrompt(context.messages).endsWith('\n\nprivate')).toBe(true);
      // A prompt override never touches the scene input.
      expect(messageText(context)).toContain(HISTORY_CAPTION);
      return fauxAssistantMessage('global override');
    },
  ]);
  expect(await f.run({ global_prompt: 'Replacement global layer.' })).toMatchObject({
    error: null,
    overrides: { global_prompt: true, group_prompt: false },
  });

  const groupOverride = composeAgentPrompt(
    { ...stable.promptLayers, group: 'Replacement group layer.' },
    stable.templateValues,
  );
  f.faux.setResponses([
    (context) => {
      expect(getCurrentSystemPrompt(context.messages)).toBe(groupOverride);
      expect(getCurrentSystemPrompt(context.messages)).toContain('Participate safely.');
      return fauxAssistantMessage('group override');
    },
  ]);
  expect(await f.run({ group_prompt: 'Replacement group layer.' })).toMatchObject({
    error: null,
    overrides: { global_prompt: false, group_prompt: true },
  });

  // Publishing a different configuration is what the next replay composes:
  // nothing about the scene is pinned to an old recording.
  const current = f.configStore.current();
  f.configStore.publish({
    ...current,
    config: {
      ...current.config,
      agent: { ...current.config.agent, system_prompt: 'A different current global layer.' },
      telegram: {
        ...current.config.telegram,
        chats: current.config.telegram.chats.map((chat) =>
          chat.id === 123_456_789 ? { ...chat, instructions: 'a different current group layer' } : chat,
        ),
      },
    },
  });
  const published = stablePrompt(f.store, f.configStore.current().config, f.seed.invocationA);
  f.faux.setResponses([
    (context) => {
      expect(getCurrentSystemPrompt(context.messages)).toBe(published.systemPrompt);
      expect(getCurrentSystemPrompt(context.messages)).toContain('A different current global layer.');
      expect(getCurrentSystemPrompt(context.messages).endsWith('\n\na different current group layer')).toBe(true);
      return fauxAssistantMessage('current config');
    },
  ]);
  expect(await f.run()).toMatchObject({ error: null });
  expect(f.runner.prompts(f.seed.invocationA)).toMatchObject({
    source: 'active',
    global_prompt: 'A different current global layer.',
    group_prompt: 'a different current group layer',
  });
});

test.each([
  {
    scenario: 'adding the first global persona',
    initialGlobal: '',
    initialGroup: '',
    override: { global_prompt: 'Speak as {{agent.model}}.' },
  },
  {
    scenario: 'clearing the only group persona',
    initialGlobal: '',
    initialGroup: 'Speak as {{agent.model}}.',
    override: { group_prompt: '' },
  },
])('replay matches saving the same prompt when $scenario', async ({ initialGlobal, initialGroup, override }) => {
  const f = await fixture();
  const current = f.configStore.current();
  const config = {
    ...current.config,
    agent: { ...current.config.agent, system_prompt: initialGlobal },
    telegram: {
      ...current.config.telegram,
      chats: current.config.telegram.chats.map((chat) => ({ ...chat, instructions: initialGroup })),
    },
  };
  f.configStore.publish({ ...current, config });
  const prompts: string[] = [];
  const capturePrompt = () => {
    f.faux.setResponses([
      (context) => {
        prompts.push(getCurrentSystemPrompt(context.messages));
        return fauxAssistantMessage('done');
      },
    ]);
  };
  const before = f.rows();
  capturePrompt();
  expect(await f.run(override)).toMatchObject({ error: null });

  const saved = {
    ...config,
    agent: { ...config.agent, system_prompt: override.global_prompt ?? config.agent.system_prompt },
    telegram: {
      ...config.telegram,
      chats: config.telegram.chats.map((chat) => ({
        ...chat,
        instructions: override.group_prompt ?? chat.instructions,
      })),
    },
  };
  f.configStore.publish({ ...f.configStore.current(), config: saved });
  capturePrompt();
  expect(await f.run()).toMatchObject({ error: null });
  expect(prompts).toEqual([
    stablePrompt(f.store, saved, f.seed.invocationA).systemPrompt,
    stablePrompt(f.store, saved, f.seed.invocationA).systemPrompt,
  ]);
  expect(f.rows()).toEqual(before);
});

test('prompt overrides reject unknown templates, NUL, BOM, oversize and emptied global layers', async () => {
  const f = await fixture();
  const stable = stablePrompt(f.store, f.loaded.config, f.seed.invocationA);
  const cases: readonly [ReplayPromptOverrides, string][] = [
    [{ global_prompt: '{{agent.api_key}}' }, 'replay_prompt_invalid'],
    [{ group_prompt: '{{ nope }}' }, 'replay_prompt_invalid'],
    [{ global_prompt: '{{agent.model' }, 'replay_prompt_invalid'],
    [{ global_prompt: 'a\u0000b' }, 'replay_prompt_invalid'],
    [{ global_prompt: 'a\uFEFFb' }, 'replay_prompt_invalid'],
    [{ global_prompt: 'x'.repeat(65_537) }, 'replay_prompt_too_large'],
    [{ global_prompt: '' }, 'replay_prompt_empty'],
    [{ global_prompt: '<!-- only a note -->' }, 'replay_prompt_empty'],
  ];
  for (const [override, code] of cases) {
    await expect(f.run(override)).rejects.toMatchObject({ code });
  }
  expect(f.faux.state.callCount).toBe(0);

  // Comments are stripped before the override becomes a template.
  f.faux.setResponses([
    (context) => {
      expect(getCurrentSystemPrompt(context.messages)).toBe(
        composeAgentPrompt({ ...stable.promptLayers, global: 'Replacement' }, stable.templateValues),
      );
      return fauxAssistantMessage('stripped');
    },
  ]);
  expect(await f.run({ global_prompt: 'Replacement\n<!-- operator note -->' })).toMatchObject({ error: null });
});

test('a scene replays with recording off, without any model call, after developer payload clearing', async () => {
  const f = await fixture();
  expect(f.loaded.config.developer?.record_model_payloads ?? false).toBe(false);
  const preflight = f.runner.inspect(f.seed.invocationA);
  expect(preflight).toMatchObject({ available: true, scene: { message_count: 2, history_count: 1 } });

  // The source invocation needs neither its model calls nor any retained
  // request/response payload: the scene comes from the chat itself.
  f.store.orm.delete(modelCalls).where(eq(modelCalls.invocationId, f.seed.invocationA)).run();
  await clearModelPayloads(f.store.orm);
  expect(
    f.store.orm
      .select({ id: modelCalls.id })
      .from(modelCalls)
      .where(eq(modelCalls.invocationId, f.seed.invocationA))
      .all(),
  ).toEqual([]);
  expect(f.runner.inspect(f.seed.invocationA)).toEqual(preflight);

  f.faux.setResponses([
    (context) => {
      expect(getCurrentSystemPrompt(context.messages)).toContain('Participate safely.');
      expect(messageText(context)).toContain(OPENING_TEXT);
      return fauxAssistantMessage(fauxToolCall('send', { text: 'still replayable' }), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage('done'),
  ]);
  const before = f.rows();
  expect(await f.run()).toMatchObject({ error: null, send_count: 1, usage: { model_calls: 2 } });
  expect(f.rows()).toEqual(before);
});

test('the default registry is the current read, send, send_reply, and execute definitions', async () => {
  const resources = await FileSystemResources.load(BUNDLED_SYSTEM_RESOURCES_DIR);
  const skill = resources.skills[0];
  if (skill === undefined) {
    throw new Error('Bundled system skills are missing');
  }
  const f = await fixture({ resources, defaultRegistry: true });

  f.faux.setResponses([
    (context) => {
      // No toolDefinitions hook: read/send/execute are the basic current set,
      // and no capability is registered.
      expect(
        getCurrentTools(context.messages)
          .map((tool) => tool.name)
          .sort(),
      ).toEqual(['execute', 'read', 'send', 'send_reply']);
      return fauxAssistantMessage(
        [
          fauxToolCall('read', { uri: skill.uri }),
          fauxToolCall('send', { kind: 'text', text: 'default registry send' }),
          fauxToolCall('execute', { action: 'call', tool: 'add_memory', input: { content: 'x' } }),
        ],
        { stopReason: 'toolUse' },
      );
    },
    fauxAssistantMessage('done'),
  ]);
  const result = await f.run();
  const readCall = result.tool_calls.find((call) => call.tool_name === 'read');
  expect(readCall?.is_error).toBe(false);
  expect(JSON.stringify(readCall?.result)).toContain(skill.uri);
  const capabilityCall = result.tool_calls.find((call) => call.tool_name === 'execute');
  expect(capabilityCall?.is_error).toBe(true);
  expect(JSON.stringify(capabilityCall?.result)).toContain('no capability named add_memory');
  expect(result).toMatchObject({ error: null, send_count: 1 });
  expect(result.fidelity.dispatches).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ tool_name: 'read', mode: 'live_read' }),
      expect.objectContaining({ tool_name: 'send', mode: 'synthetic' }),
      expect.objectContaining({ tool_name: 'execute', mode: 'blocked', capability: 'add_memory' }),
    ]),
  );
});
