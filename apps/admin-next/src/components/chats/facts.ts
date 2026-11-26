import { useTranslation } from 'react-i18next';
import type {
  ChatEntry,
  ChatSettingsView,
  ChatsView,
  ParticipationView,
  ParticipationWindow,
} from '@/lib/api/chats.ts';
import type { DecisionGateValues, DecisionGateView } from '@/lib/api/decision-gate.ts';
import { thinkingLevelLabel } from '@/lib/format';
import { summarizeWindows } from '@/lib/participation';

/**
 * What one allowlisted Chat actually runs with, worked out once for the table,
 * the narrow list and the full settings. Every value is the effective one; its
 * source says whether this Chat sets it (`chat`), takes it from the global
 * settings (`global`), or neither configures it (`default`).
 */
export type FactSource = 'chat' | 'global' | 'default';

/** A summary line can combine fields from both levels: `mixed` when only some of them are the Chat's own. */
export type SummarySource = FactSource | 'mixed';

export type FactKey =
  | 'topics'
  | 'model'
  | 'thinking'
  | 'activeHours'
  | 'timezone'
  | 'keywords'
  | 'attention'
  | 'proactive'
  | 'decisionGate'
  | 'gateMode'
  | 'gateThreshold'
  | 'gateHistory'
  | 'gatePending'
  | 'gateQuestion'
  | 'groupMemory'
  | 'mcp';

export interface ChatFact {
  readonly key: FactKey;
  readonly label: string;
  /** The effective value, one entry per line. */
  readonly lines: readonly string[];
  readonly source: FactSource;
  /** The lines the compact policy summary shows; `null` leaves the fact to the full settings. */
  readonly compact: readonly string[] | null;
  /** A quiet closing line in the compact summary, e.g. how many more windows the full settings list. */
  readonly compactMore?: string;
  /** Where the compact lines come from, when they show more fields than `lines` does. */
  readonly compactSource?: SummarySource;
  /** Identifiers the user copies or matches. */
  readonly mono?: boolean;
  /** Long free text: keeps its own line breaks. */
  readonly prose?: boolean;
  /** Short tokens such as `Mon–Fri 09:00–18:00`: a line breaks between them, never inside one. */
  readonly tokens?: boolean;
}

export type ChatStatus = 'removalPending' | 'additionPending' | 'changesPending' | 'active';

export interface ModelFacts {
  /** The model's display name, or its id when the catalog has no name for it. */
  readonly name: string;
  readonly provider: string;
  /** `provider / model`, the identifier the edit dialog lists. */
  readonly id: string;
  /** `thinking Low`, for the line under the model name. */
  readonly thinking: string;
  /** `Low`, for a labelled field. */
  readonly thinkingLevel: string;
  readonly modelSource: FactSource;
  readonly thinkingSource: FactSource;
}

/** Only groups gate, pick proactive replies or keep a group memory: a private Chat's messages are all for the bot. */
export function isGroupChat(row: ChatEntry): boolean {
  return row.id.startsWith('-');
}

/** The file or the running process: a Chat's settings exist on both sides until a change needs a restart. */
export type SettingsSide = 'saved' | 'active';

/** A Chat removed from the file is still running until restart: show what it runs. */
export function shownSide(row: ChatEntry): SettingsSide | null {
  return row.saved !== null ? 'saved' : row.active !== null ? 'active' : null;
}

export function shownSettings(row: ChatEntry): ChatSettingsView | null {
  return row.saved ?? row.active;
}

export function chatStatus(row: ChatEntry): ChatStatus {
  if (row.saved === null) {
    return 'removalPending';
  }
  if (row.active === null) {
    return 'additionPending';
  }
  return JSON.stringify(row.saved) === JSON.stringify(row.active) ? 'active' : 'changesPending';
}

type ActiveHours =
  | { readonly kind: 'unrestricted' }
  | { readonly kind: 'askOnly' }
  | { readonly kind: 'triggerOnly' }
  | { readonly kind: 'windows'; readonly windows: readonly ParticipationWindow[] };

/** Mirrors the runtime's `compileParticipation`: any of these fields turns the schedule gate on. */
function scheduled(value: ParticipationView | null): boolean {
  return (
    value !== null &&
    (Object.keys(value).length === 0 ||
      value.active_windows !== undefined ||
      value.trigger_keywords !== undefined ||
      value.attention_window_seconds !== undefined)
  );
}

/**
 * The schedule a group runs on, resolved like the runtime does: ask-only wins,
 * no participation anywhere leaves the group unrestricted, and Chat windows
 * replace the global list wholesale (an empty list means trigger only).
 */
