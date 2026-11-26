import type { Catalog } from '../../catalog.ts';
import type { chat as chatEn } from '../../en/invocations/chat.ts';

/** Mirrors `en/invocations/chat.ts` key for key. */
export const chat: Catalog<typeof chatEn> = {
  batch: 'Nachrichten eingereiht',
  batchPending: 'Nachrichten eingereiht, noch nicht gelesen',
  batchSkipped: 'Nachrichten eingereiht, nicht an das Modell übergeben',
  finished: 'Aufruf beendet',
  history_one: '{{count}} frühere Nachricht im Kontext',
  history_other: '{{count}} frühere Nachrichten im Kontext',
  summaryTools_one: '{{count}} Tool-Aufruf',
  summaryTools_other: '{{count}} Tool-Aufrufe',
  summarySkills_one: '{{count}} Skill',
  summarySkills_other: '{{count}} Skills',
  summaryFailedModelCalls_one: '{{count}} fehlgeschlagener Modellaufruf',
  summaryFailedModelCalls_other: '{{count}} fehlgeschlagene Modellaufrufe',
  summaryPrivateTexts_one: '{{count}} private Notiz',
  summaryPrivateTexts_other: '{{count}} private Notizen',
  summarySteps_one: '{{count}} Schritt',
  summarySteps_other: '{{count}} Schritte',
  summarySeparator: ', ',
  skill: 'Skill <name>{{name}}</name> verwendet',
  tool: 'Tool <name>{{name}}</name> verwendet',
  toolSearch: 'Tools nach „{{query}}“ durchsucht',
  toolHelp: 'Anleitung für <name>{{name}}</name> gelesen',
  modelCall: 'Modellaufruf <name>{{name}}</name>',
  toolDetails: 'Tool-Details',
  image: 'Generiertes Bild',
  file: 'Datei',
};
