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
import { telegram } from './pages/telegram.ts';
import { warnings } from './pages/warnings.ts';

/**
 * Audit and configuration pages: overview, auth, chats, stickers, memories,
 * admins, alarms. English is the source catalog; `zh-CN/pages.ts` mirrors it
 * key for key.
 */
export const pages = {
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
  telegram,
  warnings,
};
