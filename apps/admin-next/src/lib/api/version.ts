import { call } from './core.ts';

export type VersionChannel = 'Release' | 'Staging' | 'Develop';

export interface RuntimeVersion {
  readonly version: string;
  readonly channel: VersionChannel;
}

export function getVersion(): Promise<RuntimeVersion> {
  return call<RuntimeVersion>('/version');
}
