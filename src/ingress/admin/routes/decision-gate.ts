import type { RuntimeConfigurationStore } from '../../../platform/runtime-config.ts';
import type { ConfigController } from '../../../platform/config/write.ts';
import type { SecretStore } from '../../../platform/secrets.ts';
import type { BusinessStore } from '../../../store/store.ts';
import {
  decisionGateEdits,
  decisionGatePlaintext,
  decisionGateScope,
  decisionGateView,
  parseDecisionGateBody,
} from '../decision-gate/index.ts';
import { listBucketDecisions } from '../decision-gate/decisions.ts';
import { CONFIG_WRITE_STATUS, readConfigFile } from '../config-file.ts';
import { json, listQuery, readJsonObject, redact, requiredRevision, revisionRequired } from '../http.ts';
import { redactInspection } from '../config-inspection.ts';
import { keychainErrorStatus } from '../keychain-error.ts';
import { KeychainError } from '../../../platform/keychain.ts';
import type { CallerClass } from '../secret-input.ts';

export interface DecisionGateAdminDeps {
  readonly store: BusinessStore;
  /** The running configuration: `active` reports what the bot does now, not what the file asks for. */
  readonly configStore: Pick<RuntimeConfigurationStore, 'current'>;
  /** Absent when the process has no reloadable configuration (tests, panels). */
  readonly configReloader?: ConfigController | undefined;
  readonly secrets?: SecretStore | undefined;
}

/** A custom question plus the other nine fields stays far below this. */
const DECISION_GATE_BODY_MAX_BYTES = 32 * 1024;

/**
 * `/api/decision-gate` — the Decisions entry gate's settings page and the
 * read-only decision list.
 *
 * The write is an ordinary panel configuration write: an `If-Match` revision,
 * the same file-and-apply path as every other editor, and new credentials only
 * as keychain entries. The decision list is the audit surface `shadow` mode is
 * reviewed through, so it stays read-only and needs no `write` permission.
 */
export function createDecisionGateAdminHandler(deps: DecisionGateAdminDeps) {
  const { store, configStore, configReloader, secrets } = deps;

  const viewOf = async (file: Awaited<ReturnType<typeof readConfigFile>>, withSource: boolean) =>
    decisionGateView(
      decisionGateScope(file.loaded.fileConfig.telegram),
      decisionGateScope(configStore.current().config.telegram),
      file.revision,
      withSource,
    );

  const writeAndRespond = async (
    reloader: ConfigController,
    request: Request,
    caller: CallerClass,
  ): Promise<Response> => {
    const revision = requiredRevision(request);
    if (revision === null) {
      return revisionRequired();
    }
    const withSource = caller === 'session';
    const raw = await readJsonObject(request, DECISION_GATE_BODY_MAX_BYTES);
    // The submitted plaintext is registered before anything else can echo it —
    // the body's own validation included, whose errors name the offending field
    // — so a rejected write, an apply log and the response all stay clean.
    const plaintext = decisionGatePlaintext(raw.api_key);
    if (plaintext !== undefined) {
      secrets?.remember(plaintext);
    }
    const body = parseDecisionGateBody(raw);
    const current = await readConfigFile(reloader, secrets);
    if (revision !== current.revision) {
      return json({ error: 'config_conflict', message: 'The configuration file changed; reload before editing' }, 409);
    }
    const snapshot = await reloader.keychainSnapshot();
    const parsed = decisionGateEdits(current.loaded.fileConfig, body, caller, {
      entries: new Set(snapshot.entries.map((entry) => entry.name)),
      usage: snapshot.usage.file ?? {},
    });
    if (parsed.edits.length === 0 && parsed.secrets.add === undefined && parsed.secrets.replace === undefined) {
      // Nothing to write: reporting an empty apply keeps the bytes untouched
      // instead of failing on an edit that changes nothing.
      return json({
        ...(await viewOf(current, withSource)),
        apply: { applied: [], restart_required: [], outside_serve: [] },
      });
    }
    try {
      // One lock hold: revision check, exclusive-use re-check, keychain write
      // (with rollback), file edit (if any), apply.
      const result = await reloader.writeSecretsAndApply(parsed.edits, parsed.secrets, revision);
      if (!result.ok) {
        const message = result.fileWritten
          ? `config.jsonc was updated but not applied: ${result.message}`
          : result.message;
        return json({ error: result.code, message: redact(secrets, message) }, CONFIG_WRITE_STATUS[result.code] ?? 409);
      }
      // Read back through readConfigFile so the returned revision describes
      // the very file shown; a write slipping in between answers 409 instead
      // of pairing old values with a newer revision the client would reuse.
      return json({
        ...(await viewOf(await readConfigFile(reloader, secrets), withSource)),
        apply: {
          applied: result.applied,
          restart_required: result.restartRequired,
          outside_serve: result.outsideServe,
        },
      });
    } catch (error) {
      if (error instanceof KeychainError) {
        return json({ error: error.code, message: redact(secrets, error.message) }, keychainErrorStatus(error));
      }
      throw error;
    }
  };

  return {
    async handle(
      request: Request,
      url: URL,
      segments: readonly string[],
      caller: CallerClass,
    ): Promise<Response | undefined> {
      if (segments[0] !== 'decision-gate') {
        return undefined;
      }
      if (segments.join('/') === 'decision-gate/decisions') {
        if (request.method !== 'GET') {
          return json({ error: 'method_not_allowed', message: 'The decision list is read-only' }, 405);
        }
        const page = listBucketDecisions(store.orm, listQuery(url));
        return json(redactInspection(page, secrets));
      }
      if (segments.length !== 1) {
        return json({ error: 'not_found', message: 'Unknown decision gate route' }, 404);
      }
      const reloader = configReloader;
      if (reloader === undefined) {
        return json({ error: 'config_reload_unavailable', message: 'Configuration reloading is not wired' }, 503);
      }
      // `key_source` names a keychain entry, env var or command; only the panel
      // session is trusted with that, programmatic credentials get the boolean.
      const withSource = caller === 'session';
      if (request.method === 'GET') {
        return json(await viewOf(await readConfigFile(reloader, secrets), withSource));
      }
      if (request.method !== 'PUT') {
        return json({ error: 'method_not_allowed', message: 'Use GET or PUT for decision gate settings' }, 405);
      }
      return await writeAndRespond(reloader, request, caller);
    },
  };
}
