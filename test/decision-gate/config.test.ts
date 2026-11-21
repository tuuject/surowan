import { parse } from 'jsonc-parser';
import { describe, expect, test } from 'vitest';
import { validateFileConfig } from '../../src/platform/config/validate.ts';
import {
  DECISION_GATE_DEFAULT_INSTRUCTIONS,
  DECISION_GATE_DEFAULTS,
  renderDecisionGateInstructions,
  resolveDecisionGate,
} from '../../src/platform/decision-gate.ts';
import { testConfigJsonc } from '../helpers.ts';

/**
 * The entry gate's file shape, its cross-field rules and the per-Chat
 * resolution. Nothing here sends a request: the runtime is not wired yet, so
 * these are the contracts everything downstream will build on.
 */

type MutableConfig = Record<string, any>;

/** A schema-shaped fixture with one mutation applied; never touches the disk. */
function mutated(mutate: (root: MutableConfig) => void): unknown {
  const parsed = parse(testConfigJsonc('/nonexistent-decision-gate')) as MutableConfig;
  mutate(parsed);
  return parsed;
}

function telegramOf(root: MutableConfig): MutableConfig {
  return root.telegram;
}

describe('decision_gate configuration', () => {
  test('the fixture stays valid and accepts every behavior field', () => {
    const parsed = mutated((root) => {
      telegramOf(root).decision_gate = {
        enabled: true,
        mode: 'enforce',
        threshold: 0.4,
        history_messages: 0,
        pending_messages: 50,
        instructions: 'Should {{ bot.name }} reply?',
        model: 'typesafe/jev-1.14',
        base_url: 'https://openrouter.ai/api/alpha',
        api_key: { jar: 'telegram' },
        timeout_ms: 500,
      };
    });
    expect(() => validateFileConfig(parsed)).not.toThrow();
  });

  test('rejects out-of-range values and unknown fields', () => {
    const cases: [string, (gate: MutableConfig) => void][] = [
      ['threshold', (gate) => (gate.threshold = 1.5)],
      ['history_messages', (gate) => (gate.history_messages = 51)],
      ['pending_messages', (gate) => (gate.pending_messages = 0)],
      ['timeout_ms', (gate) => (gate.timeout_ms = 400)],
      ['mode', (gate) => (gate.mode = 'loud')],
      ['retries', (gate) => (gate.retries = 2)],
    ];
    for (const [field, apply] of cases) {
      const parsed = mutated((root) => {
        const gate: MutableConfig = {};
        telegramOf(root).decision_gate = gate;
        apply(gate);
      });
      expect(() => validateFileConfig(parsed), field).toThrow();
    }
  });

  test('a private chat cannot configure the gate', () => {
    const parsed = mutated((root) => {
      // The fixture's own chat is the positive id 123456789.
      telegramOf(root).chats[0].decision_gate = { enabled: true };
    });
    expect(() => validateFileConfig(parsed)).toThrow(/private chat and cannot configure decision_gate/);
  });

  test('a supergroup id may configure the gate', () => {
    const parsed = mutated((root) => {
      telegramOf(root).decision_gate = { api_key: { jar: 'gate' } };
      telegramOf(root).chats[0].id = -1_001_234_567_890;
      telegramOf(root).chats[0].decision_gate = { enabled: true, threshold: 0.9 };
    });
    expect(() => validateFileConfig(parsed)).not.toThrow();
  });

  test('a Chat that enables the gate needs the global api_key too', () => {
    // The Chat's own `enabled` wins over the global value, so the global
    // section being absent, bare or explicitly off does not excuse the key.
    for (const global of [undefined, {}, { enabled: false }]) {
      const parsed = mutated((root) => {
        if (global !== undefined) {
          telegramOf(root).decision_gate = global;
        }
        telegramOf(root).chats[0].id = -1_001_234_567_890;
        telegramOf(root).chats[0].decision_gate = { enabled: true };
      });
      expect(() => validateFileConfig(parsed), JSON.stringify(global)).toThrow(
        /decision_gate\.api_key is required when chat -1001234567890/,
      );
    }
    // Tuning a Chat without turning the gate on asks for nothing.
    const tuned = mutated((root) => {
      telegramOf(root).chats[0].id = -1_001_234_567_890;
      telegramOf(root).chats[0].decision_gate = { threshold: 0.9, enabled: false };
    });
    expect(() => validateFileConfig(tuned)).not.toThrow();
  });

  test('a Chat override cannot carry a connection field', () => {
    for (const field of [{ api_key: { jar: 'gate' } }, { model: 'other/model' }, { base_url: 'https://x.test' }]) {
      const parsed = mutated((root) => {
        telegramOf(root).chats[0].decision_gate = field;
      });
      // One credential and one endpoint serve every Chat, so the schema keeps
      // these fields out of the per-Chat object.
      expect(() => validateFileConfig(parsed), JSON.stringify(field)).toThrow();
    }
  });

  test('enabled without an api_key is an error; a disabled or bare section is not', () => {
    expect(() =>
      validateFileConfig(
        mutated((root) => {
          telegramOf(root).decision_gate = { enabled: true };
        }),
      ),
    ).toThrow(/decision_gate\.api_key is required/);
    // Presence only: the reference is never resolved, so an env or command ref
    // satisfies the check just like a keychain entry.
    for (const api_key of [{ env: 'DECISION_GATE_KEY' }, { command: ['pass', 'gate'] }, { jar: 'gate' }]) {
      expect(() =>
        validateFileConfig(
          mutated((root) => {
            telegramOf(root).decision_gate = { enabled: true, api_key };
          }),
        ),
      ).not.toThrow();
    }
    expect(() =>
      validateFileConfig(
        mutated((root) => {
          telegramOf(root).decision_gate = { enabled: false, mode: 'enforce' };
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateFileConfig(
        mutated((root) => {
          telegramOf(root).decision_gate = { threshold: 0.2 };
        }),
      ),
    ).not.toThrow();
  });

  test('base_url must be HTTPS and must not carry credentials', () => {
    for (const base_url of ['http://openrouter.ai/api/alpha', 'https://user:pass@openrouter.ai/api/alpha']) {
      expect(() =>
        validateFileConfig(
          mutated((root) => {
            telegramOf(root).decision_gate = { base_url };
          }),
        ),
      ).toThrow(/base_url must be an HTTPS URL without credentials/);
    }
    for (const base_url of [
      'not a url',
      'https://openrouter.ai/api/alpha?trace=1',
      'https://openrouter.ai/api/alpha#x',
      // `URL.search` and `URL.hash` are empty for a bare delimiter.
      'https://openrouter.ai/api/alpha?',
      'https://openrouter.ai/api/alpha#',
    ]) {
      expect(() =>
        validateFileConfig(
          mutated((root) => {
            telegramOf(root).decision_gate = { base_url };
          }),
        ),
      ).toThrow(/base_url/);
    }
  });

  test('a plaintext api_key is rejected like every other secret', () => {
    const parsed = mutated((root) => {
      telegramOf(root).decision_gate = { api_key: 'sk-plaintext' };
    });
    expect(() => validateFileConfig(parsed)).toThrow(/plaintext secrets are not accepted/);
  });
});

describe('resolveDecisionGate', () => {
  test('a configuration without the section resolves every default', () => {
    expect(resolveDecisionGate({})).toEqual({
      enabled: false,
      mode: 'shadow',
      threshold: 0.57,
      history_messages: 10,
      pending_messages: 10,
      instructions: DECISION_GATE_DEFAULT_INSTRUCTIONS,
      model: 'typesafe/jev-1.14',
      base_url: 'https://openrouter.ai/api/alpha',
      api_key: undefined,
      timeout_ms: 3_000,
    });
    // The default text asks a yes/no question about both placeholders; the
    // evaluation threshold is only meaningful for this question.
    expect(DECISION_GATE_DEFAULT_INSTRUCTIONS).toContain('{{ bot.name }}');
    expect(DECISION_GATE_DEFAULT_INSTRUCTIONS).toContain('{{ bot.username }}');
    expect(DECISION_GATE_DEFAULT_INSTRUCTIONS.trimEnd().endsWith('?')).toBe(true);
    expect(DECISION_GATE_DEFAULTS.mode).toBe('shadow');
  });

  test('a Chat override wins field by field over the global section and the defaults', () => {
    const global = {
      decision_gate: {
        enabled: true,
        threshold: 0.7,
        history_messages: 4,
        model: 'typesafe/jev-1.14',
        base_url: 'https://gateway.test/api',
        api_key: { jar: 'gate' },
      },
    };
    const settings = resolveDecisionGate(global, {
      decision_gate: { mode: 'enforce', threshold: 0.2, instructions: 'Should {{ bot.name }} answer?' },
    });
    expect(settings.mode).toBe('enforce');
    expect(settings.threshold).toBe(0.2);
    expect(settings.instructions).toBe('Should {{ bot.name }} answer?');
    // Untouched Chat fields inherit the global value, missing global ones the default.
    expect(settings.enabled).toBe(true);
    expect(settings.history_messages).toBe(4);
    expect(settings.pending_messages).toBe(10);
    expect(settings.base_url).toBe('https://gateway.test/api');
    expect(settings.api_key).toEqual({ jar: 'gate' });
  });

  test('the connection fields are global only: a Chat override cannot move them', () => {
    // The schema rejects these fields on a Chat, so resolution must not read
    // them from there even when an object carries them anyway.
    const settings = resolveDecisionGate(
      {},
      {
        decision_gate: {
          timeout_ms: 9_000,
          model: 'other/model',
          base_url: 'https://other.test',
          api_key: { jar: 'other' },
        } as never,
      },
    );
    expect(settings.timeout_ms).toBe(3_000);
    expect(settings.model).toBe('typesafe/jev-1.14');
    expect(settings.base_url).toBe('https://openrouter.ai/api/alpha');
    expect(settings.api_key).toBeUndefined();
  });

  test('instructions are a Chat-level behavior field, not a connection field', () => {
    const settings = resolveDecisionGate(
      { decision_gate: { instructions: 'global text' } },
      { decision_gate: { instructions: 'chat text' } },
    );
    expect(settings.instructions).toBe('chat text');
  });
});

describe('renderDecisionGateInstructions', () => {
  const bot = { name: 'Plastic Bowl', username: 'TcdwLobsterBot' };

  test('replaces both placeholders in the default text', () => {
    const rendered = renderDecisionGateInstructions(DECISION_GATE_DEFAULT_INSTRUCTIONS, bot);
    expect(rendered).toContain('Plastic Bowl');
    expect(rendered).toContain('@TcdwLobsterBot');
    expect(rendered).not.toContain('{{');
  });

  test('replaces both placeholders in a custom text, with or without spacing', () => {
    expect(renderDecisionGateInstructions('Is {{ bot.name }} (@{{bot.username}}) wanted?', bot)).toBe(
      'Is Plastic Bowl (@TcdwLobsterBot) wanted?',
    );
  });

  test('leaves an unknown placeholder literal instead of failing', () => {
    expect(renderDecisionGateInstructions('Is {{ bot.nickname }} here?', bot)).toBe('Is {{ bot.nickname }} here?');
  });
});
