import type { RuntimeConfigurationStore } from '../../../platform/runtime-config.ts';
import type { SecretStore } from '../../../platform/secrets.ts';
import type { ConfigController } from '../../../platform/config/write.ts';
import type { BusinessStore } from '../../../store/store.ts';
import { json, readJsonObject, requiredRevision, revisionRequired } from '../http.ts';
import { CONFIG_WRITE_STATUS, readConfigFile } from '../config-file.ts';
import { clearModelPayloads, parseDeveloperSettings } from '../developer.ts';
import { harnessEdits, harnessView, parseHarnessBody } from '../harness.ts';

export interface TuningAdminDeps {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly configReloader: ConfigController | undefined;
  readonly secrets: SecretStore | undefined;
  /** The in-flight model payload cleanup, shared with `stop()`. */
  readonly payloadClear: {
    current(): Promise<number> | undefined;
    set(value: Promise<number> | undefined): void;
  };
}

/** `/api/developer*` and `/api/harness*` — the tuning fields of the config file. */
export function createTuningAdminHandler(deps: TuningAdminDeps) {
  const { store, configStore, configReloader, secrets, payloadClear } = deps;

  const developerView = async (reloader: ConfigController) => {
    const { loaded, revision } = await readConfigFile(reloader, secrets);
    return {
      revision,
      record_model_payloads: loaded.config.developer.record_model_payloads,
      active_record_model_payloads: configStore.current().config.developer.record_model_payloads,
      record_agent_thinking: loaded.config.developer.record_agent_thinking,
      active_record_agent_thinking: configStore.current().config.developer.record_agent_thinking,
    };
  };

  const developer = async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'PUT') {
      return json({ error: 'method_not_allowed', message: 'Unsupported Developer operation' }, 405);
    }
    const reloader = configReloader;
    if (reloader === undefined) {
      return json({ error: 'developer_unavailable', message: 'Configuration reloading is not wired' }, 503);
    }
    if (request.method === 'GET') {
      return json(await developerView(reloader));
    }
    const revision = requiredRevision(request);
    if (revision === null) {
      return revisionRequired();
    }
    const body = parseDeveloperSettings(await readJsonObject(request));
    // Only the fields the request carries are written, so a single-field PUT
    // preserves the file value of the other switch.
    const edits = [
      ...(body.record_model_payloads === undefined
        ? []
        : [{ path: ['developer', 'record_model_payloads'], value: body.record_model_payloads }]),
      ...(body.record_agent_thinking === undefined
        ? []
        : [{ path: ['developer', 'record_agent_thinking'], value: body.record_agent_thinking }]),
    ];
    const result = await reloader.writeAndApply(edits, revision);
    if (!result.ok) {
      const message = result.fileWritten
        ? `config.jsonc was updated but not applied: ${result.message}`
        : result.message;
      return json({ error: result.code, message }, CONFIG_WRITE_STATUS[result.code] ?? 409);
    }
    return json({
      ...(await developerView(reloader)),
      apply: { applied: result.applied, restart_required: result.restartRequired, outside_serve: result.outsideServe },
    });
  };

  /**
   * Harness tuning: every `agent` field outside the model selection and the
   * prompt, plus the global proactive reply defaults. A PUT writes only the fields whose file value changes and applies
   * the file like every other configuration write; the next invocation runs
   * with the new values.
   */
  const harnessViewFor = async (reloader: ConfigController) => {
    const { loaded, revision } = await readConfigFile(reloader, secrets);
    return harnessView(loaded.config, configStore.current().config, revision);
  };

  const harness = async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'PUT') {
      return json({ error: 'method_not_allowed', message: 'Unsupported Harness operation' }, 405);
    }
    const reloader = configReloader;
    if (reloader === undefined) {
      return json({ error: 'harness_unavailable', message: 'Configuration reloading is not wired' }, 503);
    }
    if (request.method === 'GET') {
      return json(await harnessViewFor(reloader));
    }
    const revision = requiredRevision(request);
    if (revision === null) {
      return revisionRequired();
    }
    const values = parseHarnessBody(await readJsonObject(request));
    const { loaded, revision: currentRevision } = await readConfigFile(reloader, secrets);
    if (revision !== currentRevision) {
      return json({ error: 'config_conflict', message: 'The configuration file changed; reload before editing' }, 409);
    }
    const edits = harnessEdits(loaded.fileConfig, values);
    if (edits.length === 0) {
      return json({
        ...(await harnessViewFor(reloader)),
        apply: { applied: [], restart_required: [], outside_serve: [] },
      });
    }
    const result = await reloader.writeAndApply(edits, revision);
    if (!result.ok) {
      const message = result.fileWritten
        ? `config.jsonc was updated but not applied: ${result.message}`
        : result.message;
      return json({ error: result.code, message }, CONFIG_WRITE_STATUS[result.code] ?? 409);
    }
    return json({
      ...(await harnessViewFor(reloader)),
      apply: { applied: result.applied, restart_required: result.restartRequired, outside_serve: result.outsideServe },
    });
  };

  return {
    async handle(request: Request, segments: readonly string[]): Promise<Response | undefined> {
      const route = segments.join('/');
      if (route === 'developer/model-payloads' && request.method === 'DELETE') {
        if (payloadClear.current() !== undefined) {
          return json({ error: 'clear_in_progress', message: 'Model payload cleanup is already running' }, 409);
        }
        const running = clearModelPayloads(store.orm);
        payloadClear.set(running);
        try {
          return json({ cleared_model_calls: await running });
        } finally {
          payloadClear.set(undefined);
        }
      }
      if (route === 'developer') {
        return await developer(request);
      }
      if (route === 'harness') {
        return await harness(request);
      }
      return undefined;
    },
  };
}
