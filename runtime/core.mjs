// SPL Minimal Core Runtime (Universal: Browser + Node/Bun/Deno)

export const None = Object.freeze({ $tag: "None" });
export function Some(v) {
  return { $tag: "Some", _0: v };
}
export function Ok(v) {
  return { $tag: "Ok", _0: v };
}
export function Err(e) {
  return { $tag: "Err", _0: e };
}

export class EarlyReturn {
  constructor(value) {
    this.value = value;
  }
  toString() {
    if (this.value && typeof this.value === "object") {
      if (this.value.$tag === "Err") return `Unhandled Err from '?': ${toStr(this.value._0)}`;
      if (this.value.$tag === "None") return `Unhandled None from '?'`;
    }
    return `Unhandled early return: ${toStr(this.value)}`;
  }
}

export function tryUnwrap(val) {
  if (val && typeof val === "object") {
    if (val.$tag === "Ok" || val.$tag === "Some") return val._0;
    if (val.$tag === "Err" || val.$tag === "None") {
      throw new EarlyReturn(val);
    }
  }
  return val;
}

export function optMap(opt, fn) {
  if (opt && opt.$tag === "Some") {
    const res = fn(opt._0);
    return res && res.$tag === "Some" || res && res.$tag === "None" ? res : Some(res);
  }
  return None;
}

export function optCoalesce(val, fallbackFn) {
  if (val && (val.$tag === "Some" || val.$tag === "Ok")) return val._0;
  return fallbackFn();
}

export function panic(msg) {
  throw new Error(`SPL panic: ${msg}`);
}

export function toStr(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v == null) return "None";
  if (v.$tag === "Prompt") return v.text;
  if (v.$tag === "None") return "None";
  if (v.$tag === "Some") return `Some(${toStr(v._0)})`;
  if (v.$tag === "Ok") return `Ok(${toStr(v._0)})`;
  if (v.$tag === "Err") return `Err(${toStr(v._0)})`;
  if (v.$tag) return `${v.$tag}`;
  if (Array.isArray(v)) return `[${v.map(toStr).join(", ")}]`;
  if (v instanceof Map) {
    const entries = Array.from(v.entries()).map(([k, val]) => `${toStr(k)}: ${toStr(val)}`);
    return `{ ${entries.join(", ")} }`;
  }
  return JSON.stringify(v);
}

export function print(v) {
  console.log(toStr(v));
}

export function printInline(v) {
  const s = toStr(v);
  if (typeof process !== "undefined" && process.stdout && typeof process.stdout.write === "function") {
    process.stdout.write(s);
  } else {
    console.log(s);
  }
}

export function eq(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!eq(a[i], b[i])) return false;
    }
    return true;
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !eq(v, b.get(k))) return false;
    }
    return true;
  }
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!eq(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

export function prompt(parts, values) {
  let text = parts[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    text += toStr(values[i]) + (parts[i + 1] ?? "");
  }
  return Object.freeze({
    $tag: "Prompt",
    parts: Object.freeze([...parts]),
    values: Object.freeze([...values]),
    text,
  });
}

export function prompt_render(p) {
  return p.text;
}

export function prim_show(v) {
  return toStr(v);
}

const SPL_OPEN_EXTRA = Symbol("spl.openExtra");

export function indexGet(obj, idx) {
  if (Array.isArray(obj)) {
    if (typeof idx === "number" && Number.isInteger(idx) && idx >= 0 && idx < obj.length) {
      return Some(obj[idx]);
    }
    return None;
  }
  if (obj instanceof Map) {
    return obj.has(idx) ? Some(obj.get(idx)) : None;
  }
  if (obj && typeof obj === "object") {
    const openMap = obj[SPL_OPEN_EXTRA] ?? (obj.extra instanceof Map ? obj.extra : undefined);
    if (openMap instanceof Map && openMap.has(idx)) {
      return Some(openMap.get(idx));
    }
    if (Object.prototype.hasOwnProperty.call(obj, idx) && !(obj[idx] instanceof Map)) {
      return Some(obj[idx]);
    }
    return None;
  }
  return None;
}

export function omit(obj, keys) {
  const skip = new Set(keys);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!skip.has(k)) out[k] = v;
  }
  return out;
}

// ==================== JSON & Codec Decoding ====================

export function jsonParse(str) {
  try {
    return Ok(JSON.parse(str));
  } catch (e) {
    return Err(e instanceof Error ? e.message : String(e));
  }
}

