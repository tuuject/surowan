import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Baked from user manuals into src/platform/prompts/product-knowledge.md with skills/surowan-dev-bake-product-knowledge/SKILL.md.
export const PRODUCT_KNOWLEDGE_INDEX = readFileSync(
  join(import.meta.dirname, 'prompts', 'product-knowledge.md'),
  'utf8',
).trim();
