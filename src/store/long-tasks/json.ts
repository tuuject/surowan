import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import type { JsonValue } from '../../platform/invocation-context.ts';

const JsonValueSchema = Type.Union(
  [
    Type.Null(),
    Type.Boolean(),
    Type.Number(),
    Type.String(),
    Type.Array(Type.Ref('JsonValue')),
    Type.Record(Type.String(), Type.Ref('JsonValue')),
  ],
  { $id: 'JsonValue' },
);
const jsonValidator = Compile(JsonValueSchema);
export const MAX_JSON = 16_384;
export const MAX_ERROR = 8_192;

export function jsonText(value: unknown, limit: number, field: string): string {
  validateJsonStructure(value, new Set<object>());
  if (!jsonValidator.Check(value)) {
    throw new Error(`${field} must be a JSON value`);
  }
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > limit) {
    throw new Error(`${field} exceeds ${limit} bytes`);
  }
  return text;
}

function validateJsonStructure(value: unknown, ancestors: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('JSON number must be finite');
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new Error('value is not JSON serializable');
  }
  if (ancestors.has(value)) {
    throw new Error('JSON value must not contain cycles');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      validateJsonArray(value, ancestors);
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('JSON value must be a plain object');
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') {
        throw new Error('JSON object must not contain symbol keys');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
        throw new Error('JSON object must contain only enumerable data properties');
      }
      validateJsonStructure(descriptor.value, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function validateJsonArray(value: readonly unknown[], ancestors: Set<object>): void {
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key === 'symbol') {
      throw new Error('JSON array must not contain symbol keys');
    }
    if (key === 'length') {
      continue;
    }
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= value.length) {
      throw new Error('JSON array must not contain non-index properties');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      throw new Error('JSON array must contain only enumerable data properties');
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new Error('JSON array must not be sparse or contain accessors');
    }
    validateJsonStructure(descriptor.value, ancestors);
  }
}

export function parseJson(text: string, field: string): JsonValue {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Invalid ${field} in database`);
  }
  if (!jsonValidator.Check(value)) {
    throw new Error(`Invalid ${field} in database`);
  }
  return toJsonValue(value);
}

function toJsonValue(value: Static<typeof JsonValueSchema>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((child) => toJsonValue(child as Static<typeof JsonValueSchema>));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, toJsonValue(child as Static<typeof JsonValueSchema>)]),
  );
}