export function jsonStringify(val) {
  return JSON.stringify(toJsonValue(val));
}

export function toJson(val) {
  return toJsonValue(val);
}

function toJsonValue(v) {
  if (v == null) return null;
  if (v.$tag === "None") return null;
  if (v.$tag === "Some") return toJsonValue(v._0);
  if (v.$tag === "Prompt") return v.text;
  if (v instanceof Map) {
    const out = {};
    for (const [k, val] of v.entries()) out[String(k)] = toJsonValue(val);
    return out;
  }
  if (Array.isArray(v)) return v.map(toJsonValue);
  if (typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = toJsonValue(val);
    return out;
  }
  return v;
}

export function decode(codec, value) {
  const res = decodeAt(codec, value, "$");
  return res.ok ? Ok(res.value) : Err({ path: res.path, message: res.message });
}

function decodeAt(codec, v, path) {
  switch (codec.k) {
    case "Int":
      return typeof v === "number" && Number.isInteger(v)
        ? { ok: true, value: v }
        : { ok: false, path, message: `Expected Int, got ${typeof v === "number" ? `Float (${v})` : typeof v}` };

    case "Float":
      return typeof v === "number" && Number.isFinite(v)
        ? { ok: true, value: v }
        : { ok: false, path, message: `Expected Float, got ${typeof v}` };

    case "Str":
    case "Prompt":
      return typeof v === "string"
        ? { ok: true, value: codec.k === "Prompt" ? prompt([v], []) : v }
        : { ok: false, path, message: `Expected Str, got ${typeof v}` };

    case "Bool":
      return typeof v === "boolean"
        ? { ok: true, value: v }
        : { ok: false, path, message: `Expected Bool, got ${typeof v}` };

    case "Char":
      return typeof v === "string" && [...v].length === 1
        ? { ok: true, value: v }
        : { ok: false, path, message: `Expected single-character Char` };

    case "Byte":
      return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 255
        ? { ok: true, value: v }
        : { ok: false, path, message: `Expected Byte (0..255)` };

    case "Json":
      return { ok: true, value: v };

    case "Unit":
      return v === null || v === undefined
        ? { ok: true, value: undefined }
        : { ok: false, path, message: `Expected null` };

    case "Option":
      if (v === null || v === undefined) return { ok: true, value: None };
      {
        const inner = decodeAt(codec.inner, v, path);
        return inner.ok ? { ok: true, value: Some(inner.value) } : inner;
      }

    case "Array": {
      if (!Array.isArray(v)) return { ok: false, path, message: `Expected Array, got ${typeof v}` };
      const out = [];
      for (let i = 0; i < v.length; i++) {
        const el = decodeAt(codec.el, v[i], `${path}[${i}]`);
        if (!el.ok) return el;
        out.push(el.value);
      }
      return { ok: true, value: out };
    }

    case "Tuple": {
      if (!Array.isArray(v) || v.length !== codec.els.length) {
        return { ok: false, path, message: `Expected Tuple of length ${codec.els.length}` };
      }
      const out = [];
      for (let i = 0; i < codec.els.length; i++) {
        const el = decodeAt(codec.els[i], v[i], `${path}[${i}]`);
        if (!el.ok) return el;
        out.push(el.value);
      }
      return { ok: true, value: out };
    }

    case "Dict": {
      if (v == null || typeof v !== "object" || Array.isArray(v)) {
        return { ok: false, path, message: `Expected JSON object for Dict` };
      }
      const map = new Map();
      for (const [k, val] of Object.entries(v)) {
        const dec = decodeAt(codec.val, val, `${path}.${k}`);
        if (!dec.ok) return dec;
        map.set(k, dec.value);
      }
      return { ok: true, value: map };
    }

    case "Record": {
      if (v == null || typeof v !== "object" || Array.isArray(v)) {
        return { ok: false, path, message: `Expected object, got ${Array.isArray(v) ? "array" : typeof v}` };
      }
      const out = {};
      const known = new Set(Object.keys(codec.fields));

      for (const [fName, fSpec] of Object.entries(codec.fields)) {
        const present = Object.prototype.hasOwnProperty.call(v, fName);
        if (!present || v[fName] === null || v[fName] === undefined) {
          if (fSpec.optional) {
            out[fName] = None;
            continue;
          }
          return { ok: false, path: `${path}.${fName}`, message: `Missing required field '${fName}'` };
        }
        const dec = decodeAt(fSpec.codec, v[fName], `${path}.${fName}`);
        if (!dec.ok) return dec;
        out[fName] = fSpec.optional ? Some(dec.value) : dec.value;
      }

      if (!codec.open) {
        for (const k of Object.keys(v)) {
          if (!known.has(k)) {
            return { ok: false, path: `${path}.${k}`, message: `Unexpected field '${k}' (additionalProperties: false)` };
          }
        }
      } else if (codec.extraName) {
        const extra = new Map();
        for (const [k, val] of Object.entries(v)) {
          if (known.has(k)) continue;
          const dec = decodeAt(codec.extraCodec, val, `${path}.${k}`);
          if (!dec.ok) return dec;
          extra.set(k, dec.value);
        }
        out[codec.extraName] = extra;
        Object.defineProperty(out, SPL_OPEN_EXTRA, { value: extra, enumerable: false });
      }
      return { ok: true, value: out };
    }

    case "Enum": {
      // Unit variant as string
      if (typeof v === "string") {
        const vCodecs = codec.variants[v];
        if (vCodecs && vCodecs.length === 0) {
          return { ok: true, value: { $tag: v } };
        }
        return { ok: false, path, message: `Unknown unit variant '${v}' for enum ${codec.name}` };
      }
      // Tagged object `{ tag, value }` or `{ tag, values }`
      if (v && typeof v === "object" && typeof v.tag === "string") {
        const vCodecs = codec.variants[v.tag];
        if (!vCodecs) return { ok: false, path, message: `Unknown variant '${v.tag}' for enum ${codec.name}` };
        const res = { $tag: v.tag };
        if (vCodecs.length === 1) {
          const dec = decodeAt(vCodecs[0], v.value, `${path}.value`);
          if (!dec.ok) return dec;
          res._0 = dec.value;
        } else if (vCodecs.length > 1) {
          if (!Array.isArray(v.values) || v.values.length !== vCodecs.length) {
            return { ok: false, path: `${path}.values`, message: `Expected ${vCodecs.length} variant values` };
          }
          for (let i = 0; i < vCodecs.length; i++) {
            const dec = decodeAt(vCodecs[i], v.values[i], `${path}.values[${i}]`);
            if (!dec.ok) return dec;
            res[`_${i}`] = dec.value;
          }
        }
        return { ok: true, value: res };
      }
      return { ok: false, path, message: `Expected enum '${codec.name}'` };
    }
  }
  return { ok: true, value: v };
}

