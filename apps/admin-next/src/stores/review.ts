import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import i18next from '@/lib/i18n.ts';
import {
  REVIEW_TEXT_MAX_CHARS,
  type ReviewComment,
  type ReviewDraftData,
  type ReviewedInvocation,
  type ReviewedInvocationMeta,
  type ReviewEventKind,
  type ReviewPurpose,
  truncateExcerpt,
} from '@/lib/review-export.ts';
import { toast } from '@/lib/toast.ts';

export const REVIEW_STORAGE_KEY = 'surowan-admin-review';
export const REVIEW_STORAGE_VERSION = 1;

const VALID_KINDS = new Set<ReviewEventKind>(['tool_call', 'agent_message', 'model_call', 'context_message']);

const EMPTY_DRAFT: ReviewDraftData = {
  goal: '',
  purpose: 'tune',
  invocations: {},
};

let hasUnsavedMemoryChanges = false;
let storageFailureWarned = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeReviewComment(anchorKey: string, raw: unknown): ReviewComment | null {
  if (!isRecord(raw)) {
    return null;
  }
  const anchor = typeof raw.anchor === 'string' && raw.anchor.length > 0 ? raw.anchor : anchorKey;
  if (anchor.length === 0) {
    return null;
  }
  const kind = raw.kind;
  if (typeof kind !== 'string' || !VALID_KINDS.has(kind as ReviewEventKind)) {
    return null;
  }
  const eventKind = kind as ReviewEventKind;
  if (typeof raw.subject !== 'string') {
    return null;
  }
  if (eventKind !== 'context_message' && raw.subject.trim().length === 0) {
    return null;
  }
  const attempt =
    eventKind === 'model_call'
      ? typeof raw.attempt === 'number' && Number.isFinite(raw.attempt) && raw.attempt >= 1
        ? Math.trunc(raw.attempt)
        : 1
      : null;
  if (typeof raw.ref !== 'string' || raw.ref.length === 0) {
    return null;
  }
  if (typeof raw.text !== 'string') {
    return null;
  }
  const text = raw.text.slice(0, REVIEW_TEXT_MAX_CHARS).trim();
  if (text.length === 0) {
    return null;
  }
  const at = typeof raw.at === 'string' ? raw.at : '';
  const position = typeof raw.position === 'number' && Number.isFinite(raw.position) ? raw.position : 0;
  const excerpt = typeof raw.excerpt === 'string' ? truncateExcerpt(raw.excerpt) : null;
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : '';
  return {
    anchor,
    kind: eventKind,
    subject: raw.subject,
    attempt,
    ref: raw.ref,
    at,
    position,
    excerpt,
    text,
    updatedAt,
  };
}

function sanitizeReviewedInvocation(idKey: string, raw: unknown): ReviewedInvocation | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : idKey;
  if (id.length === 0) {
    return null;
  }
  const chatLabel = typeof raw.chatLabel === 'string' && raw.chatLabel.length > 0 ? raw.chatLabel : id;
  const hostKind = raw.hostKind === 'playground' ? 'playground' : 'telegram';
  const chatRef = typeof raw.chatRef === 'string' && raw.chatRef.length > 0 ? raw.chatRef : null;
  const topicId = typeof raw.topicId === 'number' && Number.isFinite(raw.topicId) ? raw.topicId : 0;
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : '';
  const overall = typeof raw.overall === 'string' ? raw.overall.slice(0, REVIEW_TEXT_MAX_CHARS).trim() : '';

  const comments: Record<string, ReviewComment> = {};
  if (isRecord(raw.comments)) {
    for (const [anchorKey, commentValue] of Object.entries(raw.comments)) {
      const sanitized = sanitizeReviewComment(anchorKey, commentValue);
      if (sanitized !== null) {
        comments[sanitized.anchor] = sanitized;
      }
    }
  }

  if (overall.length === 0 && Object.keys(comments).length === 0) {
    return null;
  }

  return {
    id,
    chatLabel,
    hostKind,
    chatRef,
    topicId,
    createdAt,
    overall,
    comments,
  };
}

