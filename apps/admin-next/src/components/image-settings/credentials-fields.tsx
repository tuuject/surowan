import { Button } from '@tuuject/koi-react/button';
import { Checkbox } from '@tuuject/koi-react/checkbox';
import { Field } from '@tuuject/koi-react/field';
import { PlusIcon, TrashIcon } from '@tuuject/koi-react/icons';
import { Input } from '@tuuject/koi-react/input';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import type { EditableCredential, EditableModel } from './shared.ts';

/**
 * Enable toggle plus the credential rows it reveals: name, key source and the key itself. Rows are controlled by the
 * page because the save payload and the model credential references are validated there.
 */
export function CredentialsFields({
  enabled,
  onEnabledChange,
  credentials,
  setCredentials,
  models,
  savedNames,
  credentialProviders,
}: {
  readonly enabled: boolean;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly credentials: readonly EditableCredential[];
  readonly setCredentials: React.Dispatch<React.SetStateAction<EditableCredential[]>>;
  readonly models: readonly EditableModel[];
  /** Credential names that already have a stored key. */
  readonly savedNames: readonly string[];
  /** Aliases the server can supply keys from. */
  readonly credentialProviders: readonly string[];
}): React.ReactElement {
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
                />
              </Field>
              <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
                {!entry.saved && credentialProviders.length > 0 && (
                  <Field label={t('image.settings.keySource')}>
                    <Select
                      value={entry.source}
                      onChange={(event) =>
                        setCredentials((current) =>
                          current.map((item) =>
                            item.key === entry.key ? { ...item, source: event.target.value, secret: '' } : item,
                          ),
                        )
                      }
                      options={[
                        { value: '', label: t('image.settings.newKeyOption') },
                        ...credentialProviders.map((alias) => ({
                          value: alias,
                          label: t('image.settings.savedCredentialOption', { alias }),
                        })),
                      ]}
                    />
                  </Field>
                )}
                {entry.source === '' && (
                  <Field label={t('image.settings.apiKeyLabel')}>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      placeholder={
                        savedNames.includes(entry.name)
                          ? t('image.settings.configuredPlaceholder')
                          : t('image.settings.newKeyPlaceholder')
                      }
                      value={entry.secret}
                      onChange={(event) =>
                        setCredentials((current) =>
                          current.map((item) =>
                            item.key === entry.key ? { ...item, secret: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  </Field>
                )}
              </div>
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
                { key: crypto.randomUUID(), name: '', secret: '', saved: false, source: '' },
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
