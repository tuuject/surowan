import { configuredModel, type FileConfig } from '../config/index.ts';

/**
 * What an operator sees for one configured model: its nickname when the model
 * entry declares one, otherwise `provider / model`. Commands render this label
 * so a nickname hides the provider and model id everywhere at once; the fields
 * themselves stay the identity used for switching and validation.
 */
export function modelDisplayLabel(
  config: { readonly providers: FileConfig['providers'] },
  provider: string,
  modelId: string,
): string {
  return configuredModel(config, provider, modelId)?.nickname ?? `${provider} / ${modelId}`;
}
