import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { confirm, select } from '@inquirer/prompts';
import { type ParseError, parse } from 'jsonc-parser';
import { type FileConfig, loadConfig, type ThinkingLevelConfig } from '../platform/config.ts';
import { writeConfigEdits } from '../platform/config-file.ts';
import { keyJarPath, readKeyJar, referencedJarNames, updateKeyJar } from '../platform/key-jar.ts';
import { supportedThinkingLevels } from '../platform/thinking-levels.ts';
import { runProviderWizard } from './provider-wizard.ts';

const TELEMETRY_DESCRIPTION =
  'Sent to PostHog at startup and once a day: version, OS, CPU arch, Docker or not, and size ranges ' +
  '(chat, MCP server and 24h invocation counts as buckets like "2-5"). Never any Telegram ID, message, ' +
  'prompt, model or Provider name, URL or secret. Opt out any time, or set DO_NOT_TRACK=1.';

export async function runConfigure(configPath: string): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error(JSON.stringify({ status: 'error', error: 'configure requires an interactive terminal' }));
    process.exitCode = 1;
    return;
  }
  const keyJar = keyJarPath(configPath);
  let config: FileConfig;
  let originalSource: string;
  let jarBefore: ReadonlySet<string>;
  try {
    const loaded = await loadConfig(configPath);
    config = loaded.fileConfig;
    originalSource = await readFile(configPath, 'utf8');
    jarBefore = new Set(Object.keys((await readKeyJar(keyJar)) ?? {}));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to load config: ${message}`);
    process.exitCode = 1;
    return;
  }

  type MainAction = 'providers' | 'thinking' | 'telemetry' | 'save' | 'discard';
  try {
    let exit = false;
    while (!exit) {
      const action = await select<MainAction>({
        message: 'Plastic Wan configuration',
        choices: [
          { value: 'providers', name: 'Configure providers' },
          { value: 'thinking', name: `Configure agent thinking level (${config.agent.thinking_level})` },
          { value: 'telemetry', name: `Configure anonymous telemetry (${config.telemetry?.consent ?? 'not decided'})` },
          { value: 'save', name: 'Save and exit' },
          { value: 'discard', name: 'Exit without saving' },
        ],
      });
      switch (action) {
        case 'providers':
          config = await runProviderWizard(config, keyJar);
          break;
        case 'thinking': {
          const level = await select<ThinkingLevelConfig>({
            message: `Agent thinking level (${config.agent.provider}/${config.agent.model})`,
            choices: agentThinkingLevels(config).map((value) => ({ value, name: value })),
          });
          config = { ...config, agent: { ...config.agent, thinking_level: level } };
          break;
        }
        case 'telemetry': {
          const consent = await select<'granted' | 'denied'>({
            message: 'Share anonymous usage statistics?',
            choices: [
              {
                value: 'denied',
                name: 'No, send nothing',
                description: 'Nothing leaves this machine and the local install ID is deleted',
              },
              {
                value: 'granted',
                name: 'Yes, share coarse statistics',
                description: TELEMETRY_DESCRIPTION,
              },
            ],
          });
          config = { ...config, telemetry: { consent } };
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
  } finally {
    // Also after Ctrl+C, which surfaces as a rejected prompt. The original file
    // already loaded, so its reference set is readable.
    await pruneKeyJar(configPath, keyJar, jarBefore, jarNamesIn(originalSource) ?? new Set());
  }
}

/**
 * Secrets typed during the session are stored as soon as they are entered, so a
 * discarded session, a failed save or a replaced key would leave entries behind.
 * Whatever this session added or the original file used goes once the file on
 * disk no longer references it; entries the jar already had for other reasons
 * stay.
 */
async function pruneKeyJar(
  configPath: string,
  keyJar: string,
  before: ReadonlySet<string>,
  original: ReadonlySet<string>,
): Promise<void> {
  const jar = await readKeyJar(keyJar);
  if (jar === null) {
    return;
  }
  const onDisk = jarNamesIn(await readFile(configPath, 'utf8'));
  if (onDisk === null) {
    // A best-effort parse of a damaged file can miss references, and deleting
    // an entry it missed would lose a secret for good. Leave the jar alone.
    console.error('Config on disk does not parse; key jar entries were not cleaned up');
    return;
  }
  const remove = Object.keys(jar).filter((name) => !onDisk.has(name) && (original.has(name) || !before.has(name)));
  if (remove.length > 0) {
    await updateKeyJar(keyJar, { remove });
  }
}

/** Only the levels the agent model accepts are offered; saving validates the rest. */
function agentThinkingLevels(config: FileConfig): readonly ThinkingLevelConfig[] {
  const model = config.providers[config.agent.provider]?.models.find(
    (candidate) => candidate.id === config.agent.model,
  );
  return model === undefined ? [config.agent.thinking_level] : supportedThinkingLevels(model);
}

/**
 * Goes through the same staged write as the panel: the new file is validated as
 * a sibling temporary file and only then renamed over the original, so a
 * rejected configuration never reaches disk and there is nothing to restore.
 * The revision of the source this session started from makes the write fail
 * instead of overwriting a change made to the file in the meantime.
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

/** `null` when the source does not parse cleanly. */
function jarNamesIn(source: string): Set<string> | null {
  const errors: ParseError[] = [];
  const value: unknown = parse(source.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });
  return errors.length > 0 ? null : referencedJarNames(value);
}
