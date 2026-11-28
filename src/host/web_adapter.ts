import * as dns from "node:dns/promises";
import * as net from "node:net";
import { SignatureCatalog, WebMethod } from "../catalog.js";
import { SplObject, SplRecoverableError, SplValue, makeSplObject } from "../canonical.js";
import { EffectDispatchResult } from "../vm.js";

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export type WebSearchProvider = (
  query: string,
  opts: { max_results: number; domain?: string }
) => Promise<WebSearchResultItem[]>;

export type DnsLookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
export type FetchFn = typeof fetch;

export function isPrivateOrReservedIp(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    return isPrivateOrReservedIp(lower.slice(7));
  }
  const v = net.isIP(lower);
  if (v === 4) {
    const parts = lower.split(".").map(Number);
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a >= 224) return true; // multicast & reserved
    return false;
  }
  if (v === 6) {
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
      return true; // fe80::/10 link-local
    }
    if (lower.startsWith("ff")) return true; // multicast
    return false;
  }
  return true;
}

export function matchDomainPattern(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase();
  const pat = pattern.toLowerCase();
  if (pat === "*") return true;
  if (pat.startsWith("*.")) {
    const suffix = pat.slice(2);
    return host === suffix || host.endsWith("." + suffix);
  }
  return host === pat;
}

export class WebAdapter {
  private readonly dnsLookup: DnsLookupFn;
  private readonly fetchFn: FetchFn;

