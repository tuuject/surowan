/**
 * Walks the compiled TypeBox `ConfigSchema` and flattens it into one entry per
 * field. Reading the schema rather than a hand-written table keeps the reference
 * in step with the code: a new field, limit or union branch shows up here without
 * anyone editing the generator.
 */

/** The Schema keywords `ConfigSchema` actually uses; nothing else is read. */
export interface SchemaNode {
  type?: string;
  const?: unknown;
  anyOf?: SchemaNode[];
  properties?: Record<string, SchemaNode>;
  patternProperties?: Record<string, SchemaNode>;
  required?: string[] | undefined;
  items?: SchemaNode;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  uniqueItems?: boolean;
  default?: unknown;
  description?: string | undefined;
  deprecated?: boolean;
}

/** The two markers a displayed path carries; text lives in `text.ts`. */
export interface WalkLabels {
  readonly patternKey: string;
  readonly unionBranch: (index: number) => string;
}

/** One field of the reference, in the order the page prints it. */
export interface FieldEntry {
  /** Path as displayed, including union-branch and pattern markers. */
  readonly name: string;
  /** Path without those markers, used to look up a runtime default. */
  readonly key: string;
  readonly schema: SchemaNode;
  readonly required: boolean;
  readonly depth: number;
  /** The pattern a `patternProperties` key must match; the entry itself is the value shape. */
  readonly keyPattern?: string;
}

/** Value keywords of a node, in a stable order. */
const LIMIT_KEYWORDS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
  'uniqueItems',
] as const;

export function limitLabels(schema: SchemaNode): string[] {
  return LIMIT_KEYWORDS.filter((key) => schema[key] !== undefined).map(
    (key) => `${key}: ${JSON.stringify(schema[key])}`,
  );
}

/**
 * Limits that belong to a non-object union branch. `mcp.servers[].tools` is
 * `"*"` or a string array: the array's `uniqueItems` belongs to that branch, not
 * to the field, so it would otherwise disappear from the reference.
 */
export function branchLimits(
  schema: SchemaNode,
  labels: WalkLabels,
): { readonly branch: string; readonly limits: readonly string[] }[] {
  const result: { branch: string; limits: string[] }[] = [];
  for (const [index, child] of (schema.anyOf ?? []).entries()) {
    if (child.type === 'object') {
      continue;
    }
    const limits = limitLabels(child);
    if (limits.length > 0) {
      result.push({ branch: labels.unionBranch(index), limits });
    }
  }
  return result;
}

export function typeLabel(schema: SchemaNode): string {
  if ('const' in schema) {
    return JSON.stringify(schema.const);
  }
  if (schema.anyOf) {
    return schema.anyOf.map(typeLabel).join(' / ');
  }
  if (!schema.type) {
    throw new Error('Unsupported configuration schema node');
  }
  return schema.type;
}

/** Whether a top-level field has fields of its own, and so a page of its own. */
export function hasFields(schema: SchemaNode): boolean {
  return (
    schema.properties !== undefined ||
    schema.patternProperties !== undefined ||
    schema.items !== undefined ||
    (schema.anyOf ?? []).some((child) => child.type === 'object' || child.items !== undefined)
  );
}

/**
 * Every field below `schema`, depth-first in declaration order. `key` drops the
 * markers a displayed path carries so the defaults table can be keyed by the
 * plain configuration path: `telegram.chats[].participation.attention_window_seconds`.
 */
export function collectFields(
  schema: SchemaNode,
  labels: WalkLabels,
  name: string,
  key: string,
  required: boolean,
  depth: number,
  keyPattern?: string,
): readonly FieldEntry[] {
  const entries: FieldEntry[] = [
    { name, key, schema, required, depth, ...(keyPattern === undefined ? {} : { keyPattern }) },
  ];
  for (const [childName, child] of Object.entries(schema.properties ?? {})) {
    entries.push(
      ...collectFields(
        child,
        labels,
        `${name}.${childName}`,
        `${key}.${childName}`,
        schema.required?.includes(childName) ?? false,
        depth + 1,
      ),
    );
  }
  // A record constrains its key names as well as its values: `image.credentials`
  // accepts only `^[a-zA-Z0-9_-]{1,80}$` keys, which the value shape alone hides.
  for (const [pattern, child] of Object.entries(schema.patternProperties ?? {})) {
    entries.push(
      ...collectFields(child, labels, `${name}.<${labels.patternKey}>`, `${key}.<*>`, false, depth + 1, pattern),
    );
  }
  if (schema.items) {
    entries.push(...collectFields(schema.items, labels, `${name}[]`, `${key}[]`, true, depth + 1));
  }
  const arrayBranches = (schema.anyOf ?? []).filter((child) => child.type !== 'object' && child.items !== undefined);
  for (const [index, child] of (schema.anyOf ?? []).entries()) {
    if (child.type === 'object') {
      entries.push(...collectFields(child, labels, `${name}${labels.unionBranch(index)}`, key, required, depth + 1));
      continue;
    }
    if (child.items) {
      // Only an ambiguous union needs the marker; one array branch is the only
      // way the field can be a list.
      const branch = arrayBranches.length > 1 ? labels.unionBranch(index) : '';
      entries.push(...collectFields(child.items, labels, `${name}[]${branch}`, `${key}[]`, true, depth + 1));
    }
  }
  return entries;
}
