import type { TFunction } from 'i18next';
import {
  isTtlDaysValid,
  MEMORY_DETAIL_MAX_LENGTH,
  MEMORY_SUMMARY_MAX_LENGTH,
  TTL_MAX_DAYS,
  TTL_MIN_DAYS,
} from '@/lib/memory-ttl';

export interface MemoryFormValues {
  readonly chat_id: string;
  readonly summary: string;
  readonly detail: string;
  readonly ttl_days: string;
}

export interface MemoryFormErrors {
  chat_id?: string;
  summary?: string;
  detail?: string;
  ttl_days?: string;
}

export const EMPTY_FORM: MemoryFormValues = { chat_id: '', summary: '', detail: '', ttl_days: '' };

export function validateMemoryForm(values: MemoryFormValues, editing: boolean, t: TFunction): MemoryFormErrors {
  const errors: MemoryFormErrors = {};
  if (!editing && values.chat_id.length === 0) {
    errors.chat_id = t('pages.memories.chatRequired');
  }
  if (values.summary.trim().length === 0) {
    errors.summary = t('pages.memories.summaryRequired');
  } else if (values.summary.length > MEMORY_SUMMARY_MAX_LENGTH) {
    errors.summary = t('pages.memories.summaryTooLong', { count: MEMORY_SUMMARY_MAX_LENGTH });
  }
  if (values.detail.trim().length === 0) {
    errors.detail = t('pages.memories.detailRequired');
  } else if (values.detail.length > MEMORY_DETAIL_MAX_LENGTH) {
    errors.detail = t('pages.memories.detailTooLong', { count: MEMORY_DETAIL_MAX_LENGTH });
  }
  if (values.ttl_days.trim().length > 0 && !isTtlDaysValid(Number(values.ttl_days))) {
    errors.ttl_days = t('pages.memories.ttlInvalid', { min: TTL_MIN_DAYS, max: TTL_MAX_DAYS });
  }
  return errors;
}
