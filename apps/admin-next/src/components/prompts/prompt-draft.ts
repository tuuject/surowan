import type { PromptVersionSource } from '@/lib/api/prompts.ts';
import type { BadgeSemantic } from '@/components/business';

/** What the last write reported, rendered next to the editor. */
export type Notice =
  | { readonly kind: 'saved' }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'apply_failed'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

/** The editor's own copy: text plus the file hash `Save` pins with If-Match. */
export interface PromptDraft {
  readonly hash: string;
  readonly text: string;
  readonly note: string;
}

export function sourceTone(source: PromptVersionSource): BadgeSemantic {
  switch (source) {
    case 'panel':
      return 'info';
    case 'rollback':
      return 'neutral';
    case 'external':
      return 'warning';
  }
}

export function sourceLabelKey(
  source: PromptVersionSource,
): 'pages.prompts.sourcePanel' | 'pages.prompts.sourceExternal' | 'pages.prompts.sourceRollback' {
  switch (source) {
    case 'panel':
      return 'pages.prompts.sourcePanel';
    case 'rollback':
      return 'pages.prompts.sourceRollback';
    case 'external':
      return 'pages.prompts.sourceExternal';
  }
}
