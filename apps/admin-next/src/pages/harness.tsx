import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Switch } from '@tuuject/koi-react/switch';
import { Textarea } from '@tuuject/koi-react/textarea';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { FormActionBar, ListPageHeader, SettingRow } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { AppLink } from '@/components/router-links';
import type { HarnessValue, HarnessValues } from '@/lib/api/config.ts';
import { updateHarnessSettings } from '@/lib/api/config.ts';
import { errorMessage } from '@/lib/errors';
import {
  type DraftError,
  type DraftValue,
  draftOf,
  HARNESS_GROUPS,
  type HarnessField,
  parseDraft,
  sameHarnessValue,
} from '@/lib/harness';
import { useShowConfigKeys } from '@/lib/panel-preferences';
import { harnessQuery } from '@/lib/queries';
import { useProviderWrite } from '@/lib/use-provider-write';

function useHarnessSave() {
  const queryClient = useQueryClient();
  const write = useProviderWrite();
  return useMutation({
    mutationFn: ({ changes, revision }: { readonly changes: HarnessValues; readonly revision: string }) =>
      updateHarnessSettings(changes, revision),
    onSuccess: (result) => {
      queryClient.setQueryData(harnessQuery.queryKey, {
        revision: result.revision,
        saved: result.saved,
        active: result.active,
      });
      write.succeeded(result.apply);
    },
    onError: write.failed,
  });
}

export default function HarnessPage(): React.ReactElement {
  const { t } = useTranslation();
  const settings = useQuery(harnessQuery);
  // Owned above the form: a save that wrote the file but failed to apply moves
  // the revision, which re-mounts the form, and its error must survive that.
  const save = useHarnessSave();
  const current = settings.data;

  return (
    <div className={css({ maxWidth: '768px', marginInline: 'auto', '& > * + *': { marginBlockStart: '6' } })}>
      <ListPageHeader
        title={t('layout.nav.harness')}
        description={
          <>
            {t('harness.description')}{' '}
            <Trans
              i18nKey="harness.elsewhere"
              components={{ models: <AppLink to="/models" />, prompts: <AppLink to="/prompts" /> }}
            />
          </>
        }
      />
      {settings.isPending ? (
        <p className={css({ margin: '0', color: 'text-muted' })}>{t('common.loading')}</p>
      ) : settings.isError || current === undefined ? (
        <Alert tone="error" title={t('harness.loadFailed')}>
          {errorMessage(settings.error)}
        </Alert>
      ) : (
        // Re-mount on every new revision so the draft restarts from the saved file.
        <HarnessForm
          key={current.revision}
          revision={current.revision}
          saved={current.saved}
          active={current.active}
          save={save}
        />
      )}
    </div>
  );
}

function HarnessForm({
  revision,
  saved,
  active,
  save,
}: {
  readonly revision: string;
  readonly saved: HarnessValues;
  readonly active: HarnessValues;
  readonly save: ReturnType<typeof useHarnessSave>;
}): React.ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Record<string, DraftValue>>(() => draftOf(saved));
  const parsed = parseDraft(draft, saved);
  const changed = Object.keys(parsed.changes).length;
  const invalid = Object.keys(parsed.errors).length > 0;
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (changed > 0 && !invalid) {
          save.mutate({ changes: parsed.changes, revision });
        }
      }}
    >
      <fieldset disabled={save.isPending} className={css({ '& > * + *': { marginBlockStart: '6' } })}>
        {HARNESS_GROUPS.map((group) => (
          <Panel
            key={group.id}
            title={t(`harness.groups.${group.id}.title`)}
            description={t(`harness.groups.${group.id}.description`)}
          >
            <div className={css({ display: 'flex', flexDirection: 'column', gap: '5' })}>
              {group.fields.map((field) => (
                <HarnessFieldRow
                  key={field.key}
                  field={field}
                  value={draft[field.key] ?? ''}
                  error={parsed.errors[field.key]}
                  active={active[field.key] ?? null}
                  saved={saved[field.key] ?? null}
                  onChange={(value) => setDraft((previous) => ({ ...previous, [field.key]: value }))}
                />
              ))}
            </div>
          </Panel>
        ))}
      </fieldset>
      <FormActionBar
        status={
          invalid
            ? t('harness.invalid')
            : changed === 0
              ? t('harness.unchanged')
              : t('harness.pending', { count: changed })
        }
        error={save.isError ? errorMessage(save.error) : null}
        submitLabel={t('harness.save')}
        submittingLabel={t('harness.saving')}
        submitting={save.isPending}
        submitDisabled={changed === 0 || invalid}
        discardLabel={t('harness.discard')}
        discardDisabled={changed === 0}
        onDiscard={() => {
          save.reset();
          setDraft(draftOf(saved));
        }}
      />
    </form>
  );
}

function HarnessFieldRow({
  field,
  value,
  error,
  active,
  saved,
  onChange,
}: {
  readonly field: HarnessField;
  readonly value: DraftValue;
  readonly error: DraftError | undefined;
  readonly active: HarnessValue;
  readonly saved: HarnessValue;
  readonly onChange: (value: DraftValue) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const display = (shown: HarnessValue): string =>
    shown === null
      ? t('harness.noLimit')
      : typeof shown === 'boolean'
        ? t(shown ? 'harness.on' : 'harness.off')
        : Array.isArray(shown)
          ? shown.join(' / ')
          : String(shown);
  const mismatch = sameHarnessValue(saved, active) ? null : (
    <p role="status" className={css({ margin: '0', textStyle: 'small', color: 'warning-text' })}>
      {t('harness.running', { value: display(active) })}
    </p>
  );
  const label = t(`harness.fields.${field.key}.label` as 'harness.fields.max_concurrency.label');
  const description = t(`harness.fields.${field.key}.description` as 'harness.fields.max_concurrency.description');
  const showConfigKeys = useShowConfigKeys();
  const configPath = showConfigKeys ? (
    <code className={css({ display: 'block', fontFamily: 'mono' })}>
      {field.section ?? 'agent'}.{field.key}
    </code>
  ) : null;
  const help = (
    <>
      {description}
      {configPath}
    </>
  );

  if (field.kind === 'boolean') {
    return (
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '1' })}>
        <SettingRow label={label} description={description} {...(configPath === null ? {} : { hint: configPath })}>
          {({ id, describedBy }) => (
            <Switch
              id={id}
              aria-describedby={describedBy}
              checked={value === true}
              onCheckedChange={(checked) => onChange(checked)}
            />
          )}
        </SettingRow>
        {mismatch}
      </div>
    );
  }
  const errorText =
    error === undefined ? undefined : t(`harness.errors.${error.key}`, { min: error.limit, max: error.limit });
  const control =
    field.kind === 'select' ? (
      <Select
        className={css({ maxWidth: '320px' })}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
        options={(field.options ?? []).map((option) => ({
          value: option,
          label: t(
            `harness.fields.${field.key}.options.${option}` as 'harness.fields.send_empty_text_strategy.options.reject',
          ),
        }))}
      />
    ) : field.kind === 'lines' ? (
      <Textarea value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value)} />
    ) : (
      <Input
        className={css({ maxWidth: '240px' })}
        inputMode={field.kind === 'ratio' ? 'decimal' : 'numeric'}
        placeholder={field.nullable === true ? t('harness.noLimitPlaceholder') : undefined}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '1' })}>
      <Field label={label} help={help} error={errorText}>
        {control}
      </Field>
      {mismatch}
    </div>
  );
}
