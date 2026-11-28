import { createHash } from "node:crypto";

export const INT64_MIN = -(1n << 63n); // -9223372036854775808n
export const INT64_MAX = (1n << 63n) - 1n; // 9223372036854775807n

export type SplObject = { [key: string]: SplValue };
export type SplValue =
  | null
  | boolean
  | bigint
  | number
  | string
  | SplValue[]
  | SplObject;

export type SplTrapCode =
  | "LIMIT_EXCEEDED"
  | "NUM_OVERFLOW"
  | "DIV_BY_ZERO"
  | "FLOAT_NON_FINITE"
  | "SHIFT_OUT_OF_RANGE"
  | "INDEX_OUT_OF_BOUNDS"
  | "REPLAY_DIVERGENCE"
  | "UNHANDLED_ERROR"
  | "VM_INVARIANT_VIOLATION";

export interface SplErrorValue {
  code: string;
  message: string;
  retryable: boolean;
  details: SplValue;
}

export class SplTrapError extends Error {
  constructor(
    public readonly trapCode: SplTrapCode,
    message: string
  ) {
    super(message);
    this.name = "SplTrapError";
  }
}

export class SplRecoverableError extends Error {
  public readonly errObj: SplErrorValue;
  constructor(code: string, message: string, retryable = false, details: SplValue = null) {
    super(message);
    this.name = "SplRecoverableError";
    this.errObj = makeSplObject([
      ["code", code],
      ["details", details],
      ["message", message],
      ["retryable", retryable],
    ]) as unknown as SplErrorValue;
  }
}

/**
 * Safely define a key on a plain object without triggering __proto__ prototype mutation.
 */
export function setOwnProp(obj: SplObject, key: string, value: SplValue): void {
  Object.defineProperty(obj, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Construct a plain object with keys sorted in canonical Unicode code-point order.
 */
export function makeSplObject(entries: Iterable<[string, SplValue]>): SplObject {
  const arr = Array.from(entries);
  arr.sort((a, b) => compareCodePoints(a[0], b[0]));
  const out: SplObject = {};
  for (const [k, v] of arr) {
    setOwnProp(out, k, v);
  }
  return out;
}

/**
 * Compare two strings strictly by Unicode scalar value (UTF-8 byte order).
 * Unlike JS `<`, this places U+E000..U+FFFF before U+10000..U+10FFFF.
 */
export function compareCodePoints(a: string, b: string): number {
  let ia = 0;
  let ib = 0;
  const la = a.length;
  const lb = b.length;
  while (ia < la && ib < lb) {
    const ca = a.codePointAt(ia)!;
    const cb = b.codePointAt(ib)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
    ia += ca > 0xffff ? 2 : 1;
    ib += cb > 0xffff ? 2 : 1;
  }
  if (ia < la) return 1;
  if (ib < lb) return -1;
  return 0;
}

export function sortKeysCodePoint(keys: Iterable<string>): string[] {
  return Array.from(keys).sort(compareCodePoints);
}

export function toCodePoints(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i)!;
    const step = cp > 0xffff ? 2 : 1;
    out.push(s.slice(i, i + step));
    i += step;
  }
  return out;
}

export function codePointLength(s: string): number {
  let count = 0;
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    count++;
  }
  return count;
}

export function codePointAtIndex(s: string, index: number): string {
  if (index < 0) {
    throw new SplTrapError("INDEX_OUT_OF_BOUNDS", `String index ${index} out of bounds`);
  }
  let cur = 0;
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i)!;
    const step = cp > 0xffff ? 2 : 1;
    if (cur === index) return s.slice(i, i + step);
    i += step;
    cur++;
  }
  throw new SplTrapError("INDEX_OUT_OF_BOUNDS", `String index ${index} out of bounds (len ${cur})`);
}

export function codePointSlice(s: string, start: number, end: number): string {
  const cps = toCodePoints(s);
  if (start < 0 || end < start || end > cps.length) {
    throw new SplTrapError(
      "INDEX_OUT_OF_BOUNDS",
      `String slice [${start}, ${end}) out of bounds for length ${cps.length}`
    );
  }
  return cps.slice(start, end).join("");
}

export function checkInt64(n: bigint): bigint {
  if (n < INT64_MIN || n > INT64_MAX) {
    throw new SplTrapError("NUM_OVERFLOW", `Int64 overflow: ${n.toString()}`);
  }
  return n;
}

export function normalizeFloat(n: number): number {
  if (!Number.isFinite(n)) {
    throw new SplTrapError("FLOAT_NON_FINITE", `Non-finite float value: ${String(n)}`);
  }
  return Object.is(n, -0) ? 0 : n;
}

export function formatFloatCanonical(n: number): string {
  const norm = normalizeFloat(n);
  return String(norm);
}

