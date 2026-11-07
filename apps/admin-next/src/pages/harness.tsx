import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Select } from '@tuuject/koi-react/select';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Panel } from '@/components/layout/panel';
import { Button } from '@tuuject/koi-react/button';
import { Input } from '@tuuject/koi-react/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@tuuject/koi-react/switch';
import { Textarea } from '@tuuject/koi-react/textarea';
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
import { css } from '@tuuject/koi-react/styled-system/css';

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
    <div className={css({ maxWidth: '48rem', '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
      <div
        className={css({ textStyle: 'body', color: 'text-muted', '& > :not(:last-child)': { marginBlockEnd: '1' } })}
      >
        <p>{t('harness.description')}</p>
        <p>
          <Trans
            i18nKey="harness.elsewhere"
            components={{
              models: (
                <Link
                  to="/models"
                  className={css({ color: 'text', textDecorationLine: 'underline', textUnderlineOffset: '4px' })}
                />
              ),
              prompts: (
                <Link
                  to="/prompts"
                  className={css({ color: 'text', textDecorationLine: 'underline', textUnderlineOffset: '4px' })}
                />
              ),
            }}
          />
        </p>
      </div>
      {settings.isPending ? (
        <p className={css({ textStyle: 'body', color: 'text-muted' })}>{t('common.loading')}</p>
      ) : settings.isError || current === undefined ? (
        <p role="alert" className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
          {t('harness.loadFailed')}: {errorMessage(settings.error)}
        </p>
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
      className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}
      onSubmit={(event) => {
        event.preventDefault();
        if (changed > 0 && !invalid) {
          save.mutate({ changes: parsed.changes, revision });
        }
      }}
    >
      <fieldset disabled={save.isPending} className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
        {HARNESS_GROUPS.map((group) => (
          <Panel
            key={group.id}
            title={t(`harness.groups.${group.id}.title`)}
            description={t(`harness.groups.${group.id}.description`)}
          >
            <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
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
      <div
        className={css({
          bg: 'surface',
          position: 'sticky',
          bottom: '0',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '3',
          borderTopWidth: '1px',
          borderColor: 'divider',
          paddingBlock: '3',
        })}
      >
        <Button type="submit" disabled={save.isPending || changed === 0 || invalid}>
          {save.isPending ? t('harness.saving') : t('harness.save')}
        </Button>
        <Button
          type="button"
          variant="outline"
          color="secondary"
          disabled={save.isPending || changed === 0}
          onClick={() => {
            save.reset();
            setDraft(draftOf(saved));
          }}
        >
          {t('harness.discard')}
        </Button>
        <p className={css({ textStyle: 'body', color: 'text-muted' })}>
          {invalid
            ? t('harness.invalid')
            : changed === 0
              ? t('harness.unchanged')
              : t('harness.pending', { count: changed })}
        </p>
        {save.isError ? (
          <p
            role="alert"
            className={css({ textStyle: 'body', color: 'error-text', width: '100%', overflowWrap: 'anywhere' })}
          >
            {errorMessage(save.error)}
          </p>
        ) : null}
      </div>
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
  const id = `harness-${field.key.replace(/[._]/g, '-')}`;
  const describedBy = `${id}-description`;
  const display = (shown: HarnessValue): string =>
    shown === null
      ? t('harness.noLimit')
      : typeof shown === 'boolean'
        ? t(shown ? 'harness.on' : 'harness.off')
        : Array.isArray(shown)
          ? shown.join(' / ')
          : String(shown);
  const mismatch = sameHarnessValue(saved, active) ? null : (
    <p role="status" className={css({ textStyle: 'body', color: 'warning-text' })}>
      {t('harness.running', { value: display(active) })}
    </p>
  );
  const label = t(`harness.fields.${field.key}.label` as 'harness.fields.max_concurrency.label');
  const description = t(`harness.fields.${field.key}.description` as 'harness.fields.max_concurrency.description');
  const showConfigKeys = useShowConfigKeys();
  const configPath = showConfigKeys ? (
    <code className={css({ textStyle: 'small', color: 'text-muted', display: 'block', fontFamily: 'mono' })}>
      {field.section ?? 'agent'}.{field.key}
    </code>
  ) : null;

  if (field.kind === 'boolean') {
    return (
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
        <div className={css({ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '4' })}>
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
            <Label htmlFor={id}>{label}</Label>
            <p id={describedBy} className={css({ textStyle: 'body', color: 'text-muted' })}>
              {description}
            </p>
            {configPath}
          </div>
          <Switch
            id={id}
            aria-describedby={describedBy}
            checked={value === true}
            onCheckedChange={(checked) => onChange(checked)}
          />
        </div>
        {mismatch}
      </div>
    );
  }
  const errorText =
    error === undefined ? null : (
      <p className={css({ textStyle: 'body', color: 'error-text' })}>
        {t(`harness.errors.${error.key}`, { min: error.limit, max: error.limit })}
      </p>
    );
  if (field.kind === 'select') {
    return (
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
        <div
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: '2',
            md: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: '6' },
          })}
        >
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
            <Label htmlFor={id}>{label}</Label>
            <p id={describedBy} className={css({ textStyle: 'body', color: 'text-muted' })}>
              {description}
            </p>
            {configPath}
          </div>
          <Select
            id={id}
            aria-label={label}
            aria-describedby={describedBy}
            className={css({ md: { width: '224px' } })}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onChange(event.target.value)}
          >
            {field.options?.map((option) => (
              <option key={option} value={option}>
                {t(
                  `harness.fields.${field.key}.options.${option}` as 'harness.fields.send_empty_text_strategy.options.reject',
                )}
              </option>
            ))}
          </Select>
        </div>
        {errorText}
        {mismatch}
      </div>
    );
  }
  if (field.kind === 'lines') {
    return (
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
          <Label htmlFor={id}>{label}</Label>
          <p id={describedBy} className={css({ textStyle: 'body', color: 'text-muted' })}>
            {description}
          </p>
          {configPath}
        </div>
        <Textarea
          id={id}
          aria-describedby={describedBy}
          aria-invalid={error !== undefined}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
        />
        {errorText}
        {mismatch}
      </div>
    );
  }
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
      <div
        className={css({
          display: 'flex',
          flexDirection: 'column',
          gap: '2',
          md: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: '6' },
        })}
      >
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
          <Label htmlFor={id}>{label}</Label>
          <p id={describedBy} className={css({ textStyle: 'body', color: 'text-muted' })}>
            {description}
          </p>
          {configPath}
        </div>
        <Input
          id={id}
          className={css({ md: { width: '176px', flexShrink: '0' } })}
          inputMode={field.kind === 'ratio' ? 'decimal' : 'numeric'}
          aria-describedby={describedBy}
          aria-invalid={error !== undefined}
          placeholder={field.nullable === true ? t('harness.noLimitPlaceholder') : undefined}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      {errorText}
      {mismatch}
    </div>
  );
}
