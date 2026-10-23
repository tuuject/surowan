// ---------------------------------------------------------------------------
// Image generation domain (from @plasticwan/image-service)
//
// The image-domain tables are defined in the private image-service package and
// aggregated here so host-side queries (Admin audit, future plugins) see one
// schema. The authoritative DDL is migration 024; the package's definitions
// must stay in sync with it. Host IDs stay bigint (`sqliteBigInt`); image
// tables use text UUIDs with `safeInteger` counters inside the package.
// ---------------------------------------------------------------------------
export {
  generationAttempts as imageGenerationAttempts,
  generations as imageGenerations,
  idempotencyKeys as imageIdempotencyKeys,
  images as imageAssets,
  prompts as imagePrompts,
} from '@plasticwan/image-service';
