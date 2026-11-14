import type { Catalog } from '../../catalog.ts';
import type { admins as adminsEn } from '../../en/pages/admins.ts';

/** Mirrors `en/pages/admins.ts` key for key. */
export const admins: Catalog<typeof adminsEn> = {
  adminAdded: 'Bot-Administrator hinzugefügt',
  adminRemoved: 'Bot-Administrator entfernt',
  colTelegramUserId: 'Telegram-Benutzer-ID',
  colActions: 'Aktionen',
  invalidUserId: 'Eine Telegram-Benutzer-ID mit 1–15 Ziffern eingeben.',
  addAdmin: 'Bot-Administrator hinzufügen',
  loadingAdmins: 'Bot-Administratoren werden geladen…',
  emptyAdmins: 'Keine Bot-Administratoren konfiguriert.',
  addTitle: 'Bot-Administrator hinzufügen',
  addDescription: 'Die numerische Telegram-Benutzer-ID des Kontos eingeben, das den Bot steuern darf.',
  userIdLabel: 'Telegram-Benutzer-ID',
  userIdPlaceholder: 'z. B. 123456789',
  adding: 'Wird hinzugefügt…',
  add: 'Hinzufügen',
  remove: 'Entfernen',
  removeTitle: 'Administrator {{id}} entfernen?',
  removeDescription: 'Diese Person kann keine Bot-Befehle mehr ausführen. Die Änderung wirkt sofort.',
  removeConfirm: 'Administrator entfernen',
};
