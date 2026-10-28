import { expect, test } from 'vitest';
import { composeAgentPrompt, preparePromptOverride, PromptOverrideError } from '../../src/platform/agent-prompt.ts';
import { renderPromptTemplate, validatePromptTemplate } from '../../src/platform/prompt-template.ts';

test('renders the allowlisted model and timezone values', () => {
  expect(
    renderPromptTemplate(
      '{{ agent.provider }}/{{agent.model}}; {{ vision.provider }}/{{ vision.model }}; {{timezone}}',
      {
        agent: { provider: 'gateway', model: 'chat-model' },
        vision: { provider: 'vision-gateway', model: 'vision-model' },
        timezone: 'Asia/Shanghai',
      },
    ),
  ).toBe('gateway/chat-model; vision-gateway/vision-model; Asia/Shanghai');
});

test('rejects unsupported and malformed expressions', () => {
  expect(() => validatePromptTemplate('{{agent.api_key}}', 'system prompt')).toThrow('unsupported template variable');
  expect(() => validatePromptTemplate('{{agent.model', 'system prompt')).toThrow('malformed template expression');
});

const LAYERS = {
  prefix: 'fixed prefix',
  global: 'global {{agent.model}}',
  group: 'group {{timezone}}',
};
const VALUES = {
  agent: { provider: 'gateway', model: 'chat-model' },
  vision: { provider: 'vision-gateway', model: 'vision-model' },
  timezone: 'Asia/Shanghai',
};

test('renders only operator templates and keeps the global and group precedence', () => {
  const prompt = composeAgentPrompt({ ...LAYERS, prefix: '{{agent.model}}' }, VALUES);
  expect(prompt.startsWith('{{agent.model}}\n\n')).toBe(true);
  expect(prompt.endsWith('\n\nglobal chat-model\n\ngroup Asia/Shanghai')).toBe(true);
});

test('omits the persona section when both final templates render empty', () => {
  expect(composeAgentPrompt({ ...LAYERS, global: '', group: '' }, VALUES)).toBe(LAYERS.prefix);
  expect(
    composeAgentPrompt(
      { ...LAYERS, global: '{{vision.provider}}', group: '{{vision.model}}' },
      { ...VALUES, vision: { provider: '', model: '' } },
    ),
  ).toBe(LAYERS.prefix);
});

test('prompt overrides strip HTML comments exactly like the configuration loader', () => {
  expect(preparePromptOverride('Replacement\n<!-- operator note -->', 'global')).toBe('Replacement');
  expect(preparePromptOverride('Kept <!-- mid-line --> text', 'group')).toBe('Kept  text');
  // An unterminated comment is not an annotation and stays verbatim.
  expect(preparePromptOverride('a <!-- open', 'group')).toBe('a <!-- open');
  // The group layer may be emptied; the global layer may not.
  expect(preparePromptOverride('', 'group')).toBe('');
  expect(preparePromptOverride('<!-- only a note -->', 'group')).toBe('');
});

test('prompt overrides reject NUL, BOM, unknown variables, oversized text and an empty global layer', () => {
  const code = (action: () => unknown): string => {
    try {
      action();
    } catch (error) {
      if (error instanceof PromptOverrideError) {
        return error.code;
      }
      throw error;
    }
    throw new Error('expected PromptOverrideError');
  };
  expect(code(() => preparePromptOverride('a\u0000b', 'global'))).toBe('replay_prompt_invalid');
  expect(code(() => preparePromptOverride('a\uFEFFb', 'global'))).toBe('replay_prompt_invalid');
  expect(code(() => preparePromptOverride('{{agent.api_key}}', 'global'))).toBe('replay_prompt_invalid');
  expect(code(() => preparePromptOverride('{{agent.model', 'group'))).toBe('replay_prompt_invalid');
  expect(code(() => preparePromptOverride('x'.repeat(65_537), 'global'))).toBe('replay_prompt_too_large');
  expect(code(() => preparePromptOverride('', 'global'))).toBe('replay_prompt_empty');
  expect(code(() => preparePromptOverride('<!-- only a note -->', 'global'))).toBe('replay_prompt_empty');
  // The cap itself is accepted.
  expect(preparePromptOverride('x'.repeat(65_536), 'global')).toHaveLength(65_536);
});
