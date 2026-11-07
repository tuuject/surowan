import { useQuery } from '@tanstack/react-query';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Textarea } from '@tuuject/koi-react/textarea';
import { useTranslation } from 'react-i18next';
import { MonoValue } from '@/components/business';
import type { MemoryEntry } from '@/lib/api/memories.ts';
import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import {
  formatTtl,
  MEMORY_DETAIL_MAX_LENGTH,
  MEMORY_SUMMARY_MAX_LENGTH,
  TTL_MAX_DAYS,
  TTL_MIN_DAYS,
} from '@/lib/memory-ttl';
import { memoryChatsQuery } from '@/lib/queries';
import { MemoryDetail } from './memories-detail.tsx';
import type { MemoryFormErrors, MemoryFormValues } from './memories-form.ts';
import { MemoryStatus } from './memories-status.tsx';

const FORM_ID = 'memory-form';

const s = {
  detailLabel: css({ color: 'text-muted', whiteSpace: 'nowrap' }),
  detailValue: css({ margin: '0', minWidth: '0', overflowWrap: 'anywhere' }),
};

/**
 * One dialog for creating and editing: the Dialog stays mounted and the page
 * keeps `open` apart from the values it shows, so the content doesn't vanish
 * while the exit fade plays (Koi admin template).
 */
export function MemoryFormDialog({
  open,
  editing,
  values,
  errors,
  pending,
  error,
  onOpenChange,
  onChange,
  onSubmit,
}: {
  readonly open: boolean;
  /** The entry being edited; null creates a new memo in a chosen chat. */
  readonly editing: MemoryEntry | null;
  readonly values: MemoryFormValues;
  readonly errors: MemoryFormErrors;
  readonly pending: boolean;
  readonly error: unknown;
  readonly onOpenChange: (open: boolean) => void;
  readonly onChange: (patch: Partial<MemoryFormValues>) => void;
  readonly onSubmit: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const chats = useQuery({ ...memoryChatsQuery, enabled: open && editing === null });
  const chatOptions = (chats.data?.items ?? []).map((chat) => ({
    value: chat.telegram_chat_id,
    label: `${chat.title ?? chat.telegram_chat_id}（${chat.type}${chat.username === null ? '' : ` @${chat.username}`}）`,
  }));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) {
          return;
        }
        onOpenChange(next);
      }}
      size="md"
      title={editing === null ? t('pages.memories.createTitle') : t('pages.memories.editTitle', { id: editing.id })}
      description={editing === null ? t('pages.memories.createDescription') : t('pages.memories.editDescription')}
      footer={
        <>
          <Button variant="ghost" color="secondary" disabled={pending} onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            form={FORM_ID}
            loading={pending}
            loadingLabel={editing === null ? t('pages.memories.creating') : t('common.saving')}
          >
            {editing === null ? t('common.create') : t('common.save')}
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        noValidate
        className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        {editing === null ? (
          <Field
            label={t('pages.memories.chatLabel')}
            error={errors.chat_id ?? (chats.isError ? errorMessage(chats.error) : undefined)}
            {...(chats.isPending ? { help: t('pages.memories.loadingChatOptions') } : {})}
          >
            <Select
              placeholder={t('pages.memories.selectChat')}
              value={values.chat_id}
              onChange={(event) => onChange({ chat_id: event.target.value })}
              options={chatOptions}
            />
          </Field>
        ) : null}
        <Field
          label={t('pages.memories.summaryLabel')}
          help={`${values.summary.length} / ${MEMORY_SUMMARY_MAX_LENGTH}`}
          error={errors.summary}
        >
          <Input
            maxLength={MEMORY_SUMMARY_MAX_LENGTH}
            value={values.summary}
            onChange={(event) => onChange({ summary: event.target.value })}
          />
        </Field>
        <Field label={t('pages.memories.detailLabel')} help={t('pages.memories.detailHint')} error={errors.detail}>
          <Textarea
            rows={6}
            maxLength={MEMORY_DETAIL_MAX_LENGTH}
            value={values.detail}
            onChange={(event) => onChange({ detail: event.target.value })}
          />
        </Field>
        <Field
          label={t('pages.memories.ttlLabel')}
          help={editing === null ? t('pages.memories.ttlHint') : t('pages.memories.editTtlHint')}
          error={errors.ttl_days}
        >
          <Input
            type="number"
            inputMode="numeric"
            min={TTL_MIN_DAYS}
            max={TTL_MAX_DAYS}
            step={1}
            value={values.ttl_days}
            onChange={(event) => onChange({ ttl_days: event.target.value })}
          />
        </Field>
        {error === null ? null : (
          <p role="alert" className={css({ color: 'error-text', overflowWrap: 'anywhere' })}>
            {errorMessage(error)}
          </p>
        )}
      </form>
    </Dialog>
  );
}

export function MemoryViewDialog({
  open,
  entry,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly entry: MemoryEntry | null;
  readonly onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={t('pages.memories.viewTitle')}
      description={entry === null ? undefined : <MonoValue value={entry.id} />}
      footer={
        <Button variant="ghost" color="secondary" onClick={() => onOpenChange(false)}>
          {t('pages.memories.close')}
        </Button>
      }
      hideClose
    >
      {entry === null ? null : (
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '5' })}>
          <dl
            className={css({
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              rowGap: '2',
              columnGap: '6',
              margin: '0',
            })}
          >
            <dt className={s.detailLabel}>{t('pages.memories.colChat')}</dt>
            <dd className={s.detailValue}>
              {entry.chat.title ?? entry.chat.telegram_chat_id}（{entry.chat.telegram_chat_id}）
            </dd>
            <dt className={s.detailLabel}>{t('pages.memories.colStatus')}</dt>
            <dd className={s.detailValue}>
              <MemoryStatus row={entry} />
            </dd>
            <dt className={s.detailLabel}>{t('pages.memories.colCreated')}</dt>
            <dd className={s.detailValue}>{formatTime(entry.created_at)}</dd>
            <dt className={s.detailLabel}>{t('pages.memories.colExpires')}</dt>
            <dd className={s.detailValue}>
              {entry.expires_at === null ? t('pages.memories.permanent') : formatTime(entry.expires_at)}
            </dd>
            <dt className={s.detailLabel}>{t('pages.memories.colTtl')}</dt>
            <dd className={s.detailValue}>
              {entry.ttl_seconds === null ? t('pages.memories.permanent') : formatTtl(entry.ttl_seconds)}
            </dd>
            <dt className={s.detailLabel}>{t('pages.memories.summaryLabel')}</dt>
            <dd className={s.detailValue}>{entry.summary}</dd>
          </dl>
          <section className={css({ display: 'flex', flexDirection: 'column', gap: '2' })}>
            <h3 className={css({ textStyle: 'heading-3', margin: '0' })}>{t('pages.memories.detailLabel')}</h3>
            <MemoryDetail detail={entry.detail} />
          </section>
        </div>
      )}
    </Dialog>
  );
}
