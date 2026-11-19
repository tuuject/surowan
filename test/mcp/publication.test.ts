/**
 * The publication's registry validator: each MCP binding's tool set is checked
 * against a preview of ITS OWN host, because validateAdditionalTools builds
 * host-specific built-ins from context.hostKind.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { createMcpPublication } from '../../src/adapters/local-monolith/runtime/mcp-publication.ts';
import type { McpManager } from '../../src/capabilities/mcp/index.ts';
import type { RegistryValidator } from '../../src/capabilities/mcp/support.ts';
import type { AgentRuntime } from '../../src/orchestration/agent-runtime/index.ts';
import type { ConversationRuntime } from '../../src/orchestration/conversation-runtime.ts';
import type { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import type { HostKind } from '../../src/platform/im-host/identity.ts';
import type { InvocationContext } from '../../src/platform/invocation-context.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { testConfigStore, writeTestConfig } from '../helpers.ts';

test('the registry validator previews each binding under its own host', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-mcp-publication-'));
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  try {
    let validator: RegistryValidator | undefined;
    const mcp = {
      toolSets: () => [],
      setRegistryValidator: (next: RegistryValidator) => {
        validator = next;
      },
    } as unknown as McpManager;
    const previewHosts: HostKind[] = [];
    const runtime = {
      validateAdditionalTools: (context: InvocationContext) => {
        previewHosts.push(context.hostKind);
      },
    } as unknown as AgentRuntime;
    const publication = createMcpPublication({
      store,
      configStore,
      secrets: new SecretStore(),
      scheduler: {} as BucketScheduler,
      conversationRuntime: {
        isRoundInProgress: () => false,
        forget: () => {},
      } as unknown as ConversationRuntime,
      isHostReady: () => true,
      mcp,
      runtime,
    });
    publication.validateRegistry();
    if (validator === undefined) {
      throw new Error('Expected a registry validator');
    }
    // The base registry is checked once per host: a fixed-Telegram preview
    // would leave 'playground' unvalidated.
    expect(previewHosts).toEqual(['telegram', 'playground']);
    // A binding hands ITS OWN host to validation, so the built-ins measured
    // are that host's.
    previewHosts.length = 0;
    validator([], [123456789], 'telegram');
    expect(previewHosts).toEqual(['telegram']);
  } finally {
    store.close();
  }
});
