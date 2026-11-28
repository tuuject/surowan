import type { RawConfig } from '../../../platform/config/index.ts';
import type { TelegramTokenSource } from '../telegram/connection-token.ts';

/**
 * The image configuration gateway. The reloader prepares a candidate snapshot
 * (resolving SecretRefs) before anything is published and republishes it
 * together with the configuration; a failed prepare keeps the old snapshot.
 * Optional: absent when the process runs without the image service.
 *
 * A prepared snapshot's `version` is its identity: it must change whenever the
 * snapshot's content does, resolved credentials included, because the reloader
 * compares it instead of the snapshot to decide whether to republish.
 */
export interface ImageConfigGateway {
  prepare: (candidate: RawConfig) => Promise<PreparedImageConfig | undefined>;
  publish: (snapshot: PreparedImageConfig | undefined) => void;
}

/** What the reloader needs to know about an image snapshot; the rest is the service's. */
export interface PreparedImageConfig {
  readonly version: string;
}

/**
 * The Telegram token gateway. Preparing a candidate turns the configured
 * SecretRef into one of three states and never fails an apply: an unreadable
 * token is a connection problem the manager reports, not a bad file. Publishing
 * only hands the source over; the manager decides whether that means a restart,
 * a stop or nothing at all.
 */
export interface TelegramConfigGateway {
  prepare: (candidate: RawConfig) => Promise<TelegramTokenSource>;
  publish: (source: TelegramTokenSource) => void;
}
