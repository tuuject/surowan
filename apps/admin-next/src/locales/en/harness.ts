/**
 * Harness tuning page. English is the source catalog; `zh-CN/harness.ts`
 * mirrors this structure key for key.
 */
export const harness = {
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
  sections: {
    navigation: 'Form sections',
    jump: 'Jump to section',
    invalid: ', needs correction',
    changed: ', unsaved changes',
  },
  errors: {
    integer: 'Enter a whole number',
    number: 'Enter a number',
    min: 'Must be at least {{min}}',
    max: 'Must be at most {{max}}',
    greaterThan: 'Must be greater than {{min}}',
    lines: 'Enter at least one line',
    option: 'Choose one of the listed options',
  },
  groups: {
    budget: {
      title: 'Budget and concurrency',
    },
    send: {
      title: 'Send behavior',
    },
    rateLimits: {
      title: 'Rate limits',
    },
    context: {
      title: 'Context',
    },
    proactiveReply: {
      title: 'Proactive replies',
    },
  },
  fields: {
    'daily_budget.max_tokens': {
      label: 'Daily token budget',
      description: 'Daily token cap shared by replies and image reading. Lowering it applies from the next model call.',
    },
    max_concurrency: {
      label: 'Max concurrent invocations',
      description: 'How many invocations may run at the same time.',
    },
    history_messages: {
      label: 'History messages',
      description: 'How many earlier messages each new invocation brings along.',
    },
    context_stop_ratio: {
      label: 'Context stop ratio',
      description:
        'Once the input fills this share of the model context length, the run replies one last time and ends.',
    },
    send_max_text_length: {
      label: 'Max text length',
      description: 'Longest text of a single message, in characters (1–4096).',
    },
    send_disallow_blank_lines: {
      label: 'Disallow blank lines',
      description: 'Reject texts with blank lines; paragraphs may only be separated by a single line break.',
    },
    send_nudge_enabled: {
      label: 'Send reminder',
      description: 'Remind the model to send its reply when it is about to stop without sending anything.',
    },
    send_barrier_enabled: {
      label: 'Wait for new messages',
      description: 'When new messages arrive before a send, let the model read them before replying.',
    },
    allow_reply_message_multiple_times: {
      label: 'Allow multiple replies to one message',
      description: 'Allow replying to the same message more than once. Budgets and rate limits still apply.',
    },
    send_duplicate_guard_enabled: {
      label: 'Duplicate send guard',
      description:
        'Reject a text or sticker already sent in the same invocation; stop the run after more than 3 rejections.',
    },
    send_empty_text_strategy: {
      label: 'Empty-text sends',
      description: 'What happens when the model sends a text message without any text.',
      options: {
        reject: 'Reject the call',
        silent_success: 'Succeed silently (send nothing)',
        random_text: 'Send a random fallback text',
      },
    },
    send_empty_text_fallback_texts: {
      label: 'Fallback texts',
      description: 'One per line; one is picked at random each time.',
    },
    'rate_limits.sends_per_window': {
      label: 'Sends per window',
      description: 'Messages each chat may send within one window; failed sends count too.',
    },
    'rate_limits.window_seconds': {
      label: 'Window length (seconds)',
      description: 'The time window the send count covers.',
    },
    'rate_limits.turns_per_injection': {
      label: 'Turns per message batch',
      description: 'Turns allowed after each new batch of messages before the run ends.',
    },
    'context.retained_sends_target': {
      label: 'Retained sends target',
      description: 'Sends kept after the context is cleaned up; must be smaller than the maximum.',
    },
    'context.retained_sends_max': {
      label: 'Retained sends maximum',
      description: 'The context is cleaned up once it holds more sends than this.',
    },
    'context.hard_token_ratio': {
      label: 'Forced cleanup ratio',
      description: 'Share of the model context length that forces a cleanup; must not exceed the context stop ratio.',
    },
    'context.ref_ttl_hours': {
      label: 'Reference lifetime (hours)',
      description: 'How long image, sticker and reply references stay valid. Applies to references issued from now on.',
    },
    'context.idle_grace_seconds': {
      label: 'Idle grace (seconds)',
      description:
        'How long a finished run waits for the next batch of messages. 0 means no waiting; otherwise at least the longest message batch wait.',
    },
    'context.max_wall_clock_seconds': {
      label: 'Max run time (seconds)',
      description: 'Longest time a single run may take; must exceed the idle grace.',
    },
    'context.agent_cache_size': {
      label: 'Memory cache size',
      description: 'How many contexts stay cached in memory. A smaller value never loses history.',
    },
    'proactive_reply.enabled': {
      label: 'Schedule proactive replies',
      description:
        'When on, group messages that do not address the bot only get a reply chance if a draw hits. When off, every batch gets a chance. Private chats are never affected.',
    },
    'proactive_reply.base_probability': {
      label: 'First-try chance',
      description: 'Chance of the first draw after a hit, from 0 to 1 (0.2 means 20%).',
    },
    'proactive_reply.increment': {
      label: 'Increase after each miss',
      description: 'Added to the chance after every miss, from 0 to 1. A hit resets it.',
    },
    'proactive_reply.hard_pity': {
      label: 'Maximum tries',
      description: 'The draw at this try always hits.',
    },
  },
};
