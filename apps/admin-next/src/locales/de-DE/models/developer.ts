export const developer = {
  debugTitle: 'Debug-Nutzdaten',
  debugDescription: 'Nur zur Untersuchung von Modellaufrufen aktivieren.',
  recordLabel: 'Rohdaten der Anfragen zur Fehlersuche aufzeichnen',
  recordDescription:
    'Speichert Anfragen und Antworten der Modellaufrufe für Fehlersuche und Wiedergabe auf der Aufrufseite. Kann viel Datenbankspeicher belegen.',
  recordHint:
    'Standardmäßig aus. Änderungen gelten für neue Modellaufrufe; Ausschalten löscht bestehende Nutzdaten nicht.',
  thinkingLabel: 'Denken des Modells aufzeichnen',
  thinkingDescription:
    'Speichert das Denken des Modells separat, damit es im Transkript und in der Zeitlinie aufgeklappt werden kann. Braucht mehr Datenbankspeicher.',
  thinkingHint: 'Standardmäßig aus. Gilt für Modellantworten ab jetzt.',
  stateMismatch:
    'Die Dateieinstellung weicht vom laufenden Zustand ab ({{status}}). Die Konfigurationsdatei auf der Seite „Einstellungen“ anwenden.',
  historyTitle: 'Verlauf der Nutzdaten',
  historyDescription:
    'Gespeicherte Modellanfragen und -antworten löschen. Andere Prüfdatensätze bleiben erhalten; betroffene Aufrufe lassen sich nicht mehr wiedergeben.',
  clearButton: 'Nutzdaten löschen',
  cleared: 'Debug-Nutzdaten für {{count}} Modellaufrufe gelöscht.',
  confirmTitle: 'Zuvor aufgezeichnete Rohdaten der Anfragen löschen?',
  confirmDescription:
    'Das lässt sich nicht rückgängig machen. Modellanfragen und -antworten werden gelöscht, andere Prüfdatensätze bleiben; betroffene Aufrufe lassen sich nicht mehr wiedergeben.',
  confirmClear: 'Löschen bestätigen',
  modelsDevTitle: 'Quelle der Modelldetails',
  modelsDevDescription:
    'Wo Kontextlänge, maximale Ausgabe, akzeptierte Eingabe und Preise nachgeschlagen werden, wenn Modelle auf der Seite „Anbieter“ hinzugefügt werden.',
  modelsDevLabel: 'Adresse des Katalogs',
  modelsDevHint:
    'Leer lassen, um {{url}} zu verwenden. Ein Mirror muss dasselbe Format liefern. Gilt für das nächste Nachschlagen.',
  modelsDevReset: 'Standard verwenden',
  modelsDevMismatch:
    'Die Dateieinstellung weicht vom laufenden Zustand ab, der weiterhin {{url}} abfragt. Die Konfigurationsdatei auf der Seite „Einstellungen“ anwenden.',
};
