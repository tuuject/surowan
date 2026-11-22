/**
 * The screenshot scenarios epic B1 owns (plan §5, rows 1-15).
 *
 * One entry per screenshot id: the id is the file name stem and the reason a
 * doc placeholder can point at a stable asset. The manifest is generated from
 * this catalog, so adding a scenario to epic B2 means adding a row here and a
 * `captureScreenshot(page, locale, '<id>')` call in the matching spec.
 *
 * `pages` lists the (future) doc pages that embed the screenshot, relative to
 * `apps/docs/content/<locale>/docs/`; it is reviewer metadata, not a build
 * input — epic G turns the placeholders into images and checks the pairing.
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
    description: 'Chats page with one allowed Chat.',
    target: 'The allowlist lists the seeded Chat with its title, topics, model and active state.',
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
];

export function docsScenario(id: string): DocsScenario {
  const scenario = DOCS_SCENARIOS.find((candidate) => candidate.id === id);
  if (scenario === undefined) {
    throw new Error(`Unknown docs screenshot scenario: ${id}`);
  }
  return scenario;
}
