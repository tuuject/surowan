import type { SecretDraft } from '@/components/secret-input/secret-field.tsx';
import type { ImageModelConfig } from '@/lib/api/images.ts';

/** Model row in the form: `key` is a stable React key, `description` is normalized to a string. */
export type EditableModel = ImageModelConfig & { key: string; description: string };

/** Credential row in the form: `key` is a stable React key, `draft` carries the key input. */
export type EditableCredential = {
  key: string;
  name: string;
  /** True when the configuration already stores this credential. */
  saved: boolean;
  draft: SecretDraft;
};

/** Strip the stable key and omit empty descriptions before persisting. */
export function toModelPayload(model: EditableModel): ImageModelConfig {
  const { key: _key, description, ...rest } = model;
  return description.trim() === '' ? rest : { ...rest, description };
}
