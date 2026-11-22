/**
 * UI strings the docs screenshot specs navigate by.
 *
 * The specs run the panel in `zh-CN` and `en`, so every label, heading and
 * button name they look up exists in both languages. The strings are copied
 * verbatim from `apps/admin-next/src/locales/<locale>/` (the panel's source of
 * truth): if a catalog changes, the screenshot run fails on the missing label
 * instead of quietly capturing the wrong state. Structural hooks (ids,
 * `data-model-list`, `role="dialog"`) are preferred wherever they exist.
 */
import type { DocsLocale } from '../e2e/docs-locale.ts';
import { EN } from './labels-en.ts';
import { ZH } from './labels-zh.ts';

export interface DocsLabels {
  readonly nav: {
    readonly mainNavigation: string;
    readonly overview: string;
  };
  readonly auth: {
    readonly loginTitle: string;
    readonly codeSignIn: string;
    readonly code: string;
    readonly signIn: string;
  };
  readonly common: {
    readonly save: string;
    readonly cancel: string;
    readonly edit: string;
    /** `models.models.feedback.applied`: the toast every config write raises. */
    readonly applied: string;
  };
  readonly overview: {
    readonly storedMessages: string;
    readonly botStatus: string;
    readonly recentInvocations: string;
    readonly warningsNone: string;
  };
  readonly telegram: {
    readonly title: string;
    readonly connected: string;
    readonly disabled: string;
    readonly tokenConfigured: string;
    readonly tokenMissing: string;
    readonly tokenLabel: string;
    readonly save: string;
    readonly saved: string;
    readonly clear: string;
    readonly bucketTitle: string;
    readonly bucketMax: string;
    readonly bucketBump: string;
    readonly bucketSave: string;
    readonly bucketUnchanged: string;
    readonly bucketPending: (count: number) => string;
  };
  readonly chats: {
    readonly title: string;
    readonly chatColumn: string;
    readonly active: string;
    readonly private: string;
    readonly moreActions: string;
    readonly topicIds: string;
    readonly saveChat: string;
    readonly editActiveHours: string;
    readonly editProactiveReply: string;
    readonly editEntryGate: string;
    readonly editMcp: string;
    readonly editGroupMemory: string;
    readonly dialogSave: string;
    readonly activeHours: {
      readonly title: string;
      readonly askOnly: string;
      readonly unrestricted: string;
    };
    readonly proactive: {
      readonly title: string;
      readonly custom: string;
      readonly base: string;
      readonly increment: string;
      readonly pity: string;
      readonly summary: (base: number, increment: number, pity: number) => string;
    };
    readonly entryGate: {
      readonly title: string;
      readonly setEnabled: string;
      readonly setMode: string;
      readonly setThreshold: string;
      readonly setQuestion: string;
      readonly mode: string;
      readonly modeEnforce: string;
      readonly threshold: string;
      readonly question: string;
      readonly enforceSummary: string;
    };
    readonly mcp: {
      readonly title: string;
      readonly explicit: string;
      readonly bind: (alias: string) => string;
      readonly selectedTools: string;
    };
    readonly groupMemory: {
      readonly title: string;
      readonly enable: string;
      readonly thirtyHour: string;
      readonly thirtyHourExclusive: string;
      readonly thirtyHourSummary: string;
    };
  };
  readonly keychain: {
    readonly title: string;
    readonly nameColumn: string;
    readonly usedByColumn: string;
    readonly unused: string;
  };
  readonly apiKeys: {
    readonly title: string;
    readonly create: string;
    readonly createConfirm: string;
    readonly name: string;
    readonly mode: string;
    readonly saveTitle: string;
    readonly done: string;
  };
  readonly passkeys: {
    readonly title: string;
    readonly add: string;
    readonly nameLabel: string;
    readonly registerConfirm: string;
    readonly registered: string;
    readonly passwordStatus: string;
    readonly empty: string;
  };
  readonly models: {
    readonly providersTitle: string;
    readonly modelsTitle: string;
    readonly provider: (alias: string) => string;
    readonly checkHealth: (model: string) => string;
    readonly healthOk: string;
    readonly modelReply: string;
  };
  readonly roles: {
    readonly pageDescription: string;
    readonly save: string;
    readonly saved: string;
    readonly unchanged: string;
    readonly pending: (count: number) => string;
    readonly discard: string;
    readonly thinkingEffort: string;
    readonly agentTitle: string;
    readonly visionTitle: string;
    readonly toolTitle: string;
  };
  readonly prompts: {
    readonly globalScope: string;
    readonly promptLabel: string;
    readonly save: string;
    readonly historyTitle: string;
    readonly applied: string;
    readonly external: string;
  };
  readonly playground: {
    readonly title: string;
    readonly roomsHeading: string;
    readonly holdOn: string;
    readonly pending: (count: number) => string;
    readonly release: (count: number) => string;
    readonly runsHeading: string;
    readonly runsEmpty: string;
    readonly audit: string;
    readonly composer: string;
    readonly send: string;
    readonly timelineHeading: string;
    readonly completed: string;
  };
  readonly tuning: {
    readonly gate: {
      readonly title: string;
      readonly enabled: string;
      readonly mode: string;
      readonly modeEnforce: string;
      readonly threshold: string;
      readonly historyMessages: string;
      readonly pendingMessages: string;
      readonly question: string;
      readonly apiKey: string;
      readonly keyFromEntry: (name: string) => string;
      readonly save: string;
      readonly unchanged: string;
    };
    readonly harness: {
      readonly sections: string;
      readonly budget: string;
      readonly send: string;
      readonly dailyBudget: string;
      readonly maxConcurrency: string;
      readonly historyMessages: string;
    };
  };
  readonly reviews: {
    readonly panelTitle: string;
    readonly exportPanelTitle: string;
    readonly purposeDevelop: string;
    readonly goal: string;
    readonly addOverall: string;
    readonly overall: string;
    readonly download: string;
    readonly confirmTitle: string;
    readonly confirmButton: string;
    readonly openDraft: string;
  };
  readonly invocations: {
    readonly title: (id: string) => string;
    readonly summary: string;
    readonly state: string;
    readonly overviewTab: string;
    readonly resume: string;
    readonly autoRefresh: string;
    readonly autoScroll: string;
    readonly toolCallsTab: (count: number) => string;
    readonly telegramSendsTab: (count: number) => string;
    readonly argumentsAndResult: string;
    readonly arguments: string;
    readonly result: string;
    readonly reviewComment: string;
    readonly addReviewComment: string;
    readonly toggleRowDetails: string;
  };
  readonly memories: {
    readonly editTitle: (id: string) => string;
    readonly summary: string;
    readonly detail: string;
    readonly ttl: string;
  };
  readonly groupMemories: {
    readonly progressTitle: string;
    readonly statusFailing: (count: number) => string;
    readonly through: string;
    readonly pending: string;
    readonly viewRuns: string;
  };
  readonly dictionary: {
    readonly importButton: string;
    readonly pasteLabel: string;
    readonly previewButton: string;
    readonly previewTitle: (count: number) => string;
    readonly confirm: (count: number) => string;
  };
  readonly stickers: {
    readonly setsTitle: string;
    readonly indexTitle: string;
    readonly description: string;
    readonly search: string;
  };
  readonly images: {
    readonly settingsTitle: string;
    readonly enablePanel: string;
    readonly enableLabel: string;
    readonly modelNotes: string;
    readonly generateTitle: string;
    readonly promptLabel: string;
    readonly resolvePreview: string;
    readonly resolvedPrompt: string;
    readonly outputsTitle: string;
    readonly generationsTitle: string;
    readonly generationId: string;
    readonly finalPrompt: string;
    readonly assetsTitle: string;
    readonly tabPrompts: string;
    readonly tabImages: string;
    readonly agentVisible: string;
    readonly extract: string;
    readonly uploadImage: string;
    readonly modelsPanel: string;
    readonly modelNotesPlaceholder: string;
    readonly removeModel: (name: string) => string;
    readonly readyToSave: string;
    readonly saveAndApply: string;
    readonly referenceLibrary: string;
    readonly generationModel: string;
    readonly assetName: string;
    readonly generate: string;
    readonly auditDetail: string;
  };
  readonly search: {
    readonly title: string;
    readonly enginesTitle: string;
    readonly addEngine: string;
    readonly fieldId: string;
    readonly fieldProvider: string;
    readonly fieldEndpoint: string;
    readonly fieldNote: string;
    readonly filtersLabel: string;
    readonly testUrls: string;
    readonly save: string;
  };
  readonly alarms: {
    readonly title: string;
    readonly newAlarm: string;
    readonly fieldTitle: string;
    readonly fieldPrompt: string;
    readonly previewTitle: string;
    readonly modeCron: string;
    readonly create: string;
    readonly firstWeekday: string;
    readonly lastWeekday: string;
  };
  readonly mcp: {
    readonly title: string;
    readonly ready: string;
    readonly degraded: string;
    readonly progressive: string;
    readonly skillsBadge: (count: number) => string;
    readonly view: (alias: string) => string;
  };
  readonly settings: {
    readonly configFile: string;
    readonly fileHasChanges: string;
    readonly restartRequired: string;
    readonly applyConfigFile: string;
  };
  readonly warnings: {
    readonly standingTitle: string;
    readonly mcpUnavailable: string;
  };
}

export const DOCS_LABELS: Record<DocsLocale, DocsLabels> = {
  'zh-CN': ZH,
  en: EN,
};

export function docsLabels(locale: DocsLocale): DocsLabels {
  return DOCS_LABELS[locale];
}
