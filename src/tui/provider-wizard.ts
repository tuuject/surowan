import { confirm, select } from '@inquirer/prompts';
import type { FileConfig } from '../platform/config.ts';
import { addProvider, editProvider, selectProviderAlias } from './provider-wizard-provider.ts';
import type { ProviderAction, ProviderConfig } from './provider-wizard-support.ts';

/** `keyJar` is the path of the key jar that typed secrets are stored in. */
export async function runProviderWizard(config: FileConfig, keyJar: string): Promise<FileConfig> {
  let providers: Record<string, ProviderConfig> = { ...(config.providers as Record<string, ProviderConfig>) };
  let exit = false;
  while (!exit) {
    const choices: { value: ProviderAction; name: string }[] = [
      { value: 'add', name: 'Add provider' },
      { value: 'edit', name: 'Edit provider' },
    ];
    if (Object.keys(providers).length > 0) {
      choices.push({ value: 'delete', name: 'Delete provider' });
    }
    choices.push({ value: 'back', name: 'Back to main menu' });
    const action = await select<ProviderAction>({ message: 'Configure providers', choices });
    switch (action) {
      case 'add': {
        const provider = await addProvider(keyJar);
        if (provider !== undefined) {
          const config = provider.config as ProviderConfig;
          providers = { ...providers, [provider.alias]: config };
        }
        break;
      }
      case 'edit': {
        const alias = await selectProviderAlias(providers);
        if (alias !== undefined) {
          const toEdit = providers[alias] as ProviderConfig;
          const updated: ProviderConfig | undefined = await editProvider(toEdit, keyJar);
          if (updated !== undefined) {
            providers = { ...providers, [alias]: updated };
          }
        }
        break;
      }
      case 'delete': {
        const alias = await selectProviderAlias(providers);
        if (alias !== undefined && (await confirm({ message: `Delete provider "${alias}"?` }))) {
          const { [alias]: _, ...rest } = providers;
          providers = rest;
        }
        break;
      }
      default:
        exit = true;
        break;
    }
  }
  return { ...config, providers: providers as FileConfig['providers'] };
}
