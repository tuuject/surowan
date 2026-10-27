import alarm from './alarm/index.ts';
import dictionary from './dictionary/index.ts';
import image from './image/index.ts';
import type { AgentPlugin } from './plugin.ts';
import brave from './web-search/providers/brave.ts';
import deepseek from './web-search/providers/deepseek.ts';
import exa from './web-search/providers/exa.ts';
import firecrawl from './web-search/providers/firecrawl.ts';
import searxng from './web-search/providers/searxng.ts';
import tavily from './web-search/providers/tavily.ts';
import youcom from './web-search/providers/youcom.ts';
import webFetch from './web-fetch/index.ts';
import webSearch from './web-search/index.ts';

/**
 * Built-in agent plugins. Every composition root loads this same list. The
 * image plugin contributes nothing unless the host wired an image bridge and
 * generation is enabled, so runtimes without image configuration are
 * unaffected. Search providers declare `web-search` as a dependency, so the
 * core loads first; `loadPlugins` rejects any other order.
 */
export const BUILTIN_PLUGINS: readonly AgentPlugin[] = [
  webSearch,
  tavily,
  brave,
  exa,
  firecrawl,
  deepseek,
  searxng,
  youcom,
  webFetch,
  image,
  alarm,
  dictionary,
];
