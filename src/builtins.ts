import {
  SplObject,
  SplRecoverableError,
  SplTrapError,
  SplValue,
  canonicalJsonParse,
  canonicalJsonStringify,
  checkInt64,
  codePointLength,
  codePointSlice,
  deepCloneSpl,
  deepEqualSpl,
  makeSplObject,
  normalizeFloat,
  sortKeysCodePoint,
  structuralWorkUnits,
} from "./canonical.js";

export interface BuiltinResult {
  value: SplValue;
  workUnits: number;
}

export function callBuiltin(id: string, args: SplValue[]): BuiltinResult {
  switch (id) {
    case "len": {
      const x = args[0];
      if (typeof x === "string") {
        const l = codePointLength(x);
        return { value: BigInt(l), workUnits: l };
      }
      if (Array.isArray(x)) {
        return { value: BigInt(x.length), workUnits: 1 };
      }
      if (x !== null && typeof x === "object") {
        const n = Object.keys(x).length;
        return { value: BigInt(n), workUnits: n };
      }
      throw new SplTrapError("VM_INVARIANT_VIOLATION", `len() unsupported runtime type`);
    }

    // --- str.* ---
    case "str.slice": {
      const s = args[0] as string;
      const start = Number(args[1] as bigint);
      const end = Number(args[2] as bigint);
      const res = codePointSlice(s, start, end);
      return { value: res, workUnits: codePointLength(s) };
    }
    case "str.split": {
      const s = args[0] as string;
      const sep = args[1] as string;
      const parts = sep === "" ? Array.from(s) : s.split(sep);
      return { value: parts, workUnits: codePointLength(s) };
    }
    case "str.join": {
      const parts = args[0] as string[];
      const sep = args[1] as string;
      const joined = parts.join(sep);
      return { value: joined, workUnits: codePointLength(joined) + parts.length };
    }
    case "str.trim": {
      const s = args[0] as string;
      return { value: s.trim(), workUnits: codePointLength(s) };
    }
    case "str.lower": {
      const s = args[0] as string;
      return { value: s.toLowerCase(), workUnits: codePointLength(s) };
    }
    case "str.upper": {
      const s = args[0] as string;
      return { value: s.toUpperCase(), workUnits: codePointLength(s) };
    }
    case "str.contains": {
      const s = args[0] as string;
      const sub = args[1] as string;
      return { value: s.includes(sub), workUnits: codePointLength(s) };
    }
    case "str.starts_with": {
      const s = args[0] as string;
      const p = args[1] as string;
      return { value: s.startsWith(p), workUnits: codePointLength(p) };
    }
    case "str.ends_with": {
      const s = args[0] as string;
      const p = args[1] as string;
      return { value: s.endsWith(p), workUnits: codePointLength(p) };
    }
    case "str.replace": {
      const s = args[0] as string;
      const from = args[1] as string;
      const to = args[2] as string;
      const out = s.split(from).join(to);
      return { value: out, workUnits: codePointLength(s) + codePointLength(out) };
    }

    // --- list.* (value-semantic copies) ---
    case "list.push": {
      const xs = args[0] as SplValue[];
      const val = args[1];
      const next = [...xs.map(deepCloneSpl), deepCloneSpl(val)];
      return { value: next, workUnits: xs.length + 1 };
    }
    case "list.slice": {
      const xs = args[0] as SplValue[];
      const start = Number(args[1] as bigint);
      const end = Number(args[2] as bigint);
      if (start < 0 || end < start || end > xs.length) {
        throw new SplTrapError(
          "INDEX_OUT_OF_BOUNDS",
          `list.slice [${start}, ${end}) out of bounds for length ${xs.length}`
        );
      }
      const next = xs.slice(start, end).map(deepCloneSpl);
      return { value: next, workUnits: next.length };
    }
    case "list.concat": {
      const a = args[0] as SplValue[];
      const b = args[1] as SplValue[];
      const next = [...a.map(deepCloneSpl), ...b.map(deepCloneSpl)];
      return { value: next, workUnits: next.length };
    }
    case "list.contains": {
      const xs = args[0] as SplValue[];
      const target = args[1];
      let work = 0;
      for (const item of xs) {
        work += structuralWorkUnits(item);
        if (deepEqualSpl(item, target)) return { value: true, workUnits: work };
      }
      return { value: false, workUnits: work };
    }

    // --- map.* (value-semantic, canonical code-point order) ---
    case "map.has": {
      const m = args[0] as SplObject;
      const k = args[1] as string;
      return { value: Object.prototype.hasOwnProperty.call(m, k), workUnits: 1 };
    }
    case "map.get": {
      const m = args[0] as SplObject;
      const k = args[1] as string;
      if (!Object.prototype.hasOwnProperty.call(m, k)) return { value: null, workUnits: 1 };
      return { value: deepCloneSpl(m[k]), workUnits: 1 };
    }
    case "map.set": {
      const m = args[0] as SplObject;
      const k = args[1] as string;
      const v = args[2];
      const entries: Array<[string, SplValue]> = [];
      let replaced = false;
      for (const key of Object.keys(m)) {
        if (key === k) {
          entries.push([k, deepCloneSpl(v)]);
          replaced = true;
        } else {
          entries.push([key, deepCloneSpl(m[key])]);
        }
      }
      if (!replaced) entries.push([k, deepCloneSpl(v)]);
      return { value: makeSplObject(entries), workUnits: entries.length };
    }
    case "map.delete": {
      const m = args[0] as SplObject;
      const k = args[1] as string;
      const entries: Array<[string, SplValue]> = [];
      for (const key of Object.keys(m)) {
        if (key !== k) entries.push([key, deepCloneSpl(m[key])]);
      }
      return { value: makeSplObject(entries), workUnits: entries.length + 1 };
    }
    case "map.keys": {
      const m = args[0] as SplObject;
      const keys = sortKeysCodePoint(Object.keys(m));
      return { value: keys, workUnits: keys.length };
    }
    case "map.values": {
      const m = args[0] as SplObject;
      const keys = sortKeysCodePoint(Object.keys(m));
      const vals = keys.map((k) => deepCloneSpl(m[k]));
      return { value: vals, workUnits: vals.length };
    }

    // --- math.* ---
    case "math.abs_i": {
      const x = args[0] as bigint;
      return { value: checkInt64(x < 0n ? -x : x), workUnits: 1 };
    }
    case "math.abs_f": {
      return { value: normalizeFloat(Math.abs(args[0] as number)), workUnits: 1 };
    }
    case "math.min_i": {
      const a = args[0] as bigint;
      const b = args[1] as bigint;
      return { value: a < b ? a : b, workUnits: 1 };
    }
    case "math.max_i": {
      const a = args[0] as bigint;
      const b = args[1] as bigint;
      return { value: a > b ? a : b, workUnits: 1 };
    }
    case "math.min_f": {
      const a = normalizeFloat(args[0] as number);
      const b = normalizeFloat(args[1] as number);
      return { value: normalizeFloat(Math.min(a, b)), workUnits: 1 };
    }
    case "math.max_f": {
      const a = normalizeFloat(args[0] as number);
      const b = normalizeFloat(args[1] as number);
      return { value: normalizeFloat(Math.max(a, b)), workUnits: 1 };
    }
    case "math.floor":
      return { value: normalizeFloat(Math.floor(args[0] as number)), workUnits: 1 };
    case "math.ceil":
      return { value: normalizeFloat(Math.ceil(args[0] as number)), workUnits: 1 };
    case "math.round":
      return { value: normalizeFloat(Math.round(args[0] as number)), workUnits: 1 };

    // --- json.* ---
    case "json.stringify": {
      const s = canonicalJsonStringify(args[0]);
      return { value: s, workUnits: codePointLength(s) };
    }
    case "json.parse": {
      const text = args[0] as string;
      try {
        const parsed = canonicalJsonParse(text);
        return { value: parsed, workUnits: codePointLength(text) };
      } catch (err) {
        throw new SplRecoverableError(
          "JSON_PARSE_ERROR",
          err instanceof Error ? err.message : "Invalid JSON",
          false
        );
      }
    }

    default:
      throw new SplTrapError("VM_INVARIANT_VIOLATION", `Unknown built-in '${id}'`);
  }
}
