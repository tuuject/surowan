import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Switch } from '@tuuject/koi-react/switch';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog, ListPageHeader, SettingRow } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { clearModelPayloads, type DeveloperSettings, updateDeveloperSettings } from '@/lib/api/config.ts';
import { errorMessage } from '@/lib/errors';
import { developerQuery } from '@/lib/queries';
import { useProviderWrite } from '@/lib/use-provider-write';

/** The two independent switches the page mutates through the same PUT /developer endpoint. */
type DeveloperSwitch = 'record_model_payloads' | 'record_agent_thinking';

export default function DeveloperPage(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const settings = useQuery(developerQuery);
  const write = useProviderWrite();
  const [confirmClear, setConfirmClear] = useState(false);
  const update = useMutation({
    mutationFn: ({ field, enabled, revision }: { field: DeveloperSwitch; enabled: boolean; revision: string }) =>
      updateDeveloperSettings(
        field === 'record_model_payloads' ? { record_model_payloads: enabled } : { record_agent_thinking: enabled },
        revision,
      ),
    onSuccess: (result) => {
      queryClient.setQueryData(developerQuery.queryKey, result);
      write.succeeded(result.apply);
    },
    onError: write.failed,
  });
  const clear = useMutation({
    mutationFn: clearModelPayloads,
    onSuccess: () => {
      setConfirmClear(false);
    },
    onSettled: () => {
      // Even a failed sweep may have committed earlier batches.
      void queryClient.invalidateQueries({ queryKey: ['invocation'] });
    },
  });
  const current = settings.data;

  const mismatch = (active: boolean) => (
    <Alert tone="warning">
      {t('models.developer.stateMismatch', { status: active ? t('common.on') : t('common.off') })}
    </Alert>
  );

  return (
    <div className={css({ maxWidth: '768px', marginInline: 'auto', '& > * + *': { marginBlockStart: '6' } })}>
      <ListPageHeader title={t('layout.nav.developer')} />
      <Panel title={t('models.developer.debugTitle')} description={t('models.developer.debugDescription')}>
        {settings.isPending ? (
          <p className={css({ margin: '0', color: 'text-muted' })}>{t('common.loading')}</p>
        ) : settings.isError || current === undefined ? (
          <Alert tone="error">{errorMessage(settings.error)}</Alert>
        ) : (
          <div className={css({ display: 'flex', flexDirection: 'column', gap: '5' })}>
            <SettingRow
              label={t('models.developer.recordLabel')}
              description={t('models.developer.recordDescription')}
              hint={t('models.developer.recordHint')}
            >
              {({ id, describedBy }) => (
                <Switch
                  id={id}
                  aria-describedby={describedBy}
                  checked={current.record_model_payloads}
                  disabled={update.isPending}
                  onCheckedChange={(enabled) =>
                    update.mutate({ field: 'record_model_payloads', enabled, revision: current.revision })
                  }
                />
              )}
            </SettingRow>
            {current.record_model_payloads !== current.active_record_model_payloads
              ? mismatch(current.active_record_model_payloads)
              : null}
            <SettingRow
              label={t('models.developer.thinkingLabel')}
              description={t('models.developer.thinkingDescription')}
              hint={t('models.developer.thinkingHint')}
            >
              {({ id, describedBy }) => (
                <Switch
                  id={id}
                  aria-describedby={describedBy}
                  checked={current.record_agent_thinking}
                  disabled={update.isPending}
                  onCheckedChange={(enabled) =>
                    update.mutate({ field: 'record_agent_thinking', enabled, revision: current.revision })
                  }
                />
              )}
            </SettingRow>
            {current.record_agent_thinking !== current.active_record_agent_thinking
              ? mismatch(current.active_record_agent_thinking)
              : null}
            {update.isError ? <Alert tone="error">{errorMessage(update.error)}</Alert> : null}
          </div>
        )}
      </Panel>
      {current === undefined ? null : <ModelsDevSource key={current.revision} settings={current} />}
      <Panel
        title={t('models.developer.historyTitle')}
        description={t('models.developer.historyDescription')}
        action={
          <Button
            variant="outline"
            color="error"
            disabled={clear.isPending}
            onClick={() => {
              clear.reset();
              setConfirmClear(true);
            }}
          >
            {t('models.developer.clearButton')}
          </Button>
        }
      >
        {clear.isSuccess ? (
          <p role="status" className={css({ margin: '0', color: 'text-brand' })}>
            {t('models.developer.cleared', { count: clear.data.cleared_model_calls })}
          </p>
        ) : null}
      </Panel>
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={(open) => {
          if (!clear.isPending) {
            setConfirmClear(open);
          }
        }}
        title={t('models.developer.confirmTitle')}
        description={t('models.developer.confirmDescription')}
        confirmText={t('models.developer.confirmClear')}
        cancelText={t('common.cancel')}
        destructive
        pending={clear.isPending}
        error={clear.isError ? errorMessage(clear.error) : null}
        onConfirm={() => clear.mutate()}
      />
    </div>
  );
}

/**
 * Where the Providers page looks model details up when models are added. The
 * field is empty while the file names no address, and saving it empty removes
 * the setting again. Keyed by the file revision, so a save starts the field over
 * from what the file now holds.
 */
function ModelsDevSource({ settings }: { readonly settings: DeveloperSettings }): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const write = useProviderWrite();
  const [value, setValue] = useState(settings.models_dev_url ?? '');
  const save = useMutation({
    mutationFn: (url: string | null) => updateDeveloperSettings({ models_dev_url: url }, settings.revision),
    onSuccess: (result) => {
      queryClient.setQueryData(developerQuery.queryKey, result);
      write.succeeded(result.apply);
    },
    onError: write.failed,
  });
  const trimmed = value.trim();
  const target = trimmed.length === 0 ? null : trimmed;
  return (
    <Panel title={t('models.developer.modelsDevTitle')} description={t('models.developer.modelsDevDescription')}>
      <form
        noValidate
        className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(target);
        }}
      >
        <Field
          id="models-dev-url"
          label={t('models.developer.modelsDevLabel')}
          help={t('models.developer.modelsDevHint', { url: settings.default_models_dev_url })}
        >
          <Input
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={settings.default_models_dev_url}
            value={value}
            disabled={save.isPending}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
        {settings.models_dev_url !== settings.active_models_dev_url ? (
          <Alert tone="warning">
            {t('models.developer.modelsDevMismatch', {
              url: settings.active_models_dev_url ?? settings.default_models_dev_url,
            })}
          </Alert>
        ) : null}
        {save.isError ? <Alert tone="error">{errorMessage(save.error)}</Alert> : null}
        <div className={css({ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '2' })}>
          <Button
            type="button"
            variant="ghost"
            color="secondary"
            disabled={save.isPending || settings.models_dev_url === null}
            onClick={() => {
              setValue('');
              save.mutate(null);
            }}
          >
            {t('models.developer.modelsDevReset')}
          </Button>
          <Button type="submit" disabled={save.isPending || target === settings.models_dev_url}>
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
