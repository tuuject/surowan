/**
 * Rows only the documentation screenshots need, seeded after the shared fixture
 * has been localized.
 *
 * The group Chat exists for every docs spec file, because the allowlist shot and
 * the per-Chat dialogs are spread across files. The two runs (a resumable
 * failure and a completed tool-using run) are only seeded for the spec files
 * that photograph them (`E2E_DOCS_RUNS=1`, set by `test.use({ docsRuns: true })`),
 * so the healthy overview never shows a failed run it did not ask about. Their
 * bodies live in `server-docs-failed-run.ts` and `server-docs-tool-run.ts`.
 *
 * Nothing here runs unless `E2E_SEED_LOCALE` asked for the docs seed.
 */
import type { SqliteStore } from '../../../src/adapters/local-monolith/database.ts';
import { chats, conversations } from '../../../src/store/schema/index.ts';
import { AT } from '../../../test/fixtures/admin-seed-data.ts';
import type { DocsSeedText } from './docs-locale.ts';
import { seedDocsFailedRun } from './server-docs-failed-run.ts';
import { DOCS_IDS } from './server-docs-ids.ts';
import { seedDocsToolRun } from './server-docs-tool-run.ts';

export function seedDocsChat(store: SqliteStore, text: DocsSeedText): void {
  const orm = store.orm;
  orm
    .insert(chats)
    .values({
      hostKind: 'telegram',
      id: DOCS_IDS.groupChat,
      hostChatId: DOCS_IDS.groupChatHostId,
      canonicalChatId: DOCS_IDS.groupChatHostId,
      type: 'supergroup',
      title: text.groupChatTitle,
      username: text.groupChatUsername,
      updatedAt: AT,
    })
    .run();
  orm
    .insert(conversations)
    .values({
      id: DOCS_IDS.groupConversation,
      chatId: DOCS_IDS.groupChat,
      messageThreadId: 0n,
      createdAt: AT,
      updatedAt: AT,
    })
    .run();
}

/** The two runs the Resume, Tool calls and Reviews shots photograph. */
export function seedDocsRuns(store: SqliteStore, text: DocsSeedText): void {
  seedDocsFailedRun(store, text);
  seedDocsToolRun(store, text);
}