export function formatValueForTemplate(v: SplValue): string {
  if (typeof v === "string") return v;
  if (typeof v === "bigint") return v.toString(10);
  if (typeof v === "number") return formatFloatCanonical(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  throw new SplTrapError("VM_INVARIANT_VIOLATION", `Cannot format value of type ${typeof v} in template`);
}

export function escapeJsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x22) out += '\\"';
    else if (code === 0x5c) out += "\\\\";
    else if (code === 0x08) out += "\\b";
    else if (code === 0x0c) out += "\\f";
    else if (code === 0x0a) out += "\\n";
    else if (code === 0x0d) out += "\\r";
    else if (code === 0x09) out += "\\t";
    else if (code < 0x20) {
      out += "\\u" + code.toString(16).padStart(4, "0");
    } else {
      out += s[i];
    }
  }
  out += '"';
  return out;
}

/**
 * §5.1 Canonical JSON serialization.
 */
export function canonicalJsonStringify(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "bigint") {
    checkInt64(v);
    return v.toString(10);
  }
  if (typeof v === "number") {
    return formatFloatCanonical(v);
  }
  if (typeof v === "string") {
    return escapeJsonString(v);
  }
  if (Array.isArray(v)) {
    let out = "[";
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ",";
      out += canonicalJsonStringify(v[i]);
    }
    return out + "]";
  }
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = sortKeysCodePoint(Object.keys(obj).filter((k) => obj[k] !== undefined));
    let out = "{";
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) out += ",";
      const k = keys[i];
      out += escapeJsonString(k) + ":" + canonicalJsonStringify(obj[k]);
    }
    return out + "}";
  }
  throw new SplTrapError("VM_INVARIANT_VIOLATION", `Cannot serialize unsupported value type: ${typeof v}`);
}

/**
 * Strict RFC 8259 JSON parser preserving exact signed 64-bit integer tokens as bigint
 * and decimal/exponent numbers as finite float64.
 */