// ==================== Array Builtins (Sync + Sequential Async + Parallel) ====================

export function array_len(a) { return a.length; }
export function array_get(a, i) { return i >= 0 && i < a.length ? Some(a[i]) : None; }
export function array_set(a, i, val) {
  if (i < 0 || i >= a.length) panic(`Array.set index ${i} out of bounds (len=${a.length})`);
  a[i] = val;
  return a;
}
export function array_slice(a, s, e) { return a.slice(s, e); }
export function array_concat(a, b) { return a.concat(b); }
export function array_push(a, item) {
  a.push(item);
  return a;
}
export function array_pop(a) {
  return a.length > 0 ? Some(a.pop()) : None;
}
export function array_swap(a, i, j) {
  if (i < 0 || i >= a.length || j < 0 || j >= a.length) {
    panic(`Array.swap indices (${i}, ${j}) out of bounds (len=${a.length})`);
  }
  const tmp = a[i];
  a[i] = a[j];
  a[j] = tmp;
  return a;
}
export function array_clear(a) {
  a.length = 0;
  return a;
}
export function array_join(a, sep) { return a.join(sep); }
export function array_find(a, f) {
  for (let i = 0; i < a.length; i++) if (f(a[i])) return Some(a[i]);
  return None;
}

export function array_map(a, f) { return a.map(f); }
export async function array_map_async(a, f) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = await f(a[i]);
  return out;
}
export async function array_par_map(a, f) {
  return Promise.all(a.map((x) => f(x)));
}

export function array_filter(a, f) { return a.filter(f); }
export async function array_filter_async(a, f) {
  const out = [];
  for (let i = 0; i < a.length; i++) {
    if (await f(a[i])) out.push(a[i]);
  }
  return out;
}

export function array_fold(a, init, f) {
  let acc = init;
  for (let i = 0; i < a.length; i++) acc = f(acc, a[i]);
  return acc;
}
export async function array_fold_async(a, init, f) {
  let acc = init;
  for (let i = 0; i < a.length; i++) acc = await f(acc, a[i]);
  return acc;
}
export const arrayFold = array_fold;

