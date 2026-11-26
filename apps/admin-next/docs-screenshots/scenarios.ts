/**
 * The screenshot scenarios (plan §5, rows 1-39).
 *
 * One entry per screenshot id: the id is the file name stem and the reason a
 * doc page can embed a stable asset. The manifest is generated from this
 * catalog, so adding a scenario means adding a row here and a
 * `captureScreenshot(page, locale, '<id>')` call in the matching spec.
 *
 * `pages` lists the doc pages that embed the screenshot, relative to
 * `apps/docs/content/<locale>/docs/`. It is reviewer metadata, not a build
 * input: `scripts/docs/screenshot-references.ts` enforces the real pairing.
 */
export interface DocsScenario {
  readonly id: string;
  /** One line a reviewer can check the image against. */
  readonly description: string;
  /** The state on screen when the shutter fires. */
  readonly target: string;
  readonly pages: readonly string[];
}

export const DOCS_SCENARIOS: readonly DocsScenario[] = [
  {
    id: 'installation/sign-in-one-time-code',
    description: 'Sign-in page with the one-time code form open and empty.',
    target: 'The sign-in gate switches to "sign in with a one-time code"; nothing is typed into it.',
    pages: ['guides/installation', 'guides/admin'],
  },
  {
    id: 'models/providers-list',
    description: "Providers page: the provider rail and the selected provider's model list.",
    target: 'The relay provider is selected in the pinned rail; its two configured models are listed beside it.',
    pages: ['guides/models'],
  },
  {
    id: 'models/provider-health-check',
    description: "Model health check that passed and shows the model's reply.",
    target: 'The Demo Model row was tested from the page and shows OK plus the reply text.',
    pages: ['guides/models'],
  },
  {
    id: 'models/model-roles',
    description: 'Models page: the three role cards and the save bar.',
    target: 'Agent, Vision and Tool Model cards, with the Agent thinking effort drafted and unsaved.',
    pages: ['guides/models', 'guides/installation'],
  },
  {
    id: 'first-persona/prompt-editor',
    description: 'Prompts page: the saved global persona and its applied version.',
    target: 'The editor holds the seeded persona and shows the applied external version v1.',
    pages: ['guides/first-persona'],
  },
  {
    id: 'first-persona/playground-scene',
    description: 'Playground room where a persona answered a test scene.',
    target: 'A held test scene was released and the scripted persona reply is in the timeline.',
    pages: ['guides/first-persona'],
  },
  {
    id: 'first-bot/telegram-token-empty',
    description: 'Telegram page with no token configured.',
    target: 'The token was cleared through the dialog: the page says no token is configured.',
    pages: ['guides/first-bot'],
  },
  {
    id: 'first-bot/telegram-connected',
    description: 'Telegram page after saving the token, showing the connected bot.',
    target: 'The token was saved through this form and the connection reports connected with @surowan_bot.',
    pages: ['guides/first-bot'],
  },
  {
    id: 'first-bot/chat-allowlist',
    description: 'Chats page with the allowed Chats.',
    target:
      'The allowlist lists the seeded private Chat and the docs group Chat with their titles, topic scope, agent model, policy summary and active state.',
    pages: ['guides/first-bot', 'guides/chats'],
  },
  {
    id: 'playground/hold-pending',
    description: 'Playground with Hold on and two pending messages.',
    target: 'The room holds its input; the seeded message plus one typed here are pending, no run exists.',
    pages: ['guides/playground'],
  },
  {
    id: 'playground/release-result',
    description: 'Playground after a release: the reply and the completed run.',
    target:
      'Releasing the hold ran the bot: the reply is in the timeline and the run card is completed with an Audit link.',
    pages: ['guides/playground'],
  },
  {
    id: 'admin/navigation',
    description: 'Overview page with the expanded sidebar navigation.',
    target: 'The dashboard renders real counters, the bot status and the full navigation rail.',
    pages: ['guides/admin'],
  },
  {
    id: 'admin/keychain',
    description: 'Keychain: entries and the config paths that reference them.',
    target: 'Used entries name their config paths; one unused entry shows the orphan state.',
    pages: ['guides/admin'],
  },
  {
    id: 'admin/api-keys',
    description: 'API keys page with keys in different permission modes.',
    target: 'Three keys created through the dialog, one per permission mode, listed with their modes.',
    pages: ['guides/admin', 'guides/agent-assisted'],
  },
  {
    id: 'admin/passkeys',
    description: 'Passkey management list with two registered keys.',
    target: 'Two passkeys registered through the real WebAuthn ceremony, with the password state.',
    pages: ['guides/admin'],
  },
  {
    id: 'tuning/bucket-timing',
    description: 'Telegram page: the message-batch timing card after a save.',
    target: 'The batch timing was saved through this card: a 60 s ceiling and a 5 s extension, no unsaved changes.',
    pages: ['guides/tuning'],
  },
  {
    id: 'tuning/entry-gate',
    description: 'Entry gate page with the global gate enabled in enforce mode.',
    target:
      'The gate was enabled and saved through the form; the behaviour card and the connection card with its keychain reference are in one frame.',
    pages: ['guides/tuning'],
  },
  {
    id: 'tuning/harness-budget',
    description: 'Harness tuning: the budget and send-protection sections.',
    target: 'The budget card and the start of the send-behaviour card, with the section navigation on the left.',
    pages: ['guides/tuning'],
  },
  {
    id: 'tuning/review-export',
    description: 'Review draft with the export confirmation dialog open.',
    target: 'A draft written on an invocation page, its goal and purpose filled in, and the Markdown export dialog.',
    pages: ['guides/tuning', 'guides/agent-assisted'],
  },
  {
    id: 'tuning/invocation-resume',
    description: 'Failed tool session with the Resume action and the live-refresh switches.',
    target: 'The newest run of its Conversation failed at the model call; Resume is offered and Auto refresh shows on.',
    pages: ['guides/tuning', 'guides/troubleshooting'],
  },
  {
    id: 'chats/active-hours-ask-only',
    description: 'Active-hours dialog of a group Chat set to ask-only.',
    target: 'Only /ask was chosen and saved for the group; the dialog shows the stored mode.',
    pages: ['guides/chats'],
  },
  {
    id: 'chats/proactive-reply',
    description: 'Proactive-reply dialog of a group Chat with custom values.',
    target: 'The group was given its own chance settings and saved; the dialog reads back the stored percentages.',
    pages: ['guides/chats'],
  },
  {
    id: 'chats/entry-gate-override',
    description: 'Per-Chat entry gate dialog with four overrides saved.',
    target: 'Enabled, mode, threshold and question are set for the group, and the dialog shows the saved overrides.',
    pages: ['guides/chats'],
  },
  {
    id: 'chats/mcp-binding',
    description: 'MCP-binding dialog of a group Chat with one bound server.',
    target: 'Explicit bindings with the stdio fixture bound and narrowed to its echo tool.',
    pages: ['guides/chats'],
  },
  {
    id: 'knowledge/memo-editor',
    description: 'Memories: the edit dialog of an active memo.',
    target: 'The seeded memo opens for editing with its summary, Markdown detail and lifetime.',
    pages: ['guides/knowledge'],
  },
  {
    id: 'knowledge/group-memory-progress',
    description: 'Group memory: the consolidation-progress panel of the seeded Chat.',
    target: 'The lane shows its failed batch, the failed count and the messages still pending behind it.',
    pages: ['guides/knowledge'],
  },
  {
    id: 'knowledge/thirty-hour-clock',
    description: 'Group-memory dialog of a group Chat with the 30-hour clock chosen.',
    target: 'Group memory is on, no overlap is selected and saved, and the dialog reads the choice back.',
    pages: ['guides/knowledge'],
  },
  {
    id: 'knowledge/dictionary-import',
    description: 'Dictionary import dialog with a parsed CSV row.',
    target: 'A pasted CSV is previewed with its split aliases; nothing is written before the confirm.',
    pages: ['guides/knowledge'],
  },
  {
    id: 'images/image-settings',
    description: 'Image settings page with generation enabled and a model configured.',
    target:
      'A taller frame holds the enable switch with its credential row and the saved model card, with nothing unsaved.',
    pages: ['guides/image-generation'],
  },
  {
    id: 'images/generate-workbench',
    description: 'Image generation workbench with an inline reference and a prompt asset.',
    target:
      'The editor holds a typed {{image:…}} token and the prompt asset is attached through its tag; the resolved prompt expands both.',
    pages: ['guides/image-generation'],
  },
  {
    id: 'images/generation-record',
    description: 'A completed image generation record with its output and reference image.',
    target: 'A run that finished through the real worker: status, resolved prompt and the generated picture.',
    pages: ['guides/image-generation'],
  },
  {
    id: 'images/image-assets',
    description: 'Image assets: the reference-image tab with the Agent-visible toggle.',
    target: 'An uploaded reference image with its name and the Agent-visible switch.',
    pages: ['guides/image-generation'],
  },
  {
    id: 'images/sticker-sets',
    description: 'Bot sticker sets: the configured set and its search index.',
    target: 'The seeded mascot set with its sync state and the indexed sticker with its description.',
    pages: ['guides/stickers'],
  },
  {
    id: 'tools/search-settings',
    description: 'Web search settings with one configured engine.',
    target: 'An engine added through the dialog with a note and a URL filter, saved and read back.',
    pages: ['guides/web-search'],
  },
  {
    id: 'tools/recurring-alarm',
    description: 'Recurring alarms: the rule form and its next-run preview.',
    target: 'A weekly alarm whose rules are filled in and whose preview lists the next five runs.',
    pages: ['guides/recurring-alarms'],
  },
  {
    id: 'tools/mcp-servers',
    description: 'MCP servers page with a ready server, a degraded one and progressive exposure.',
    target: 'The stdio fixture connected with progressive exposure and skills, the HTTP endpoint degraded.',
    pages: ['guides/mcp'],
  },
  {
    id: 'troubleshooting/config-drift',
    description: 'Settings page where the file no longer matches the running configuration.',
    target: 'A Chat edit that needs a restart is pending: the file hash differs and the pending path is listed.',
    pages: ['guides/troubleshooting'],
  },
  {
    id: 'troubleshooting/mcp-degraded',
    description: 'Warnings page with the standing MCP-unreachable warning.',
    target: 'The degraded HTTP server produces a standing warning naming the affected aliases.',
    pages: ['guides/troubleshooting'],
  },
  {
    id: 'troubleshooting/tool-calls',
    description: 'Tool session detail: tool calls with their arguments and the Telegram send.',
    target: 'The send row is expanded with its arguments and result, next to the read call and the run state.',
    pages: ['guides/troubleshooting'],
  },
];

export function docsScenario(id: string): DocsScenario {
  const scenario = DOCS_SCENARIOS.find((candidate) => candidate.id === id);
  if (scenario === undefined) {
    throw new Error(`Unknown docs screenshot scenario: ${id}`);
  }
  return scenario;
}
