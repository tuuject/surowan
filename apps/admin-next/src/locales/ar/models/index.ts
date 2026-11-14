/**
 * Mirrors `en/models/` key for key, split by topic the way English is; the
 * composed annotation below fails the build on drift.
 */
import type { CompleteCatalog } from '../../catalog.ts';
import type { models as modelsEn } from '../../en/models/index.ts';

import { picker, drafts, edit, compat, shared } from './catalog.ts';
import { headers, connection, wizard } from './connection.ts';
import { developer } from './developer.ts';
import { feedback, match, source, switchConfirm, validation } from './notes.ts';
import { page, restart } from './page.ts';
import { roles, kind, apiFormat, modality, toolModel } from './roles.ts';
import { settings } from './settings.ts';

export const models: CompleteCatalog<typeof modelsEn> = {
  models: {
    page,
    restart,
    roles,
    kind,
    apiFormat,
    modality,
    toolModel,
    headers,
    connection,
    wizard,
    picker,
    drafts,
    edit,
    compat,
    shared,
    feedback,
    match,
    source,
    switchConfirm,
    validation,
  },
  settings,
  developer,
};
