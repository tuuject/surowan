import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Textarea } from '@tuuject/koi-react/textarea';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { StickerSetEntry } from '@/lib/api/stickers.ts';
import { errorMessage } from '@/lib/errors';

/** Mirrors the server: `telegram.sticker_sets[].note` and the alias pattern of the config schema. */
export const STICKER_SET_NOTE_MAX_LENGTH = 500;
const ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SET_NAME = /^[A-Za-z0-9_]{1,64}$/;
const SET_LINK = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/addstickers\/([A-Za-z0-9_]{1,64})\/?$/i;

const FORM_ID = 'sticker-set-form';

export interface StickerSetFormValues {
  readonly name: string;
  readonly alias: string;
  readonly note: string;
}

/** Which check a field failed; the dialog words it. */
export type StickerSetFormErrors = {
  readonly name?: 'invalidName';
  readonly alias?: 'invalidAlias';
  readonly note?: 'noteTooLong';
};

export const EMPTY_STICKER_SET_FORM: StickerSetFormValues = { name: '', alias: '', note: '' };

export function stickerSetFormValues(entry: StickerSetEntry): StickerSetFormValues {
  return { name: entry.telegram_name, alias: entry.alias, note: entry.note ?? '' };
}

/** The same checks the server makes, so a typo is caught before a write stops anything. */
export function validateStickerSetForm(values: StickerSetFormValues, adding: boolean): StickerSetFormErrors {
  const name = values.name.trim();
  return {
    ...(adding && !SET_NAME.test(SET_LINK.exec(name)?.[1] ?? name) ? { name: 'invalidName' as const } : {}),
    ...(ALIAS_PATTERN.test(values.alias.trim()) ? {} : { alias: 'invalidAlias' as const }),
    ...(values.note.trim().length > STICKER_SET_NOTE_MAX_LENGTH ? { note: 'noteTooLong' as const } : {}),
  };
}

export function StickerSetDialog({
  open,
  editing,
  values,
  errors,
  pending,
  error,
  onChange,
  onOpenChange,
  onSubmit,
}: {
  readonly open: boolean;
  /** The set being edited; `null` adds a new one. */
  readonly editing: StickerSetEntry | null;
  readonly values: StickerSetFormValues;
  readonly errors: StickerSetFormErrors;
  readonly pending: boolean;
  readonly error: unknown;
  readonly onChange: (patch: Partial<StickerSetFormValues>) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const adding = editing === null;
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
      title={adding ? t('pages.stickers.addTitle') : t('pages.stickers.editTitle', { alias: editing.alias })}
      description={adding ? t('pages.stickers.addDescription') : t('pages.stickers.editDescription')}
      footer={
        <>
          <Button variant="ghost" color="secondary" disabled={pending} onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            form={FORM_ID}
            loading={pending}
            loadingLabel={adding ? t('pages.stickers.adding') : t('common.saving')}
          >
            {adding ? t('pages.stickers.add') : t('common.save')}
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
        <Field
          label={t('pages.stickers.nameLabel')}
          help={adding ? t('pages.stickers.nameHelp') : t('pages.stickers.nameLocked')}
          error={errors.name === undefined ? undefined : t('pages.stickers.invalidName')}
        >
          <Input
            value={values.name}
            readOnly={!adding}
            {...(adding ? { placeholder: t('pages.stickers.namePlaceholder') } : {})}
            onChange={(event) => onChange({ name: event.target.value })}
            dir="ltr"
          />
        </Field>
        <Field
          label={t('pages.stickers.aliasLabel')}
          help={t('pages.stickers.aliasHelp')}
          error={errors.alias === undefined ? undefined : t('pages.stickers.invalidAlias')}
        >
          <Input
            value={values.alias}
            maxLength={64}
            onChange={(event) => onChange({ alias: event.target.value })}
            dir="ltr"
          />
        </Field>
        <Field
          label={t('pages.stickers.noteLabel')}
          help={`${t('pages.stickers.noteHelp')} ${values.note.trim().length} / ${STICKER_SET_NOTE_MAX_LENGTH}`}
          error={
            errors.note === undefined
              ? undefined
              : t('pages.stickers.noteTooLong', { max: STICKER_SET_NOTE_MAX_LENGTH })
          }
        >
          <Textarea
            rows={4}
            maxLength={STICKER_SET_NOTE_MAX_LENGTH}
            placeholder={t('pages.stickers.notePlaceholder')}
            value={values.note}
            onChange={(event) => onChange({ note: event.target.value })}
            dir="auto"
          />
        </Field>
        {error === null ? null : (
          <p role="alert" className={css({ margin: '0', color: 'error-text', overflowWrap: 'anywhere' })}>
            {errorMessage(error)}
          </p>
        )}
      </form>
    </Dialog>
  );
}