  constructor(
    private readonly catalog: SignatureCatalog,
    opts: {
      searchProvider?: WebSearchProvider;
      dnsLookup?: DnsLookupFn;
      fetchFn?: FetchFn;
    } = {}
  ) {
    this.searchProvider = opts.searchProvider;
    this.dnsLookup = opts.dnsLookup ?? ((host) => dns.lookup(host, { all: true }));
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private readonly searchProvider?: WebSearchProvider;

  async search(args: SplObject): Promise<EffectDispatchResult> {
    const policy = this.catalog.web.search;
    if (!policy.enabled) {
      return {
        outcome: {
          status: "error",
          error: new SplRecoverableError("POLICY_DENIED", "web.search is disabled by catalog policy", false).errObj,
        },
      };
    }
    if (!this.searchProvider) {
      return {
        outcome: {
          status: "error",
          error: new SplRecoverableError("WEB_ERROR", "No web.search provider configured in host", false).errObj,
        },
      };
    }
    const query = args.query as string;
    const reqMax = args.max_results !== undefined ? Number(args.max_results as bigint) : policy.max_results_cap;
    const maxResults = Math.max(1, Math.min(reqMax, policy.max_results_cap));
    const domain = typeof args.domain === "string" ? args.domain : undefined;

    try {
      const items = await this.searchProvider(query, { max_results: maxResults, domain });
      const normalized: SplValue[] = items.slice(0, maxResults).map((it) =>
        makeSplObject([
          ["snippet", String(it.snippet ?? "")],
          ["title", String(it.title ?? "")],
          ["url", String(it.url ?? "")],
        ])
      );
      return { outcome: { status: "ok", value: normalized } };
    } catch (err) {
      return {
        outcome: {
          status: "error",
          error: new SplRecoverableError("WEB_ERROR", err instanceof Error ? err.message : String(err), true).errObj,
        },
      };
    }
  }

  async fetch(args: SplObject): Promise<EffectDispatchResult> {
    const policy = this.catalog.web.fetch;
    if (!policy.enabled) {
      return {
        outcome: {
          status: "error",
          error: new SplRecoverableError("POLICY_DENIED", "web.fetch is disabled by catalog policy", false).errObj,
        },
      };
    }

    const method = ((args.method as WebMethod | undefined) ?? "GET") as WebMethod;
    if (!policy.allowed_methods.includes(method)) {
      return {
        outcome: {
          status: "error",
          error: new SplRecoverableError("POLICY_DENIED", `HTTP method '${method}' not allowed`, false).errObj,
        },
      };
    }

    let currentUrl = args.url as string;
    const reqHeaders = (args.headers as SplObject | undefined) ?? {};
    const body = typeof args.body === "string" ? args.body : undefined;

    const startMs = Date.now();
    try {
      for (let hops = 0; hops <= policy.max_redirects; hops++) {
        await this.checkUrlPolicy(currentUrl);

        const headersInit: Record<string, string> = {};
        for (const [k, v] of Object.entries(reqHeaders)) {
          headersInit[k] = String(v);
        }

        const resp = await this.fetchFn(currentUrl, {
          method,
          headers: headersInit,
          body: method === "POST" ? body : undefined,
          redirect: "manual",
        });

        if (resp.status >= 300 && resp.status < 400 && resp.headers.get("location")) {
          if (hops === policy.max_redirects) {
            throw new SplRecoverableError(
              "WEB_ERROR",
              `Exceeded max_redirects (${policy.max_redirects})`,
              false
            );
          }
          currentUrl = new URL(resp.headers.get("location")!, currentUrl).toString();
          continue;
        }

        const rawBuf = Buffer.from(await resp.arrayBuffer());
        const truncated = rawBuf.byteLength > policy.max_response_bytes;
        const bodyText = (truncated ? rawBuf.subarray(0, policy.max_response_bytes) : rawBuf).toString("utf8");

        const headerEntries: Array<[string, SplValue]> = [];
        resp.headers.forEach((v, k) => {
          headerEntries.push([k.toLowerCase(), v]);
        });

        const contentType = resp.headers.get("content-type") ?? "";
        return {
          outcome: {
            status: "ok",
            value: makeSplObject([
              ["body", bodyText],
              ["content_type", contentType],
              ["headers", makeSplObject(headerEntries)],
              ["status", BigInt(resp.status)],
              ["truncated", truncated],
              ["url", currentUrl],
            ]),
          },
          non_normative_meta: { latency_ms: Date.now() - startMs },
        };
      }
      throw new SplRecoverableError("WEB_ERROR", "Redirect loop terminated unexpectedly", false);
    } catch (err) {
      if (err instanceof SplRecoverableError) {
        return { outcome: { status: "error", error: err.errObj } };
      }
      return {
        outcome: {
          status: "error",
          error: new SplRecoverableError("WEB_ERROR", err instanceof Error ? err.message : String(err), true).errObj,
        },
      };
    }
  }

  private async checkUrlPolicy(rawUrl: string): Promise<void> {
    const policy = this.catalog.web.fetch;
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new SplRecoverableError("POLICY_DENIED", `Invalid URL: '${rawUrl}'`, false);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new SplRecoverableError("POLICY_DENIED", `Unsupported URL protocol '${parsed.protocol}'`, false);
    }

    const host = parsed.hostname.toLowerCase();
    for (const denied of policy.denied_domains) {
      if (matchDomainPattern(host, denied)) {
        throw new SplRecoverableError("POLICY_DENIED", `Domain '${host}' is denied by policy`, false);
      }
    }
    if (policy.allowed_domains.length > 0) {
      const matched = policy.allowed_domains.some((pat) => matchDomainPattern(host, pat));
      if (!matched) {
        throw new SplRecoverableError("POLICY_DENIED", `Domain '${host}' is not in allowed_domains`, false);
      }
    }

    if (policy.block_private_ips) {
      const bareHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
      if (bareHost === "localhost" || bareHost.endsWith(".localhost")) {
        throw new SplRecoverableError("POLICY_DENIED", `SSRF blocked localhost target '${host}'`, false);
      }
      if (net.isIP(bareHost)) {
        if (isPrivateOrReservedIp(bareHost)) {
          throw new SplRecoverableError("POLICY_DENIED", `SSRF blocked private/reserved IP '${bareHost}'`, false);
        }
      } else {
        let addrs: Array<{ address: string; family: number }>;
        try {
          addrs = await this.dnsLookup(bareHost);
        } catch {
          throw new SplRecoverableError("WEB_ERROR", `DNS resolution failed for '${bareHost}'`, true);
        }
        if (addrs.length === 0) {
          throw new SplRecoverableError("WEB_ERROR", `No DNS records for '${bareHost}'`, true);
        }
        for (const a of addrs) {
          if (isPrivateOrReservedIp(a.address)) {
            throw new SplRecoverableError(
              "POLICY_DENIED",
              `SSRF blocked private/reserved DNS target ${a.address} for '${bareHost}'`,
              false
            );
          }
        }
      }
    }
  }
}
