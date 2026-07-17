import type { ByteArray } from "../client/common.ts";

// Things that JSON can encode directly
export type JSONPrimitive = string | number | boolean | null | undefined;
export type JSONValue = JSONPrimitive | JSONObject | JSONArray;
export type JSONObject = {[key: string]: JSONValue};
export type JSONArray = JSONValue[];

// Prebuilt types for decoding
export type FieldTypeIn =
  | 's' | 'n' | 'b' | 'd' | 'a'
  | ((obj: JSONValue) => any);
const FieldTypeNames = {
  // native to json
  s: 'string', n: 'number', b: 'boolean',
  // enriched
  d: 'date', a: 'blob',
};

type ResolveFieldTypeIn<
  T extends FieldTypeIn | [FieldTypeIn],
  U = T extends [infer R] ? R : T,
  V = U extends (obj: JSONValue) => null | infer R ? R
    : U extends 's' ? string
    : U extends 'n' ? number
    : U extends 'b' ? boolean
    : U extends 'd' ? Date
    : U extends 'a' ? ByteArray
    : never,
> = T extends [any] ? V[] : V;

export function readObj<
  R extends {[key: string]: (FieldTypeIn | [FieldTypeIn])},
  O extends {[key: string]: (FieldTypeIn | [FieldTypeIn])},
>(
  opts: {
    required: R,
    optional: O,
    remap?: {[key: string]: keyof R | keyof O},
  },
  data: JSONValue,
): {[key in keyof R | keyof O]
  : key extends keyof R ? ResolveFieldTypeIn<R[key]>
  : key extends keyof O ? (ResolveFieldTypeIn<O[key]> | null)
  : never
} {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Object wasn't an object, was ${typeof data}, wanted keys ${JSON.stringify(Object.keys(opts.required).concat(Object.keys(opts.optional)))}`);
  }

  const remap = opts.remap ?? {};
  const missing = new Set<string>(Object.keys(opts.required));
  const problems = new Array<string>();
  const obj = Object.create(null);

  for (const [key, raw] of Object.entries(data)) {
    const targetName = key in remap ? remap[key].toString() : key;
    const isRequired = targetName in opts.required;
    if (!isRequired && !(targetName in opts.optional)) continue;

    if (raw == null) {
      obj[targetName] = null;
    } else {
      const typeSig = isRequired ? opts.required[targetName] : opts.optional[targetName];
      const value = readField(typeSig, raw);
      if (value == null) {
        problems.push(`Key ${key} of type ${typeof raw} failed to parse as ${typeof typeSig === 'string' ? FieldTypeNames[typeSig] : typeof typeSig}`);
      } else {
        missing.delete(targetName);
      }
      obj[targetName] = value;
    }
  }
  if (problems.length > 0) throw new Error(`BUG: JSON object `+
    `failed to read some keys: ${problems.join(' ; ')
    } - had keys ${JSON.stringify(Object.keys(data))}`);
  if (missing.size > 0) throwMissingKeys(missing, Object.keys(data));

  return obj;
}

function readField(typeSig: FieldTypeIn | [FieldTypeIn], raw: JSONValue): unknown {
  if (raw == null) return null;
  switch (typeSig) {
    case 's':
      return typeof raw === 'string' ? raw : null;
    case 'n':
      return typeof raw === 'number' ? raw : null;
    case 'b':
      return typeof raw === 'boolean' ? raw : null
    case 'd':
      return readDate(raw);
    case 'a':
      if (typeof raw === 'string') {
        return decodeBase64(raw);
      }
      break;
    default:
      if (typeof typeSig === 'function') {
        return typeSig(raw);
      } else if (Array.isArray(typeSig)) {
        if (Array.isArray(raw)) {
          return raw.map(readField.bind(null, typeSig[0]));
        }
      }
  }
  return null;
}

function throwMissingKeys(missingKeys: Iterable<string>, hadKeys: Iterable<string>): never {
  throw new Error(`BUG: JSON object `+
    `missing required keys ${JSON.stringify(Array.from(missingKeys))
    } - had keys ${JSON.stringify(Array.from(hadKeys))}`);
}

export function serializeDate_unixTimestamp(input: Date | number | null | undefined): JSONValue {
  if (input == null) return input;
  const date = typeof input === 'number' ? new Date(input*1000) : input;
  return Math.floor(date.valueOf() / 1000);
}
export function serializeDate_iso8601(input: Date | number | null | undefined): JSONValue {
  if (input == null) return input;
  const date = typeof input === 'number' ? new Date(input*1000) : input;
  return date.toISOString().replace(/\.000Z$/, 'Z');
}
export function serializeDate_rfc822(input: Date | number | null | undefined): JSONValue {
  if (input == null) return input;
  const date = typeof input === 'number' ? new Date(input*1000) : input;
  return date.toUTCString();
}


export function readDate(raw: JSONValue): Date | null {
  if (typeof raw === 'string') {
    const date = new Date(raw);
    if (!isNaN(date.valueOf())) return date;
  } else if (typeof raw === 'number') {
    // TODO: check range of number? 1970-2038 would be pretty safe
    return new Date(raw * 1000);
  }
  return null;
}


export function serializeMap<T,U extends JSONValue>(input: {[key: string]: T} | null | undefined, encoder: (x: T) => U): JSONValue {
  if (input == null) return input;
  const map: {[key: string]: U} = Object.create(null);
  for (const [key, val] of Object.entries(input)) {
    map[key] = encoder(val);
  }
  return map;
}

// TODO: do these fields want "null" or an actual null if optional?
export function serializeJsonValue(input: JSONValue): string | undefined {
  if (input === undefined) return input;
  return JSON.stringify(input);
}
export function readJsonValue(input: JSONValue): JSONValue {
  if (input == null || input == '') return undefined;
  if (typeof input !== 'string') throw new Error(`Server's JSON Value was ${typeof input} instead of string`);
  return JSON.parse(input);
}
export function readJsonValueBase64(input: JSONValue): JSONValue {
  if (input == null || input == '') return undefined;
  if (typeof input !== 'string') throw new Error(`Server's JSON Value was ${typeof input} instead of string`);
  return JSON.parse(atob(input));
}

// from https://deno.land/std@0.140.0/encoding/base64.ts
function decodeBase64(b64: string): ByteArray {
  const binString = atob(b64);
  const size = binString.length;
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    bytes[i] = binString.charCodeAt(i);
  }
  return bytes;
}

export function readMap<K extends string,V>(keyEncoder: (x: string) => K, valEncoder: (x: JSONValue) => V, input: JSONValue): Record<K,V> | null {
  if (input == null) return null;
  const map: Record<K,V> = Object.create(null);
  for (const [key, val] of Object.entries(input)) {
    map[keyEncoder(key)] = valEncoder(val);
  }
  return map;
}

export function readList<V>(encoder: (x: JSONValue) => V, raw: JSONValue): V[] | null {
  if (Array.isArray(raw)) {
    return raw.map(encoder);
  }
  return null;
}

export function readNum(raw: JSONValue): number {
  if (typeof raw === 'number') return raw;
  throw new Error(`readNum wanted a number, got a ${typeof raw}`);
}