export function sanitizeReviewDraft(raw: unknown): ReviewDraftData {
  if (!isRecord(raw)) {
    return EMPTY_DRAFT;
  }
  const goal = typeof raw.goal === 'string' ? raw.goal.slice(0, REVIEW_TEXT_MAX_CHARS) : '';
  const purpose: ReviewPurpose = raw.purpose === 'develop' ? 'develop' : 'tune';
  const invocations: Record<string, ReviewedInvocation> = {};
  if (isRecord(raw.invocations)) {
    for (const [idKey, invocationValue] of Object.entries(raw.invocations)) {
      const sanitized = sanitizeReviewedInvocation(idKey, invocationValue);
      if (sanitized !== null) {
        invocations[sanitized.id] = sanitized;
      }
    }
  }
  return {
    goal,
    purpose,
    invocations,
  };
}

function pruneInvocationIfEmpty(
  invocations: Readonly<Record<string, ReviewedInvocation>>,
  invocation: ReviewedInvocation,
): Record<string, ReviewedInvocation> {
  const next = { ...invocations };
  if (invocation.overall.trim().length === 0 && Object.keys(invocation.comments).length === 0) {
    delete next[invocation.id];
  } else {
    next[invocation.id] = invocation;
  }
  return next;
}

export interface ReviewState extends ReviewDraftData {
  setGoal: (goal: string) => void;
  setPurpose: (purpose: ReviewPurpose) => void;
  saveOverallComment: (meta: ReviewedInvocationMeta, text: string) => void;
  updateOverallComment: (invocationId: string, text: string) => void;
  saveEventComment: (
    meta: ReviewedInvocationMeta,
    comment: Omit<ReviewComment, 'text' | 'updatedAt'>,
    text: string,
  ) => void;
  updateEventComment: (invocationId: string, anchor: string, text: string) => void;
  deleteEventComment: (invocationId: string, anchor: string) => void;
  removeInvocation: (invocationId: string) => void;
  clearDraft: () => void;
}

function syncFromStorageBeforeWrite(): void {
  if (!hasUnsavedMemoryChanges) {
    void useReviewStore.persist.rehydrate();
  }
}