export function effectiveActiveHours(
  chat: ParticipationView | null,
  global: ParticipationView | null,
): { readonly hours: ActiveHours; readonly source: FactSource } {
  if (chat === null && global === null) {
    return { hours: { kind: 'unrestricted' }, source: 'default' };
  }
  if (chat?.ask_only ?? global?.ask_only ?? false) {
    return { hours: { kind: 'askOnly' }, source: chat?.ask_only === undefined ? 'global' : 'chat' };
  }
  if (!scheduled(chat) && !scheduled(global)) {
    return { hours: { kind: 'unrestricted' }, source: chat === null ? 'global' : 'chat' };
  }
  const windows = chat?.active_windows ?? global?.active_windows ?? [];
  const source: FactSource =
    chat?.active_windows !== undefined
      ? 'chat'
      : global?.active_windows !== undefined || !scheduled(chat)
        ? 'global'
        : 'chat';
  return { hours: windows.length === 0 ? { kind: 'triggerOnly' } : { kind: 'windows', windows }, source };
}

const DEFAULT_ATTENTION_WINDOW_SECONDS = 300;
const DEFAULT_GROUP_MEMORY_IDLE_MINUTES = 30;
/** Windows the compact summary lists before it counts the rest. */
const COMPACT_WINDOWS = 2;

/**
 * Formats Chat settings in the current language; one instance serves every row
 * of a render. `gate` is the global entry gate, `undefined` while it is unknown:
 * the Chats view does not carry it, and a Chat's gate only overrides some fields.
 */
