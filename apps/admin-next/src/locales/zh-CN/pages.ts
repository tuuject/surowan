import type { pages as pagesEn } from '../en/pages.ts';
import { admins } from './pages/admins.ts';
import { alarms } from './pages/alarms.ts';
import { apiKeys } from './pages/api-keys.ts';
import { auth } from './pages/auth.ts';
import { chats } from './pages/chats.ts';
import { memories } from './pages/memories.ts';
import { overview } from './pages/overview.ts';
import { passkeys } from './pages/passkeys.ts';
import { preferences } from './pages/preferences.ts';
import { prompts } from './pages/prompts.ts';
import { stickers } from './pages/stickers.ts';

/** Mirrors `en/pages.ts` key for key; the annotation fails the build on drift. */
export const pages: typeof pagesEn = {
  overview,
  auth,
  chats,
  stickers,
  memories,
  apiKeys,
  admins,
  alarms,
  prompts,
  passkeys,
  preferences,
};
