import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { SecretStore } from '../../platform/secrets.ts';
import type { ConfigController, ConfigErrorCode } from '../../platform/config-write.ts';
import type { AgentModelOption, AgentModelSwitcher } from '../../platform/model-switch.ts';
import type { BucketScheduler } from '../../orchestration/scheduler.ts';
import type { LongTaskService } from '../../store/long-tasks.ts';
import type { BusinessStore } from '../../store/store.ts';
import { wakeFromSleep } from '../../store/sleep.ts';
import { cancelAlarm, parseAlarmId } from '../../plugins/alarm/admin.ts';
import { json, readJsonObject, redact, requiredRevision, revisionRequired } from './admin-http.ts';
import { cancelOngoingSessions } from './operations.ts';
import { listProviderPresets, supervisedRestartEnabled } from './providers-admin-read.ts';

/** Model reference problems are user errors; everything else is a conflict. */
const MODEL_ERROR_STATUS: Partial<Record<ConfigErrorCode, number>> = {
  unknown_provider: 400,
  unknown_model: 400,
  not_text_capable: 400,
  model_unusable: 400,
  secret_unresolved: 422,
};

export interface ControlAdminDeps {
  readonly store: BusinessStore;
  readonly configReloader: ConfigController | undefined;
  readonly secrets: SecretStore | undefined;
  readonly scheduler: BucketScheduler | undefined;
  readonly tasks: LongTaskService;
  readonly modelSwitcher: AgentModelSwitcher | undefined;
  readonly requestRestart: (() => void) | undefined;
}

/**
 * The runtime controls of `/api`: session cancellation and wake, alarm
 * cancellation, the live model switch, provider presets, restart, and the
 * configuration reload endpoints.
 */
export function createControlAdminHandler(deps: ControlAdminDeps) {
  const { store, configReloader, secrets, scheduler, tasks, modelSwitcher, requestRestart } = deps;

  const modelState = (
    switcher: AgentModelSwitcher,
    current: AgentModelOption,
  ): {
    readonly current: {
      readonly provider: string;
      readonly model: string;
      readonly name: string;
      readonly context_window: number;
      readonly max_tokens: number;
      readonly thinking_level: ModelThinkingLevel | null;
    };
    readonly options: readonly { readonly provider: string; readonly model: string; readonly name: string }[];
  } => {
    return {
      current: {
        provider: current.provider,
        model: current.model,
        name: current.name,
        context_window: current.contextWindow,
        max_tokens: current.maxTokens,
        thinking_level: switcher.thinkingLevel() ?? null,
      },
      options: switcher.list().map((option) => ({
        provider: option.provider,
        model: option.model,
        name: option.name,
      })),
    };
  };

  const model = async (request: Request): Promise<Response | undefined> => {
    const switcher = modelSwitcher;
    const reloader = configReloader;
    if (switcher === undefined || reloader === undefined) {
      return json({ error: 'model_switch_unavailable', message: 'Runtime model switching is not wired' }, 503);
    }
    // `GET /model` was removed with the Model page: the Models page reads the
    // file view from `GET /providers` and gets the live model back from here.
    if (request.method === 'PUT') {
      const revision = requiredRevision(request);
      if (revision === null) {
        return revisionRequired();
      }
      const body = await readJsonObject(request);
      if (typeof body.provider !== 'string' || typeof body.model !== 'string') {
        return json({ error: 'invalid_model_reference', message: 'provider and model must be strings' }, 400);
      }
      const result = await reloader.setAgentModel(body.provider, body.model, revision);
      if (!result.ok) {
        const status = MODEL_ERROR_STATUS[result.code] ?? 409;
        const message = result.fileWritten
          ? `config.jsonc was updated but not applied: ${result.message}`
          : result.message;
        return json({ error: result.code, message }, status);
      }
      const currentOption = switcher.current();
      if (currentOption === undefined) {
        return json({ error: 'model_switch_unavailable', message: 'No agent model is configured' }, 409);
      }
      return json({
        ...modelState(switcher, currentOption),
        apply: { applied: result.applied, restart_required: result.restartRequired },
      });
    }
    return undefined;
  };

  const restart = async (): Promise<Response> => {
    if (!supervisedRestartEnabled()) {
      return json(
        {
          error: 'restart_unsupported',
          message:
            'This deployment does not declare an external supervisor; set PLASTICWAN_SUPERVISED=1 when something restarts the process',
        },
        409,
      );
    }
    const reloader = configReloader;
    if (reloader === undefined || requestRestart === undefined) {
      return json({ error: 'restart_unavailable', message: 'Restarting is not wired' }, 503);
    }
    try {
      await reloader.readPersisted({ checkPermissions: true });
    } catch (error) {
      return json({ error: 'config_invalid', message: redact(secrets, error) }, 422);
    }
    // The response has to leave the socket before the shutdown closes it, and
    // `stop()` destroys live connections rather than draining them. Two things
    // keep the 202 intact: the adaptor writes it while resolving this promise,
    // which runs before the `setImmediate` callback, and `serve`'s shutdown only
    // reaches `admin.stop()` after `bot.stop()` has unblocked long polling. The
    // second one is a property of the caller, so `requestRestart` states it too.
    setImmediate(() => requestRestart());
    return json({ status: 'restarting' }, 202);
  };

  return {
    async handle(request: Request, segments: readonly string[], username: string): Promise<Response | undefined> {
      const route = segments.join('/');
      if (route === 'cancel-ongoing-sessions' && request.method === 'POST') {
        // Close the database side first: an aborted run releases its un-injected
        // batches, and they must already be expired by then.
        const result = cancelOngoingSessions(store.orm, new Date());
        const running = scheduler?.abortAll() ?? 0;
        scheduler?.wake();
        return json({ ...result, canceled_invocations: result.canceled_invocations + running });
      }
      if (route === 'wake' && request.method === 'POST') {
        const wasSleeping = wakeFromSleep(store.orm);
        if (wasSleeping) {
          scheduler?.wake();
        }
        return json({ status: 'awake', was_sleeping: wasSleeping });
      }
      if (segments[0] === 'alarms' && segments.length === 2 && request.method === 'DELETE') {
        const id = parseAlarmId(segments[1] ?? '');
        const result = cancelAlarm(tasks, store.orm, id, username);
        return json(result);
      }
      if (route === 'model') {
        return await model(request);
      }
      if (route === 'provider-presets' && request.method === 'GET') {
        return json({ presets: listProviderPresets() });
      }
      if (route === 'restart' && request.method === 'POST') {
        return await restart();
      }
      if (route === 'config/apply' && request.method === 'POST') {
        const reloader = configReloader;
        if (reloader === undefined) {
          return json({ error: 'config_reload_unavailable', message: 'Configuration reloading is not wired' }, 503);
        }
        const result = await reloader.reloadFromFile();
        if (!result.ok) {
          return json({ error: result.code, message: result.message }, 422);
        }
        return json({
          status: 'applied',
          applied: result.applied,
          restart_required: result.restartRequired,
          outside_serve: result.outsideServe,
          generation: result.status.generation,
          active_hash: result.status.activeHash,
          file_hash: result.status.fileHash,
        });
      }
      if (route === 'config/status' && request.method === 'GET') {
        const reloader = configReloader;
        if (reloader === undefined) {
          return json({ error: 'config_reload_unavailable', message: 'Configuration reloading is not wired' }, 503);
        }
        const status = reloader.status();
        return json({
          generation: status.generation,
          active_hash: status.activeHash,
          file_hash: status.fileHash,
          restart_required: status.restartRequired,
          last_error: status.lastError,
        });
      }
      return undefined;
    },
  };
}