export function array_flat_map(a, f) {
  const out = [];
  for (let i = 0; i < a.length; i++) out.push(...f(a[i]));
  return out;
}
export async function array_flat_map_async(a, f) {
  const out = [];
  for (let i = 0; i < a.length; i++) out.push(...(await f(a[i])));
  return out;
}

export function arrayFromFn(n, f) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = f(i);
  return out;
}

// ==================== Lazy Iterator Builtins (`Iter<T>`) ====================

export function iterFromFn(nextFn) {
  return { $tag: "Iter", next: nextFn };
}

export function rangeIter(start, end, step = 1, inclusive = false) {
  if (step === 0) panic("Range step cannot be 0");
  let cur = start;
  return iterFromFn(() => {
    const keep =
      step > 0
        ? inclusive
          ? cur <= end
          : cur < end
        : inclusive
          ? cur >= end
          : cur > end;
    if (!keep) return None;
    const val = cur;
    cur += step;
    return Some(val);
  });
}

export function array_iter(a) {
  let i = 0;
  return iterFromFn(() => (i < a.length ? Some(a[i++]) : None));
}

export function dict_iter(m) {
  const it = m.entries();
  return iterFromFn(() => {
    const r = it.next();
    return r.done ? None : Some(r.value);
  });
}

export function dict_keys_iter(m) {
  const it = m.keys();
  return iterFromFn(() => {
    const r = it.next();
    return r.done ? None : Some(r.value);
  });
}

export function dict_values_iter(m) {
  const it = m.values();
  return iterFromFn(() => {
    const r = it.next();
    return r.done ? None : Some(r.value);
  });
}

export function iter_next(it) {
  return it.next();
}

export function iter_map(it, f) {
  return iterFromFn(() => {
    const n = it.next();
    return n.$tag === "Some" ? Some(f(n._0)) : None;
  });
}

export function iter_filter(it, pred) {
  return iterFromFn(() => {
    while (true) {
      const n = it.next();
      if (n.$tag === "None") return None;
      if (pred(n._0)) return n;
    }
  });
}

export function iter_flat_map(it, f) {
  let current = null;
  return iterFromFn(() => {
    while (true) {
      if (current) {
        const inner = current.next();
        if (inner.$tag === "Some") return inner;
        current = null;
      }
      const outer = it.next();
      if (outer.$tag === "None") return None;
      current = f(outer._0);
    }
  });
}

export function iter_take(it, count) {
  let remaining = count;
  return iterFromFn(() => {
    if (remaining <= 0) return None;
    remaining--;
    return it.next();
  });
}

export function iter_skip(it, count) {
  let toSkip = count;
  return iterFromFn(() => {
    while (toSkip > 0) {
      toSkip--;
      const dropped = it.next();
      if (dropped.$tag === "None") return None;
    }
    return it.next();
  });
}

export function iter_enumerate(it) {
  let idx = 0;
  return iterFromFn(() => {
    const n = it.next();
    return n.$tag === "Some" ? Some([idx++, n._0]) : None;
  });
}

export function iter_zip(itA, itB) {
  return iterFromFn(() => {
    const a = itA.next();
    if (a.$tag === "None") return None;
    const b = itB.next();
    if (b.$tag === "None") return None;
    return Some([a._0, b._0]);
  });
}

export function iter_chain(itA, itB) {
  let firstDone = false;
  return iterFromFn(() => {
    if (!firstDone) {
      const a = itA.next();
      if (a.$tag === "Some") return a;
      firstDone = true;
    }
    return itB.next();
  });
}

export function iter_collect(it) {
  const out = [];
  while (true) {
    const n = it.next();
    if (n.$tag === "None") break;
    out.push(n._0);
  }
  return out;
}
export const iter_to_array = iter_collect;

export function iter_fold(it, init, f) {
  let acc = init;
  while (true) {
    const n = it.next();
    if (n.$tag === "None") break;
    acc = f(acc, n._0);
  }
  return acc;
}

export async function iter_fold_async(it, init, f) {
  let acc = init;
  while (true) {
    const n = it.next();
    if (n.$tag === "None") break;
    acc = await f(acc, n._0);
  }
  return acc;
}

export function iter_for_each(it, f) {
  while (true) {
    const n = it.next();
    if (n.$tag === "None") break;
    f(n._0);
  }
}

export async function iter_for_each_async(it, f) {
  while (true) {
    const n = it.next();
    if (n.$tag === "None") break;
    await f(n._0);
  }
}