export function useChatFacts(view: ChatsView, gate: DecisionGateView | undefined) {
  const { t } = useTranslation();
  const separator = t('common.separator');
  const windowText = (window: ParticipationWindow): string =>
    summarizeWindows([window], {
      dayLabels: t('pages.chats.weekdaysShort').split(','),
      dailyLabel: t('pages.chats.daily'),
      separator,
    });

  const typeLabel = (row: ChatEntry): string => {
    switch (row.type) {
      case null:
        return isGroupChat(row) ? t('pages.chats.group') : t('pages.chats.private');
      case 'private':
        return t('pages.chats.private');
      case 'group':
        return t('pages.chats.group');
      case 'supergroup':
        return t('pages.chats.supergroup');
      case 'channel':
        return t('pages.chats.channel');
      default:
        return row.type;
    }
  };

  const topics = (settings: ChatSettingsView): ChatFact => ({
    key: 'topics',
    label: t('pages.chats.colTopics'),
    lines: [settings.topic_ids === null ? t('pages.chats.allTopics') : settings.topic_ids.join(separator)],
    source: settings.topic_ids === null ? 'default' : 'chat',
    compact: null,
  });

  const model = (settings: ChatSettingsView): ModelFacts => {
    const { provider, model: modelId, thinking_level } = settings.effective;
    const entry = view.models.find((item) => item.provider === provider && item.model === modelId);
    // No model configured anywhere: nothing can run, and the row says so instead of `null / null`.
    const unset = t('models.models.roles.unset');
    return {
      name: entry?.name ?? modelId ?? unset,
      provider: provider ?? unset,
      id: provider === null || modelId === null ? unset : `${provider} / ${modelId}`,
      thinking: t('pages.chats.thinkingShort', { level: thinkingLevelLabel(thinking_level) }),
      thinkingLevel: thinkingLevelLabel(thinking_level),
      modelSource: settings.provider === null ? 'global' : 'chat',
      thinkingSource: settings.thinking_level === null ? 'global' : 'chat',
    };
  };

  const activeHours = (settings: ChatSettingsView): readonly ChatFact[] => {
    const { hours, source } = effectiveActiveHours(settings.participation, view.global_participation);
    const label = t('pages.chats.colActiveHours');
    const facts: ChatFact[] = [];
    if (hours.kind === 'windows') {
      const lines = hours.windows.map(windowText);
      const hidden = lines.length - COMPACT_WINDOWS;
      facts.push({
        key: 'activeHours',
        label,
        lines,
        source,
        tokens: true,
        compact: lines.slice(0, COMPACT_WINDOWS),
        ...(hidden > 0 ? { compactMore: t('pages.chats.moreWindows', { count: hidden }) } : {}),
      });
    } else {
      const text =
        hours.kind === 'askOnly'
          ? t('pages.chats.modeAskOnly')
          : hours.kind === 'triggerOnly'
            ? t('pages.chats.activeHoursTriggerOnly')
            : t('pages.chats.activeHoursUnrestricted');
      facts.push({ key: 'activeHours', label, lines: [text], source, compact: [text] });
    }
    // Windows are read in this zone; only a Chat's own zone is worth a line in the summary.
    const zoneSource: FactSource = settings.timezone === null ? 'global' : 'chat';
    const zone = settings.timezone ?? view.timezone;
    facts.push({
      key: 'timezone',
      label: t('pages.chats.timezoneLabel'),
      lines: [zone],
      source: zoneSource,
      compact: zoneSource === 'chat' && hours.kind === 'windows' ? [zone] : null,
      mono: true,
    });
    if (hours.kind === 'windows' || hours.kind === 'triggerOnly') {
      // Keywords add up across both levels; the attention window is overridden.
      const chatKeywords = settings.participation?.trigger_keywords ?? [];
      const keywords = [...(view.global_participation?.trigger_keywords ?? []), ...chatKeywords];
      if (keywords.length > 0) {
        facts.push({
          key: 'keywords',
          label: t('pages.chats.keywordsLabel'),
          lines: [keywords.join(separator)],
          source: chatKeywords.length > 0 ? 'chat' : 'global',
          compact: null,
        });
      }
      const chatSeconds = settings.participation?.attention_window_seconds;
      const globalSeconds = view.global_participation?.attention_window_seconds;
      facts.push({
        key: 'attention',
        label: t('pages.chats.attentionLabel'),
        lines: [
          t('pages.chats.attentionValue', {
            seconds: chatSeconds ?? globalSeconds ?? DEFAULT_ATTENTION_WINDOW_SECONDS,
          }),
        ],
        source: chatSeconds !== undefined ? 'chat' : globalSeconds !== undefined ? 'global' : 'default',
        compact: null,
      });
    }
    return facts;
  };

  const proactive = (settings: ChatSettingsView): ChatFact => {
    const values = settings.effective_proactive_reply;
    const source: FactSource = settings.proactive_reply === null ? 'global' : 'chat';
    const text = values.enabled
      ? t('pages.chats.proactiveSummary', {
          base: Number((values.base_probability * 100).toFixed(2)),
          increment: Number((values.increment * 100).toFixed(2)),
          pity: values.hard_pity,
        })
      : t('pages.chats.proactiveOffSummary');
    // Off everywhere is the quiet default; a Chat that turns it off on its own is a difference worth seeing.
    return {
      key: 'proactive',
      label: t('pages.chats.colProactive'),
      lines: [text],
      source,
      compact: values.enabled || source === 'chat' ? [text] : null,
    };
  };

  const gateModeText = (mode: 'shadow' | 'enforce'): string =>
    mode === 'enforce' ? t('decisionGate.modeEnforce') : t('decisionGate.modeShadow');

  /** Without the global values, only what this Chat sets can be named. */
  const gateOverrideText = (settings: ChatSettingsView): string => {
    const gate = settings.decision_gate;
    if (gate === null) {
      return t('pages.chats.decisionGateInheritSummary');
    }
    if (gate.enabled === false) {
      return t('pages.chats.decisionGateOffSummary');
    }
    if (gate.enabled === true) {
      if (gate.mode === 'enforce') {
        return t('pages.chats.decisionGateEnforceSummary');
      }
      if (gate.mode === 'shadow') {
        return t('pages.chats.decisionGateShadowSummary');
      }
      return t('pages.chats.decisionGateOnSummary');
    }
    return t('pages.chats.decisionGateCustomSummary');
  };

  const decisionGate = (settings: ChatSettingsView, global: DecisionGateValues | undefined): readonly ChatFact[] => {
    const label = t('pages.chats.colDecisionGate');
    const override = settings.decision_gate;
    if (global === undefined) {
      const text = gateOverrideText(settings);
      return [
        { key: 'decisionGate', label, lines: [text], source: override === null ? 'global' : 'chat', compact: [text] },
      ];
    }
    const own = (field: keyof DecisionGateValues): boolean => override !== null && Object.hasOwn(override, field);
    const fieldSource = (field: keyof DecisionGateValues): FactSource => (own(field) ? 'chat' : 'global');
    const effective: DecisionGateValues = { ...global, ...override };
    const state = effective.enabled
      ? t('pages.chats.decisionGateCompact', {
          mode: gateModeText(effective.mode),
          threshold: effective.threshold,
        })
      : t('pages.chats.decisionGateOffSummary');
    // The summary names the switch, and while it is on, the mode and threshold too: each may
    // come from either level, and a Chat override of a field the summary doesn't name still
    // makes the gate partly its own.
    const named: readonly (keyof DecisionGateValues)[] = effective.enabled
      ? ['enabled', 'mode', 'threshold']
      : ['enabled'];
    const ownedNamed = named.filter(own).length;
    const ownsOthers =
      override !== null && Object.keys(override).some((key) => !named.includes(key as keyof DecisionGateValues));
    const compactSource: SummarySource =
      ownedNamed === named.length ? 'chat' : ownedNamed === 0 && !ownsOthers ? 'global' : 'mixed';
    const facts: ChatFact[] = [
      {
        key: 'decisionGate',
        label,
        lines: [effective.enabled ? t('common.on') : t('common.off')],
        source: fieldSource('enabled'),
        compact: effective.enabled || override !== null ? [state] : null,
        compactSource,
      },
    ];
    // An entry gate that is off only reports the fields this Chat sets itself.
    const field = (
      key: FactKey,
      name: keyof DecisionGateValues,
      fieldLabel: string,
      text: string,
      extra: Partial<ChatFact> = {},
    ): void => {
      if (effective.enabled || own(name)) {
        facts.push({ key, label: fieldLabel, lines: [text], source: fieldSource(name), compact: null, ...extra });
      }
    };
    field('gateMode', 'mode', t('decisionGate.mode'), gateModeText(effective.mode));
    field('gateThreshold', 'threshold', t('decisionGate.threshold'), String(effective.threshold));
    field('gateHistory', 'history_messages', t('decisionGate.historyMessages'), String(effective.history_messages));
    field('gatePending', 'pending_messages', t('decisionGate.pendingMessages'), String(effective.pending_messages));
    field('gateQuestion', 'instructions', t('decisionGate.instructions'), effective.instructions, { prose: true });
    return facts;
  };

  const groupMemory = (settings: ChatSettingsView): ChatFact => {
    const memory = settings.group_memory;
    const label = t('pages.chats.colGroupMemory');
    if (memory === null || !memory.enabled) {
      const text = t('pages.chats.groupMemoryOffSummary');
      return { key: 'groupMemory', label, lines: [text], source: memory === null ? 'default' : 'chat', compact: null };
    }
    const summary = t('pages.chats.groupMemorySummary', {
      minutes: memory.idle_minutes ?? DEFAULT_GROUP_MEMORY_IDLE_MINUTES,
    });
    const text =
      (memory.thirty_hour_clock ?? 'off') === 'off'
        ? summary
        : `${summary}${separator}${t('pages.chats.groupMemoryThirtyHourSummary')}`;
    return { key: 'groupMemory', label, lines: [text], source: 'chat', compact: [text] };
  };

  const mcp = (settings: ChatSettingsView): ChatFact => {
    const label = t('pages.chats.colMcp');
    if (settings.mcp === null) {
      return { key: 'mcp', label, lines: [t('pages.chats.mcpInherit')], source: 'default', compact: null };
    }
    if (settings.mcp.length === 0) {
      // Beside its label, "Off" says it; the full settings spell it out.
      return { key: 'mcp', label, lines: [t('pages.chats.mcpNone')], source: 'chat', compact: [t('common.off')] };
    }
    return {
      key: 'mcp',
      label,
      lines: settings.mcp.map((binding) =>
        t('pages.chats.mcpBindingLine', {
          server: binding.server,
          tools:
            binding.tools === undefined || binding.tools === '*'
              ? t('pages.chats.mcpAllTools')
              : t('pages.chats.mcpToolCount', { count: binding.tools.length }),
        }),
      ),
      source: 'chat',
      compact: [settings.mcp.map((binding) => binding.server).join(separator)],
    };
  };

  /**
   * Everything one side of a Chat configures beyond its topics and model, in
   * reading order; each side reads the global entry gate of the same side.
   */
  const policy = (row: ChatEntry, side: SettingsSide): readonly ChatFact[] => {
    const settings = row[side];
    if (settings === null) {
      return [];
    }
    const facts: ChatFact[] = [];
    if (isGroupChat(row)) {
      facts.push(
        ...activeHours(settings),
        proactive(settings),
        ...decisionGate(settings, gate?.[side]),
        groupMemory(settings),
      );
    } else {
      const zone = settings.timezone ?? view.timezone;
      facts.push({
        key: 'timezone',
        label: t('pages.chats.timezoneLabel'),
        lines: [zone],
        source: settings.timezone === null ? 'global' : 'chat',
        compact: settings.timezone === null ? null : [zone],
        mono: true,
      });
    }
    facts.push(mcp(settings));
    return facts;
  };

  /** The value the running process uses, when it differs from the file. */
  const runningDiff = (
    row: ChatEntry,
    text: (settings: ChatSettingsView, side: SettingsSide) => string,
  ): string | null => {
    if (row.saved === null || row.active === null) {
      return null;
    }
    const running = text(row.active, 'active');
    return running === text(row.saved, 'saved') ? null : running;
  };

  /** Every label the compact policy summary can show, for sizing its label column alike in every row. */
  const compactLabels = [
    t('pages.chats.colActiveHours'),
    t('pages.chats.timezoneLabel'),
    t('pages.chats.colProactive'),
    t('pages.chats.colDecisionGate'),
    t('pages.chats.colGroupMemory'),
    t('pages.chats.colMcp'),
  ];

  return { typeLabel, topics, model, policy, runningDiff, separator, compactLabels };
}

export type ChatFacts = ReturnType<typeof useChatFacts>;
