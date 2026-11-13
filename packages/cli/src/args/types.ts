import type { PanelCommand } from '../panel/types.ts';

export type ConfigSource = 'active' | 'file';
export type PromptScope = 'global' | 'group';
export type MediaVariant = 'original' | 'preview';

export interface ListCommand {
  readonly kind: 'list';
  readonly limit: number | undefined;
  readonly offset: number | undefined;
  readonly asOf: string | undefined;
  readonly state: string | undefined;
  readonly chat: string | undefined;
  readonly search: string | undefined;
  readonly model: string | undefined;
  readonly at: string | undefined;
  readonly from: string | undefined;
  readonly to: string | undefined;
}

export interface GetCommand {
  readonly kind: 'get';
  readonly id: string;
}

export interface PromptsCommand {
  readonly kind: 'prompts';
  readonly id: string;
}

export interface ReplayModelSelection {
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly thinkingLevel: string | undefined;
}

export interface ModelsListCommand {
  readonly kind: 'models-list';
}

export interface PreflightCommand extends ReplayModelSelection {
  readonly kind: 'preflight';
  readonly id: string;
  readonly beforeSendId: string | undefined;
}

export interface MediaCommand {
  readonly kind: 'media';
  readonly id: string;
  readonly variant: MediaVariant;
}

export interface ReplayCommand extends ReplayModelSelection {
  readonly kind: 'replay';
  readonly id: string;
  readonly globalPromptSource: string | undefined;
  readonly groupPromptSource: string | undefined;
  readonly beforeSendId: string | undefined;
}

export interface ConfigShowCommand {
  readonly kind: 'config-show';
  readonly source: ConfigSource | undefined;
}

export interface PromptGetCommand {
  readonly kind: 'prompt-get';
  readonly scope: PromptScope;
  readonly chat: string | undefined;
  readonly source: ConfigSource | undefined;
}

export interface LoginCommand {
  readonly kind: 'login';
  readonly apiKeyStdin: boolean;
}

export interface DoctorCommand {
  readonly kind: 'doctor';
}

export interface CommandsListCommand {
  readonly kind: 'commands-list';
}

export type InvocationCommand =
  | ListCommand
  | GetCommand
  | PromptsCommand
  | PreflightCommand
  | MediaCommand
  | ReplayCommand;
/**
 * The commands with hand-written handlers in `commands.ts`. Everything else is
 * either local (`login`) or resolved from the panel spec table (`panel`).
 */
export type FirstClassCommand = InvocationCommand | ModelsListCommand | ConfigShowCommand | PromptGetCommand;
export type CliCommand = FirstClassCommand | CommandsListCommand | PanelCommand;
export type Command = CliCommand | LoginCommand | DoctorCommand;
export type CredentialSource = 'argument' | 'environment' | 'file';

export interface ParsedCli {
  readonly help: boolean;
  readonly json: boolean;
  readonly command: Command | undefined;
  readonly endpointRaw: string | undefined;
  readonly apiKeyRaw: string | undefined;
  readonly timeoutRaw: string | undefined;
}

export interface ResolvedCli {
  readonly command: Command;
  readonly endpoint: URL;
  readonly apiKey: string | undefined;
  readonly json: boolean;
  readonly timeoutMs: number;
  readonly credentialSources: { readonly endpoint: CredentialSource; readonly credential: CredentialSource };
}

export interface StringFlags {
  readonly 'api-key-stdin': boolean | undefined;
  readonly 'if-match': string | undefined;
  readonly 'dry-run': boolean | undefined;
  readonly yes: boolean | undefined;
  readonly file: string | undefined;
  readonly body: string | undefined;
  readonly set: readonly string[] | undefined;
  readonly 'set-json': readonly string[] | undefined;
  readonly format: string | undefined;
  readonly output: string | undefined;
  readonly offset: string | undefined;
  readonly days: string | undefined;
  readonly q: string | undefined;
  readonly unread: string | undefined;
  readonly enabled: string | undefined;
  readonly host: string | undefined;
  readonly target: string | undefined;
  readonly day: string | undefined;
  readonly before: string | undefined;
  readonly scope: string | undefined;
  readonly 'sticker-set': string | undefined;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly 'thinking-level': string | undefined;
  readonly source: string | undefined;
  readonly variant: string | undefined;
  readonly 'global-prompt': string | undefined;
  readonly 'group-prompt': string | undefined;
  readonly limit: string | undefined;
  readonly 'as-of': string | undefined;
  readonly state: string | undefined;
  readonly chat: string | undefined;
  readonly search: string | undefined;
  readonly at: string | undefined;
  readonly from: string | undefined;
  readonly to: string | undefined;
  readonly 'before-send': string | undefined;
  readonly 'confirm-paid': boolean | undefined;
}

export type FlagName = keyof StringFlags;
