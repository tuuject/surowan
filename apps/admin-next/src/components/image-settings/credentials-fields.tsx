import { Button } from '@tuuject/koi-react/button';
import { Checkbox } from '@tuuject/koi-react/checkbox';
import { Field } from '@tuuject/koi-react/field';
import { PlusIcon, TrashIcon } from '@tuuject/koi-react/icons';
import { Input } from '@tuuject/koi-react/input';
import { css } from '@tuuject/koi-react/styled-system/css';
import type React from 'react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { SecretField } from '@/components/secret-input/secret-field.tsx';
import type { SecretSource } from '@/lib/api/keychain.ts';
import type { EditableCredential, EditableModel } from './shared.ts';

/**
 * Enable toggle plus the credential rows it reveals: name and the shared key
 * input. Rows are controlled by the page because the save payload and the
 * model credential references are validated there.
 */
export function CredentialsFields({
  enabled,
  onEnabledChange,
  credentials,
  setCredentials,
  models,
  keychainEntries,
  keySources,
}: {
  readonly enabled: boolean;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly credentials: readonly EditableCredential[];
  readonly setCredentials: React.Dispatch<React.SetStateAction<EditableCredential[]>>;
  readonly models: readonly EditableModel[];
  /** Keychain entries the panel may pick. */
  readonly keychainEntries: readonly string[];
  /** Panel sessions only: where each stored credential's key comes from, by name. */
  readonly keySources: Readonly<Record<string, SecretSource>>;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <>
      {/* Applied by Save and apply, so a Checkbox rather than a Switch (Koi component choice). */}
      <Checkbox
        label={t('image.settings.enableLabel')}
        {...(enabled ? { description: t('image.settings.credentialsHint') } : {})}
        checked={enabled}
        onCheckedChange={onEnabledChange}
      />
      {enabled && (
        <>
          {credentials.map((entry) => (
            <div
              key={entry.key}
              className={css({ display: 'grid', gap: '4', md: { gridTemplateColumns: '200px 1fr' } })}
            >
              <Field label={t('image.settings.credentialName')}>
                <Input
                  value={entry.name}
                  disabled={entry.saved || models.some((model) => model.credentialRef === entry.name)}
                  onChange={(event) =>
                    setCredentials((current) =>
                      current.map((item) => (item.key === entry.key ? { ...item, name: event.target.value } : item)),
                    )
                  }
                  dir="ltr"
                />
              </Field>
              <SecretField
                label={t('image.settings.apiKeyLabel')}
                draft={entry.draft}
                source={entry.saved ? (keySources[entry.name] ?? null) : null}
                entries={keychainEntries}
                suggestedName={entry.name}
                disabled={false}
                onChange={(draft) =>
                  setCredentials((current) =>
                    current.map((item) => (item.key === entry.key ? { ...item, draft } : item)),
                  )
                }
                idPrefix={`image-credential-${entry.key}`}
              />
              {!entry.saved && credentials.length > 1 && (
                <Button
                  variant="ghost"
                  color="error"
                  iconStart={<TrashIcon />}
                  className={css({ md: { gridColumn: '1 / -1', justifySelf: 'start' } })}
                  disabled={models.some((model) => model.credentialRef === entry.name)}
                  onClick={() => setCredentials((current) => current.filter((item) => item.key !== entry.key))}
                >
                  {t('image.settings.removeCredential')}
                </Button>
              )}
            </div>
          ))}
          <Button
            variant="outline"
            color="secondary"
            iconStart={<PlusIcon />}
            className={css({ alignSelf: 'flex-start' })}
            onClick={() =>
              setCredentials((current) => [
                ...current,
                {
                  key: crypto.randomUUID(),
                  name: '',
                  saved: false,
                  draft: { mode: 'new', value: '', name: '' },
                },
              ])
            }
          >
            {t('image.settings.addCredential')}
          </Button>
        </>
      )}
    </>
  );
}
