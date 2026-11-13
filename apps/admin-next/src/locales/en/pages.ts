import { admins } from './pages/admins.ts';
import { alarms } from './pages/alarms.ts';
import { apiKeys } from './pages/api-keys.ts';
import { auth } from './pages/auth.ts';
import { chats } from './pages/chats.ts';
import { groupMemories } from './pages/group-memories.ts';
import { memories } from './pages/memories.ts';
import { overview } from './pages/overview.ts';
import { passkeys } from './pages/passkeys.ts';
import { preferences } from './pages/preferences.ts';
import { prompts } from './pages/prompts.ts';
import { recurringAlarms } from './pages/recurring-alarms.ts';
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
  groupMemories,
  apiKeys,
  admins,
  alarms,
  recurringAlarms,
  prompts,
  passkeys,
  preferences,
  telegram,
  warnings,
};
