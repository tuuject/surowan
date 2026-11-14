/**
 * Models area: the models page and its component cluster, the settings page,
 * and the developer page. English is the source catalog, split by topic so no
 * one file outgrows what an agent can read at once; this module only composes
 * them into the tree every other locale mirrors.
 */

import { picker, drafts, edit, compat, shared } from './catalog.ts';
import { headers, connection, wizard } from './connection.ts';
import { developer } from './developer.ts';
import { feedback, match, source, switchConfirm, validation } from './notes.ts';
import { page, restart } from './page.ts';
import { roles, kind, apiFormat, modality, toolModel } from './roles.ts';
import { settings } from './settings.ts';

export const models = {
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
