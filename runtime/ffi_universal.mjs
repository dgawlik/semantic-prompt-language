// SPL Universal FFI Kernel (Browser + Node 22+ / Bun / Deno)
import { Ok, Err, toStr } from "./core.mjs";

export async function httpFetch(req) {
  try {
    const headers = {};
    if (req.headers instanceof Map) {
      for (const [k, v] of req.headers.entries()) headers[k] = v;
    } else if (req.headers && typeof req.headers === "object") {
      Object.assign(headers, req.headers);
    }
    const init = {
      method: req.method || "GET",
      headers,
    };
    if (req.body && req.body.$tag === "Some") {
      init.body = req.body._0;
    } else if (typeof req.body === "string" && req.body.length > 0) {
      init.body = req.body;
    }
    const res = await fetch(req.url, init);
    const body = await res.text();
    const resHeaders = new Map();
    res.headers.forEach((val, key) => resHeaders.set(key, val));
    return Ok({
      status: res.status,
      ok: res.ok,
      headers: resHeaders,
      body,
    });
  } catch (e) {
    return Err(e instanceof Error ? e.message : String(e));
  }
}

export function clockNowMs() {
  return Date.now();
}

export function clockSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function cryptoRandomBytes(n) {
  const buf = new Uint8Array(n);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf);
}

export function consoleLog(v) {
  console.log(toStr(v));
}
export function consoleWarn(v) {
  console.warn(toStr(v));
}
export function consoleError(v) {
  console.error(toStr(v));
}
