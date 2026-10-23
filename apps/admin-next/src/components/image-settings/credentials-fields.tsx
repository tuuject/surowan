import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { type EditableCredential, type EditableModel, selectClass } from './shared.ts';

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
      <div className="flex items-center gap-3">
        <input
          id="image-enabled"
          type="checkbox"
          checked={enabled}
          onChange={(event) => onEnabledChange(event.target.checked)}
          className="size-4"
        />
        <Label htmlFor="image-enabled">{t('image.settings.enableLabel')}</Label>
      </div>
      {enabled && (
        <>
          <p className="text-muted-foreground text-sm">{t('image.settings.credentialsHint')}</p>
          {credentials.map((entry, index) => (
            <div key={entry.key} className="grid gap-3 sm:grid-cols-[160px_1fr]">
              <div className="space-y-2">
                <Label htmlFor={`credential-name-${index}`}>{t('image.settings.credentialName')}</Label>
                <Input
                  id={`credential-name-${index}`}
                  value={entry.name}
                  disabled={entry.saved || models.some((model) => model.credentialRef === entry.name)}
                  onChange={(event) =>
                    setCredentials((current) =>
                      current.map((item) => (item.key === entry.key ? { ...item, name: event.target.value } : item)),
                    )
                  }
                />
              </div>
              <div className="space-y-2">
                {!entry.saved && credentialProviders.length > 0 && (
                  <div className="space-y-2">
                    <Label htmlFor={`credential-source-${index}`}>{t('image.settings.keySource')}</Label>
                    <select
                      id={`credential-source-${index}`}
                      className={selectClass}
                      value={entry.source}
                      onChange={(event) =>
                        setCredentials((current) =>
                          current.map((item) =>
                            item.key === entry.key ? { ...item, source: event.target.value, secret: '' } : item,
                          ),
                        )
                      }
                    >
                      <option value="">{t('image.settings.newKeyOption')}</option>
                      {credentialProviders.map((alias) => (
                        <option key={alias} value={alias}>
                          {t('image.settings.savedCredentialOption', { alias })}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {entry.source === '' && (
                  <>
                    <Label htmlFor={`credential-key-${index}`}>{t('image.settings.apiKeyLabel')}</Label>
                    <Input
                      id={`credential-key-${index}`}
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
                  </>
                )}
              </div>
              {!entry.saved && credentials.length > 1 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="sm:col-span-2 sm:justify-self-start"
                  disabled={models.some((model) => model.credentialRef === entry.name)}
                  onClick={() => setCredentials((current) => current.filter((item) => item.key !== entry.key))}
                >
                  {t('image.settings.removeCredential')}
                </Button>
              )}
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
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