export function iter_find(it, pred) {
  while (true) {
    const n = it.next();
    if (n.$tag === "None") return None;
    if (pred(n._0)) return n;
  }
}

export function iter_any(it, pred) {
  while (true) {
    const n = it.next();
    if (n.$tag === "None") return false;
    if (pred(n._0)) return true;
  }
}

export function iter_all(it, pred) {
  while (true) {
    const n = it.next();
    if (n.$tag === "None") return true;
    if (!pred(n._0)) return false;
  }
}

export function iter_count(it) {
  let n = 0;
  while (it.next().$tag === "Some") n++;
  return n;
}

// ==================== String & Regex Builtins ====================

export function str_len(s) { return s.length; }
export function str_trim(s) { return s.trim(); }
export function str_to_upper(s) { return s.toUpperCase(); }
export function str_to_lower(s) { return s.toLowerCase(); }
export function str_slice(s, a, b) { return s.slice(a, b); }
export function str_split(s, sep) { return s.split(sep); }
export function str_starts_with(s, p) { return s.startsWith(p); }
export function str_ends_with(s, p) { return s.endsWith(p); }
export function str_contains(s, sub) { return s.includes(sub); }
export function str_index_of(s, sub) {
  const idx = s.indexOf(sub);
  return idx === -1 ? None : Some(idx);
}
export function str_replace(s, a, b) { return s.replaceAll(a, b); }
export function str_chars(s) {
  const it = s[Symbol.iterator]();
  return iterFromFn(() => {
    const r = it.next();
    return r.done ? None : Some(r.value);
  });
}
export function str_bytes(s) {
  const buf = textEncoder.encode(s);
  let i = 0;
  return iterFromFn(() => (i < buf.length ? Some(buf[i++]) : None));
}

export function charToInt(ch) {
  return typeof ch === "string" && ch.length > 0 ? (ch.codePointAt(0) ?? 0) : 0;
}
export function intToChar(cp) {
  return String.fromCodePoint(Math.trunc(cp));
}
export function strToInt(s) {
  const trimmed = String(s).trim();
  const n = Number.parseInt(trimmed, 10);
  if (Number.isNaN(n)) panic(`Cannot convert Str "${s}" to Int`);
  return n;
}
export function strToFloat(s) {
  const trimmed = String(s).trim();
  const n = Number.parseFloat(trimmed);
  if (Number.isNaN(n)) panic(`Cannot convert Str "${s}" to Float`);
  return n;
}

export function regexTest(pattern, input) {
  return new RegExp(pattern).test(input);
}
export function regexMatch(pattern, input) {
  const m = new RegExp(pattern).exec(input);
  return m ? Some(Array.from(m)) : None;
}
export function regexReplace(pattern, input, replacement) {
  return input.replace(new RegExp(pattern, "g"), replacement);
}

// ==================== Dict Builtins (Copy-on-Write Immutable Map) ====================

export function dictEmpty() { return new Map(); }
export function dict_len(m) { return m.size; }
export function dict_get(m, k) { return m.has(k) ? Some(m.get(k)) : None; }
export function dict_set(m, k, v) {
  const next = new Map(m);
  next.set(k, v);
  return next;
}
export function dict_delete(m, k) {
  const next = new Map(m);
  next.delete(k);
  return next;
}
export function dict_entries(m) {
  return Array.from(m.entries());
}

// ==================== Option & Result Builtins ====================

export function option_unwrap_or(o, d) { return o.$tag === "Some" ? o._0 : d; }
export function option_map(o, f) { return o.$tag === "Some" ? Some(f(o._0)) : None; }
export function option_is_some(o) { return o.$tag === "Some"; }
export function option_is_none(o) { return o.$tag === "None"; }

export function result_unwrap_or(r, d) { return r.$tag === "Ok" ? r._0 : d; }
export function result_map(r, f) { return r.$tag === "Ok" ? Ok(f(r._0)) : r; }
export function result_is_ok(r) { return r.$tag === "Ok"; }
export function result_is_err(r) { return r.$tag === "Err"; }

// ==================== Bytes & Async Combinators ====================

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
export function bytesFromUtf8(s) { return textEncoder.encode(s); }
export function bytesToUtf8(b) { return textDecoder.decode(b); }
export function bytesLen(b) { return b.length; }

export async function asyncAll(thunks) {
  return Promise.all(thunks.map((fn) => fn()));
}
export async function asyncRace(thunks) {
  return Promise.race(thunks.map((fn) => fn()));
}
