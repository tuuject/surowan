export const groupMemories = {
  alertTitle: 'Generated group memory',
  alertDescription:
    'These dated events are produced by the sleeping worker, not the Memo Pad. Each row cites an inclusive Telegram message-id range; <code>View source</code> replays the stored messages. Editing changes only the summary. Deleting a row does not rewind the consolidation watermark, so the same range is not regenerated.',
  colDay: 'Day',
  colChat: 'Chat',
  colSummary: 'Summary',
  colRange: 'Messages',
  colCreated: 'Created',
  colActions: 'Actions',
  searchPlaceholder: 'Search summary',
  dayFilter: 'Filter by day',
  empty: 'No group memories matched.',
  viewSource: 'View source',
  editTitle: 'Edit group memory',
  editDescription:
    'The summary is the first disclosure layer. Keep it short and factual; the message-id range stays as the citation for the original discussion.',
  summaryLabel: 'Summary',
  updated: 'Group memory updated',
  deleted: 'Group memory deleted',
  deleteTitle: 'Delete this group memory?',
  deleteDescription:
    "The event disappears from the model's recall results. The source messages and the consolidation watermark are unchanged, so this range will not be summarized again.",
  deleteConfirm: 'Delete group memory',
  sourceTitle: 'Original messages',
  sourceDescription: 'Messages {{first}}–{{last}}, capped for display.',
  close: 'Close',
};
