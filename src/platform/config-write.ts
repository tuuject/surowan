/** Config writes needed by bot commands, independent of how configuration is persisted. */
export type ConfigErrorCode =
  | 'config_permissions'
  | 'config_invalid'
  | 'config_conflict'
  | 'candidate_invalid'
  | 'model_unusable'
  | 'secret_unresolved'
  | 'unknown_provider'
  | 'unknown_model'
  | 'not_text_capable'
  | 'config_symlink'
  | 'config_write_failed';

export type BotCommandConfigWriteResult =
  | {
      readonly ok: true;
      readonly applied: readonly string[];
      readonly restartRequired: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code: ConfigErrorCode;
      readonly message: string;
      readonly fileWritten: boolean;
    };

export interface BotCommandConfigWriter {
  addChat(configuredChatId: number): Promise<BotCommandConfigWriteResult>;
  setChatUserIgnored(configuredChatId: number, userId: bigint, ignored: boolean): Promise<BotCommandConfigWriteResult>;
  setChatModel(configuredChatId: number, provider: string, model: string): Promise<BotCommandConfigWriteResult>;
  resetChatModel(configuredChatId: number): Promise<BotCommandConfigWriteResult>;
}
