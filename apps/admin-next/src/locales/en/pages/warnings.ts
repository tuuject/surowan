/**
 * Pages `warnings` group. English is the source catalog; `zh-CN/pages/warnings.ts`
 * mirrors it key for key.
 */
export const warnings = {
  standingTitle: 'Standing warnings',
  eventsTitle: 'Event warnings',
  unreadCount: '{{count}} unread',
  unread: 'Unread',
  standing: 'Standing',
  markRead: 'Mark read',
  markedRead: 'Warning marked read',
  clearHistory: 'Clear warning history',
  clearTitle: 'Clear all event warnings?',
  clearDescription:
    'Every event warning, read or unread, is deleted. Standing warnings remain while their conditions are true. This cannot be undone.',
  clearConfirm: 'Clear warnings',
  cleared: 'Cleared {{count}} warnings',
  loadFailed: 'Failed to load warnings',
  loadMore: 'Load more',
  noStanding: 'No standing warnings.',
  noEvents: 'No event warnings yet.',
  missingFields: 'Missing: {{fields}}',
  lastFailedAt: 'Last failure: {{time}}',
  createdAt: 'Created {{time}}',
  updatedAt: 'updated {{time}}',
  readAt: 'read {{time}}',
  severity: {
    warning: 'Warning',
    critical: 'Critical',
  },
  actions: {
    openDeveloper: 'Open Developer',
    openModels: 'Open Models',
    openInvocations: 'Open invocations',
    openSettings: 'Open settings',
  },
  codes: {
    developer_payload_recording: {
      title: 'Raw request payloads are being recorded',
      body: 'Developer recording is enabled, so model request and response snapshots are stored in SQLite. Turn it off on the Developer page when you no longer need them.',
    },
    agent_model_missing: {
      title: 'No agent model is configured',
      body: 'The bot ingests messages but cannot start any invocation until the global agent provider, model and thinking level are all set.',
    },
    vision_model_missing: {
      title: 'No vision model is configured',
      body: 'Image understanding and background sticker indexing are unavailable until the vision provider and model are both set.',
    },
    invocation_failure_rate: {
      title: 'Invocation failure rate is above the threshold',
      body: '{{failed}} of the last {{total}} completed invocations failed ({{rate}}%), above the {{threshold}}% threshold.',
    },
    admin_login_failures: {
      title: 'Consecutive administrator sign-in failures',
      body: 'The panel has seen {{count}} consecutive username/password failures.',
    },
    unknown: {
      title: 'Unknown warning: {{code}}',
      body: 'This panel version has no template for the warning code; raw variables follow.',
    },
  },
};