export function canonicalJsonParse(text: string): SplValue {
  let pos = 0;
  const len = text.length;

  function skipWs(): void {
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) pos++;
      else break;
    }
  }

  function parseValue(): SplValue {
    skipWs();
    if (pos >= len) throw new SyntaxError("Unexpected end of JSON input");
    const c = text[pos];
    if (c === '"') return parseString();
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === "t") return parseLiteral("true", true);
    if (c === "f") return parseLiteral("false", false);
    if (c === "n") return parseLiteral("null", null);
    if (c === "-" || (c >= "0" && c <= "9")) return parseNumber();
    throw new SyntaxError(`Unexpected character '${c}' at position ${pos}`);
  }

  function parseLiteral<T extends SplValue>(lit: string, val: T): T {
    if (text.startsWith(lit, pos)) {
      pos += lit.length;
      return val;
    }
    throw new SyntaxError(`Expected '${lit}' at position ${pos}`);
  }

  function parseString(): string {
    pos++; // skip opening "
    let out = "";
    while (pos < len) {
      const ch = text[pos];
      const code = text.charCodeAt(pos);
      if (ch === '"') {
        pos++;
        return out;
      }
      if (code < 0x20) {
        throw new SyntaxError(`Unescaped control character in string at position ${pos}`);
      }
      if (ch === "\\") {
        pos++;
        if (pos >= len) throw new SyntaxError("Unterminated escape in string");
        const esc = text[pos++];
        if (esc === '"') out += '"';
        else if (esc === "\\") out += "\\";
        else if (esc === "/") out += "/";
        else if (esc === "b") out += "\b";
        else if (esc === "f") out += "\f";
        else if (esc === "n") out += "\n";
        else if (esc === "r") out += "\r";
        else if (esc === "t") out += "\t";
        else if (esc === "u") {
          const hex = text.slice(pos, pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new SyntaxError(`Invalid \\u escape at position ${pos}`);
          }
          pos += 4;
          out += String.fromCharCode(parseInt(hex, 16));
        } else {
          throw new SyntaxError(`Invalid escape \\${esc} at position ${pos - 1}`);
        }
      } else {
        out += ch;
        pos++;
      }
    }
    throw new SyntaxError("Unterminated JSON string");
  }

  function parseNumber(): bigint | number {
    const start = pos;
    if (text[pos] === "-") pos++;
    if (pos >= len) throw new SyntaxError("Invalid JSON number");
    if (text[pos] === "0") {
      pos++;
    } else if (text[pos] >= "1" && text[pos] <= "9") {
      while (pos < len && text[pos] >= "0" && text[pos] <= "9") pos++;
    } else {
      throw new SyntaxError(`Invalid JSON number at position ${start}`);
    }
    let isFloat = false;
    if (pos < len && text[pos] === ".") {
      isFloat = true;
      pos++;
      if (pos >= len || text[pos] < "0" || text[pos] > "9") {
        throw new SyntaxError(`Invalid JSON fraction at position ${pos}`);
      }
      while (pos < len && text[pos] >= "0" && text[pos] <= "9") pos++;
    }
    if (pos < len && (text[pos] === "e" || text[pos] === "E")) {
      isFloat = true;
      pos++;
      if (pos < len && (text[pos] === "+" || text[pos] === "-")) pos++;
      if (pos >= len || text[pos] < "0" || text[pos] > "9") {
        throw new SyntaxError(`Invalid JSON exponent at position ${pos}`);
      }
      while (pos < len && text[pos] >= "0" && text[pos] <= "9") pos++;
    }
    const raw = text.slice(start, pos);
    if (!isFloat) {
      if (raw === "-0") return 0n;
      const bi = BigInt(raw);
      if (bi >= INT64_MIN && bi <= INT64_MAX) {
        return bi;
      }
      // Outside int64 range: fall back to finite float64
      const num = Number(raw);
      if (!Number.isFinite(num)) throw new SyntaxError(`Non-finite JSON number: ${raw}`);
      return normalizeFloat(num);
    }
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      throw new SyntaxError(`Non-finite JSON number: ${raw}`);
    }
    return normalizeFloat(num);
  }

  function parseArray(): SplValue[] {
    pos++; // [
    const arr: SplValue[] = [];
    skipWs();
    if (pos < len && text[pos] === "]") {
      pos++;
      return arr;
    }
    while (true) {
      arr.push(parseValue());
      skipWs();
      if (pos >= len) throw new SyntaxError("Unterminated JSON array");
      if (text[pos] === ",") {
        pos++;
        continue;
      }
      if (text[pos] === "]") {
        pos++;
        return arr;
      }
      throw new SyntaxError(`Expected ',' or ']' at position ${pos}`);
    }
  }

  function parseObject(): SplObject {
    pos++; // {
    const entries = new Map<string, SplValue>();
    skipWs();
    if (pos < len && text[pos] === "}") {
      pos++;
      return {};
    }
    while (true) {
      skipWs();
      if (pos >= len || text[pos] !== '"') {
        throw new SyntaxError(`Expected string key at position ${pos}`);
      }
      const key = parseString();
      skipWs();
      if (pos >= len || text[pos] !== ":") {
        throw new SyntaxError(`Expected ':' at position ${pos}`);
      }
      pos++;
      const val = parseValue();
      entries.set(key, val);
      skipWs();
      if (pos >= len) throw new SyntaxError("Unterminated JSON object");
      if (text[pos] === ",") {
        pos++;
        continue;
      }
      if (text[pos] === "}") {
        pos++;
        return makeSplObject(entries.entries());
      }
      throw new SyntaxError(`Expected ',' or '}' at position ${pos}`);
    }
  }

  const result = parseValue();
  skipWs();
  if (pos !== len) {
    throw new SyntaxError(`Trailing characters in JSON at position ${pos}`);
  }
  return result;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function deepCloneSpl(v: SplValue): SplValue {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((item) => deepCloneSpl(item));
  const keys = sortKeysCodePoint(Object.keys(v));
  const out: SplObject = {};
  for (const k of keys) {
    setOwnProp(out, k, deepCloneSpl(v[k]));
  }
  return out;
}

export function deepEqualSpl(a: SplValue, b: SplValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === "number" && typeof b === "number") {
    return normalizeFloat(a) === normalizeFloat(b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualSpl(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqualSpl(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

/**
 * §9.2 Deterministic logical memory accounting formula.
 */
export function logicalSizeBytes(v: SplValue): number {
  if (v === null || typeof v === "boolean" || typeof v === "bigint" || typeof v === "number") {
    return 8;
  }
  if (typeof v === "string") {
    return 16 + Buffer.byteLength(v, "utf8");
  }
  if (Array.isArray(v)) {
    let total = 24;
    for (const item of v) total += logicalSizeBytes(item);
    return total;
  }
  let total = 24;
  for (const k of Object.keys(v)) {
    total += 16 + Buffer.byteLength(k, "utf8") + logicalSizeBytes(v[k]);
  }
  return total;
}

/**
 * Count structural work units for step accounting on deep ops.
 */
export function structuralWorkUnits(v: SplValue): number {
  if (v === null || typeof v === "boolean" || typeof v === "bigint" || typeof v === "number") {
    return 1;
  }
  if (typeof v === "string") {
    return Math.max(1, codePointLength(v));
  }
  if (Array.isArray(v)) {
    let total = 1;
    for (const item of v) total += structuralWorkUnits(item);
    return total;
  }
  let total = 1;
  for (const k of Object.keys(v)) {
    total += 1 + structuralWorkUnits(v[k]);
  }
  return total;
}
