import { type AgentAssetSummary, listSchema, type Page } from '@surowan/image-service';
import type { ImageCoreHandle } from './index.ts';

/**
 * The agent-facing asset library: the promoted, non-archived projection in
 * text form. Permissions always resolve through `getAgentVisible` (one id,
 * one check); the paged and full reads exist for discovery, not authorization.
 */

/** Page size for full-library reads; one page more than the list API's max. */
const LIBRARY_PAGE = 100;

export interface LibraryDeps {
  readonly core: ImageCoreHandle;
}

export function createLibrary(deps: LibraryDeps) {
  const { core } = deps;

  /** The agent-facing asset library: promoted, non-archived rows, text metadata only. */
  function agentAssets(query: { q: string; limit: number; offset: number }): Page<AgentAssetSummary> {
    return core.images.listAgentVisible(listSchema.parse({ q: query.q, limit: query.limit, offset: query.offset }));
  }

  /** One agent-usable asset, or null when private, archived or unknown. */
  function agentAsset(id: string): AgentAssetSummary | null {
    return core.images.getAgentVisible(id);
  }

  /**
   * Every promoted, non-archived asset, all pages collected. The paged reads
   * stay bounded; this full projection exists for consumers that filter the
   * whole library themselves (the replay scene snapshot). Pagination is by
   * `createdAt` order, so a concurrent promotion may be missed or double-read
   * across a page boundary — acceptable for a snapshot, never for a permission
   * decision (those go through `agentAsset`/`getAgentVisible`).
   */
  function agentAssetLibrary(): readonly AgentAssetSummary[] {
    const collected: AgentAssetSummary[] = [];
    for (let offset = 0; ; offset += LIBRARY_PAGE) {
      const page = core.images.listAgentVisible(listSchema.parse({ q: '', limit: LIBRARY_PAGE, offset }));
      collected.push(...page.items);
      if (page.items.length < LIBRARY_PAGE || collected.length >= page.total) {
        return collected;
      }
    }
  }

  return { agentAssets, agentAsset, agentAssetLibrary };
}