export const useReviewStore = create<ReviewState>()(
  persist(
    (set) => ({
      ...EMPTY_DRAFT,
      setGoal: (goal) => {
        syncFromStorageBeforeWrite();
        set({ goal: goal.slice(0, REVIEW_TEXT_MAX_CHARS) });
      },
      setPurpose: (purpose) => {
        syncFromStorageBeforeWrite();
        set({ purpose: purpose === 'develop' ? 'develop' : 'tune' });
      },
      saveOverallComment: (meta, text) => {
        syncFromStorageBeforeWrite();
        const normalized = text.slice(0, REVIEW_TEXT_MAX_CHARS).trim();
        set((state) => {
          const existing = state.invocations[meta.id];
          const updated: ReviewedInvocation = {
            id: meta.id,
            chatLabel: meta.chatLabel,
            hostKind: meta.hostKind,
            chatRef: meta.chatRef,
            topicId: meta.topicId,
            createdAt: meta.createdAt,
            overall: normalized,
            comments: existing?.comments ?? {},
          };
          return {
            invocations: pruneInvocationIfEmpty(state.invocations, updated),
          };
        });
      },
      updateOverallComment: (invocationId, text) => {
        syncFromStorageBeforeWrite();
        const normalized = text.slice(0, REVIEW_TEXT_MAX_CHARS).trim();
        set((state) => {
          const existing = state.invocations[invocationId];
          if (existing === undefined) {
            return state;
          }
          const updated: ReviewedInvocation = {
            ...existing,
            overall: normalized,
          };
          return {
            invocations: pruneInvocationIfEmpty(state.invocations, updated),
          };
        });
      },
      saveEventComment: (meta, commentMeta, text) => {
        syncFromStorageBeforeWrite();
        const normalized = text.slice(0, REVIEW_TEXT_MAX_CHARS).trim();
        set((state) => {
          const existing = state.invocations[meta.id];
          const nextComments = { ...(existing?.comments ?? {}) };
          if (normalized.length === 0) {
            delete nextComments[commentMeta.anchor];
          } else {
            nextComments[commentMeta.anchor] = {
              ...commentMeta,
              text: normalized,
              updatedAt: new Date().toISOString(),
            };
          }
          const updated: ReviewedInvocation = {
            id: meta.id,
            chatLabel: meta.chatLabel,
            hostKind: meta.hostKind,
            chatRef: meta.chatRef,
            topicId: meta.topicId,
            createdAt: meta.createdAt,
            overall: existing?.overall ?? '',
            comments: nextComments,
          };
          return {
            invocations: pruneInvocationIfEmpty(state.invocations, updated),
          };
        });
      },
      updateEventComment: (invocationId, anchor, text) => {
        syncFromStorageBeforeWrite();
        const normalized = text.slice(0, REVIEW_TEXT_MAX_CHARS).trim();
        set((state) => {
          const existing = state.invocations[invocationId];
          if (existing === undefined) {
            return state;
          }
          const currentComment = existing.comments[anchor];
          if (currentComment === undefined) {
            return state;
          }
          const nextComments = { ...existing.comments };
          if (normalized.length === 0) {
            delete nextComments[anchor];
          } else {
            nextComments[anchor] = {
              ...currentComment,
              text: normalized,
              updatedAt: new Date().toISOString(),
            };
          }
          const updated: ReviewedInvocation = {
            ...existing,
            comments: nextComments,
          };
          return {
            invocations: pruneInvocationIfEmpty(state.invocations, updated),
          };
        });
      },
      deleteEventComment: (invocationId, anchor) => {
        syncFromStorageBeforeWrite();
        set((state) => {
          const existing = state.invocations[invocationId];
          if (existing === undefined || !(anchor in existing.comments)) {
            return state;
          }
          const nextComments = { ...existing.comments };
          delete nextComments[anchor];
          const updated: ReviewedInvocation = {
            ...existing,
            comments: nextComments,
          };
          return {
            invocations: pruneInvocationIfEmpty(state.invocations, updated),
          };
        });
      },
      removeInvocation: (invocationId) => {
        syncFromStorageBeforeWrite();
        set((state) => {
          if (!(invocationId in state.invocations)) {
            return state;
          }
          const next = { ...state.invocations };
          delete next[invocationId];
          return { invocations: next };
        });
      },
      clearDraft: () => set({ ...EMPTY_DRAFT }),
    }),
    {
      name: REVIEW_STORAGE_KEY,
      version: REVIEW_STORAGE_VERSION,
      storage: {
        getItem: (name) => {
          if (typeof window === 'undefined') {
            return null;
          }
          let raw: string | null;
          try {
            raw = window.localStorage.getItem(name);
          } catch {
            // Storage access itself threw: keep current in-memory state.
            return null;
          }
          if (raw === null) {
            return { state: EMPTY_DRAFT, version: REVIEW_STORAGE_VERSION };
          }
          try {
            const parsed: unknown = JSON.parse(raw);
            if (!isRecord(parsed)) {
              return { state: EMPTY_DRAFT, version: REVIEW_STORAGE_VERSION };
            }
            return {
              state: sanitizeReviewDraft(parsed.state),
              version: REVIEW_STORAGE_VERSION,
            };
          } catch {
            return { state: EMPTY_DRAFT, version: REVIEW_STORAGE_VERSION };
          }
        },
        setItem: (name, value) => {
          if (typeof window === 'undefined') {
            return;
          }
          try {
            window.localStorage.setItem(name, JSON.stringify(value));
            hasUnsavedMemoryChanges = false;
            storageFailureWarned = false;
          } catch {
            hasUnsavedMemoryChanges = true;
            if (!storageFailureWarned) {
              storageFailureWarned = true;
              toast.error(i18next.t('invocations.review.storageSaveFailed'));
            }
          }
        },
        removeItem: (name) => {
          if (typeof window === 'undefined') {
            return;
          }
          try {
            window.localStorage.removeItem(name);
            hasUnsavedMemoryChanges = false;
            storageFailureWarned = false;
          } catch {
            // Ignore blocked storage errors.
          }
        },
      },
      partialize: (state): ReviewDraftData => ({
        goal: state.goal,
        purpose: state.purpose,
        invocations: state.invocations,
      }),
      migrate: (persistedState) => sanitizeReviewDraft(persistedState),
      merge: (persistedState, currentState) => {
        if (persistedState === undefined) {
          return currentState;
        }
        return {
          ...currentState,
          ...sanitizeReviewDraft(persistedState),
        };
      },
    },
  ),
);

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (!hasUnsavedMemoryChanges && (event.key === REVIEW_STORAGE_KEY || event.key === null)) {
      void useReviewStore.persist.rehydrate();
    }
  });
}
