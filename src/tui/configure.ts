import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { confirm, select } from '@inquirer/prompts';
import type { FileConfig, ThinkingLevelConfig } from '../platform/config/index.ts';
import { loadConfig } from '../adapters/local-monolith/config/index.ts';
import { writeConfigEdits } from '../adapters/local-monolith/config/file.ts';
import { keychainPath, migrateKeychain } from '../platform/keychain.ts';
import { supportedThinkingLevels, THINKING_LEVELS } from '../platform/thinking-levels.ts';
import { runProviderWizard } from './provider-wizard/index.ts';

export async function runConfigure(configPath: string): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error(JSON.stringify({ status: 'error', error: 'configure requires an interactive terminal' }));
    process.exitCode = 1;
    return;
  }
  const keychain = keychainPath(configPath);
  let config: FileConfig;
  let originalSource: string;
  try {
    // The one-time format migration: an old flat key jar becomes a keychain
    // before the wizard reads or writes an entry.
    await migrateKeychain(keychain);
    const loaded = await loadConfig(configPath);
    config = loaded.fileConfig;
    originalSource = await readFile(configPath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to load config: ${message}`);
    process.exitCode = 1;
    return;
  }

  type MainAction = 'providers' | 'thinking' | 'save' | 'discard';
  let exit = false;
  while (!exit) {
    const action = await select<MainAction>({
      message: 'Surowan configuration',
      choices: [
        { value: 'providers', name: 'Configure providers' },
        { value: 'thinking', name: `Configure agent thinking level (${config.agent?.thinking_level ?? 'unset'})` },
        { value: 'save', name: 'Save and exit' },
        { value: 'discard', name: 'Exit without saving' },
      ],
    });
    switch (action) {
      case 'providers':
        config = await runProviderWizard(config, keychain);
        break;
      case 'thinking': {
        const agent = config.agent;
        const level = await select<ThinkingLevelConfig>({
          message: `Agent thinking level (${agent?.provider ?? 'unset'}/${agent?.model ?? 'unset'})`,
          choices: agentThinkingLevels(config).map((value) => ({ value, name: value })),
        });
        config = { ...config, agent: { ...(agent ?? {}), thinking_level: level } };
        break;
      }
      case 'save': {
        const saved = await saveConfig(configPath, config, originalSource);
        if (saved) {
          exit = true;
        }
        break;
      }
      default: {
        const ok = await confirm({ message: 'Discard changes?', default: false });
        if (ok) {
          exit = true;
        }
        break;
      }
    }
  }
}

/** Only the levels the agent model accepts are offered; saving validates the rest. */
export function agentThinkingLevels(config: FileConfig): readonly ThinkingLevelConfig[] {
  const provider = config.agent?.provider;
  const modelId = config.agent?.model;
  const model =
    provider === undefined || modelId === undefined
      ? undefined
      : config.providers[provider]?.models.find((candidate) => candidate.id === modelId);
  if (model !== undefined) {
    return supportedThinkingLevels(model);
  }
  // No resolvable model: offer every level — an incomplete identity is legal.
  return THINKING_LEVELS;
}

/**
 * Goes through the same staged write as the panel: the new file is validated as
 * a sibling temporary file and only then renamed over the original, so a
 * rejected configuration never reaches disk and there is nothing to restore.
 * The revision of the source this session started from makes the write fail
 * instead of overwriting a change made to the file in the meantime.
 *
 * Entries the wizard typed but the saved file does not use stay in the
 * keychain: nothing is reclaimed automatically, the panel's keychain manager
 * lists them as orphans until an explicit purge.
 */
export async function saveConfig(path: string, config: FileConfig, originalSource: string): Promise<boolean> {
  try {
    const revision = createHash('sha256').update(Buffer.from(originalSource, 'utf8')).digest('hex');
    await writeConfigEdits(path, [{ path: [], value: config }], revision);
    const loaded = await loadConfig(path);
    console.log(`Config saved and validated. Hash: ${loaded.hash}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Config not saved; the file is unchanged: ${message}`);
    return false;
  }
}
