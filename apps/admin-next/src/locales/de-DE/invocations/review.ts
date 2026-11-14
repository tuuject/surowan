import type { Catalog } from '../../catalog.ts';
import type { review as reviewEn } from '../../en/invocations/review.ts';

/** Mirrors `en/invocations/review.ts` key for key. */
export const review: Catalog<typeof reviewEn> = {
  addComment: 'Bewertungskommentar hinzufügen',
  commentLabel: 'Bewertungskommentar',
  commentPlaceholder: 'Kommentar zu diesem Ereignis schreiben…',
  overallComment: 'Gesamtkommentar',
  addOverallComment: 'Gesamtkommentar hinzufügen',
  overallPlaceholder: 'Gesamtkommentar zu diesem Aufruf schreiben…',
  panelTitle: 'Bewertungsnotizen',
  thisInvocationCount_one: '{{count}} Kommentar zu diesem Aufruf',
  thisInvocationCount_other: '{{count}} Kommentare zu diesem Aufruf',
  draftInvocationsCount_one: '{{count}} Aufruf im Bewertungsentwurf',
  draftInvocationsCount_other: '{{count}} Aufrufe im Bewertungsentwurf',
  openDraft: 'Bewertungsentwurf öffnen',
  browserOnlyNote: 'Bewertungsentwürfe werden nur in diesem Browser gespeichert und nie hochgeladen.',
  emptyTitle: 'Noch keine Bewertungskommentare',
  emptyDescription:
    'Öffnen Sie einen Aufruf und kommentieren Sie Ereignisse in der Übersicht oder fügen Sie einen Gesamtkommentar hinzu.',
  browseInvocations: 'Tool-Sitzungen durchsuchen',
  exportPanelTitle: 'Export- und Prompt-Einstellungen',
  purposeLabel: 'Zweck',
  purposeTune: 'Diesen Bot abstimmen',
  purposeDevelop: 'Entwickler-Feedback',
  goalLabel: 'Ziel',
  goalHelp: 'Optionales Gesamtziel für den exportierten Prompt (bis zu 4.000 Zeichen).',
  goalPlaceholder: 'Beschreiben Sie, was insgesamt verbessert werden soll…',
  copyMarkdown: 'Markdown kopieren',
  downloadMarkdown: 'Markdown herunterladen',
  previewMarkdown: 'Markdown-Vorschau',
  clearDraft: 'Entwurf leeren',
  removeInvocation: 'Aus Entwurf entfernen',
  commentCount_one: '{{count}} Kommentar',
  commentCount_other: '{{count}} Kommentare',
  kinds: {
    tool_call: 'Tool-Aufruf',
    agent_message: 'Agent-Nachricht',
    model_call: 'Modellaufruf',
    context_message: 'Eingehende Nachricht',
  },
  eventLabels: {
    toolCall: 'Tool-Aufruf {{name}}',
    modelCall: 'Modellaufruf {{model}} (Versuch {{attempt}})',
    contextMessage: 'Nachricht von {{sender}}',
  },
  exportConfirmTitle: 'Exportieren und Entwurf leeren',
  exportConfirmDescription:
    'Der Bewertungsentwurf wird nach dem Export aus diesem Browser entfernt. Bewahren Sie die exportierte Markdown-Datei auf, da ein erneuter Import noch nicht unterstützt wird.',
  exportConfirmButton: 'Exportieren und leeren',
  exportedAndCleared: 'Exportiert; Bewertungsentwurf geleert',
  copiedDraftChanged: 'Kopiert, aber der Entwurf wurde während des Exports geändert und daher nicht geleert',
  copyFailed: 'Markdown konnte nicht in die Zwischenablage kopiert werden',
  storageSaveFailed:
    'Der Bewertungsentwurf konnte in diesem Browser nicht gespeichert werden; er bleibt nur bis zum Schließen dieses Tabs erhalten',
  clearConfirmTitle: 'Bewertungsentwurf leeren',
  clearConfirmDescription:
    'Alle Bewertungskommentare, Gesamtkommentare und das Ziel aus diesem Browser entfernen? Dies kann nicht rückgängig gemacht werden.',
  clearConfirmButton: 'Entwurf leeren',
  draftCleared: 'Bewertungsentwurf geleert',
};
