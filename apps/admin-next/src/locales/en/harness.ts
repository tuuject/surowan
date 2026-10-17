/**
 * Harness tuning page. English is the source catalog; `zh-CN/harness.ts`
 * mirrors this structure key for key.
 */
export const harness = {
  description:
    'Runtime limits and send behavior of the agent harness. Saving writes config.jsonc and applies it: Invocations that start afterwards use the new values; running ones keep the values they started with.',
  elsewhere:
    'The agent model and thinking effort are on <models>Models</models>; the system prompt is on <prompts>Prompts</prompts>.',
  loadFailed: 'Failed to load Harness settings',
  save: 'Save and apply',
  saving: 'Saving…',
  discard: 'Discard changes',
  unchanged: 'No unsaved changes',
  pending_one: '{{count}} unsaved change',
  pending_other: '{{count}} unsaved changes',
  invalid: 'Fix the highlighted fields before saving.',
  running: 'Running: {{value}}',
  noLimit: 'No limit',
  noLimitPlaceholder: 'Empty means no limit',
  on: 'On',
  off: 'Off',
  errors: {
    integer: 'Enter a whole number',
    number: 'Enter a number',
    min: 'Must be at least {{min}}',
    max: 'Must be at most {{max}}',
    greaterThan: 'Must be greater than {{min}}',
  },
  groups: {
    budget: {
      title: 'Budget and concurrency',
      description: 'Global safety limits shared by every Chat.',
    },
    send: {
      title: 'Send behavior',
      description: 'Rules the send tool enforces before anything reaches Telegram.',
    },
    rateLimits: {
      title: 'Rate limits',
      description: 'Throttles that keep long-lived runs from flooding a chat.',
    },
    context: {
      title: 'Conversation Context',
      description: 'How the persistent transcript is retained, trimmed and kept open.',
    },
    memory: {
      title: 'Memory review',
      description: 'When the Memories page flags a memory for review.',
    },
  },
  fields: {
    'daily_budget.max_tokens': {
      label: 'Daily token budget',
      description:
        'Global daily token cap for the agent and chat-triggered image reads; a circuit breaker against runaway loops. Read live: lowering it stops the next model call.',
    },
    max_concurrency: {
      label: 'Max concurrent Invocations',
      description: 'Upper bound of Invocations running at the same time.',
    },
    history_messages: {
      label: 'History messages',
      description: 'Messages frozen into the history snapshot of each new Invocation.',
    },
    context_stop_ratio: {
      label: 'Context stop ratio',
      description:
        'Share of the model context window at which the run gets one final turn with only send available, then ends.',
    },
    send_max_text_length: {
      label: 'Max text length',
      description: 'Longest text a single send may carry, in characters (1–4096).',
    },
    send_disallow_blank_lines: {
      label: 'Disallow blank lines',
      description: 'Reject texts with blank lines; paragraphs may only be separated by a single line break.',
    },
    send_nudge_enabled: {
      label: 'Send nudge',
      description:
        'Remind the model to use send when it is about to stop with plain text but never sent anything in this batch.',
    },
    send_barrier_enabled: {
      label: 'Send barrier',
      description:
        'Hold the first send of a round when new messages are collecting, so the model reads them before replying.',
    },
    allow_reply_message_multiple_times: {
      label: 'Allow multiple replies to one message',
      description: 'Disable per-message reply deduplication. Authorization, budgets and rate limits still apply.',
    },
    'rate_limits.sends_per_window': {
      label: 'Sends per window',
      description: 'Telegram sends allowed per chat inside the sliding window; failed attempts count too.',
    },
    'rate_limits.window_seconds': {
      label: 'Window length (seconds)',
      description: 'Length of the sliding send window.',
    },
    'rate_limits.turns_per_injection': {
      label: 'Turns per injection',
      description: 'Turns allowed since the last injected batch before the run ends.',
    },
    'context.retained_sends_target': {
      label: 'Retained sends target',
      description: 'Sends GC keeps when it trims; must be smaller than the maximum.',
    },
    'context.retained_sends_max': {
      label: 'Retained sends maximum',
      description: 'GC trims once the retained window holds more sends than this.',
    },
    'context.hard_token_ratio': {
      label: 'Hard token ratio',
      description: 'Share of the context window that forces GC; must not exceed the context stop ratio.',
    },
    'context.ref_ttl_hours': {
      label: 'Reference TTL (hours)',
      description:
        'Lifetime of image, sticker and reply references. Applies to references issued or renewed after saving; existing ones keep their expiry.',
    },
    'context.idle_grace_seconds': {
      label: 'Idle grace (seconds)',
      description:
        'How long a finished run stays open for the next batch. 0 turns long-lived runs off; otherwise at least the bucket window.',
    },
    'context.max_wall_clock_seconds': {
      label: 'Max wall clock (seconds)',
      description: 'Hard time limit of one run; must exceed the idle grace.',
    },
    'context.agent_cache_size': {
      label: 'Agent cache size',
      description:
        'Conversations whose agent stays cached in memory (LRU). A smaller value evicts on the next cached agent; history is never lost.',
    },
    memory_ttl_warning_days: {
      label: 'Long-TTL warning (days)',
      description: 'Memories that live longer than this are flagged on the Memories page.',
    },
  },
};
