import type { APIRoute } from "astro";

export const prerender = false;

type ProviderConfig = {
  upstreamBase: string;
  envVars: string[];
  authHeader: (key: string) => Record<string, string>;
  extraHeaders?: Record<string, string>;
  allowPath: (rest: string) => boolean;
};

const PROVIDERS: Record<string, ProviderConfig> = {
  openai: {
    upstreamBase: "https://api.openai.com",
    envVars: ["OPENAI_API_KEY"],
    authHeader: (key) => ({ authorization: `Bearer ${key}` }),
    allowPath: (rest) =>
      rest === "v1/responses" ||
      rest === "v1/chat/completions" ||
      rest === "v1/decisions",
  },
  anthropic: {
    upstreamBase: "https://api.anthropic.com",
    envVars: ["ANTHROPIC_API_KEY"],
    authHeader: (key) => ({ "x-api-key": key }),
    extraHeaders: { "anthropic-version": "2023-06-01" },
    allowPath: (rest) => rest === "v1/messages",
  },
  google: {
    upstreamBase: "https://generativelanguage.googleapis.com",
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    authHeader: (key) => ({ "x-goog-api-key": key }),
    allowPath: (rest) =>
      /^v1beta\/models\/[A-Za-z0-9._-]+:(generateContent|streamGenerateContent)$/.test(rest) ||
      rest === "v1beta/decisions",
  },
};

function readServerEnv(names: string[]): string {
  for (const name of names) {
    const procVal = typeof process !== "undefined" ? process.env?.[name]?.trim() : undefined;
    if (procVal) return procVal;
  }
  return "";
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const GET: APIRoute = async () => {
  return new Response(
    JSON.stringify({
      providers: {
        openai: Boolean(readServerEnv(PROVIDERS.openai.envVars)),
        anthropic: Boolean(readServerEnv(PROVIDERS.anthropic.envVars)),
        google: Boolean(readServerEnv(PROVIDERS.google.envVars)),
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    }
  );
};

export const POST: APIRoute = async ({ params, request, url }) => {
  const rawPath = (params.path ?? "").replace(/^\/+/, "");
  const slashIdx = rawPath.indexOf("/");
  if (slashIdx === -1) {
    return jsonError(400, "Expected /api/llm/<provider>/<endpoint>");
  }

  const providerKey = rawPath.slice(0, slashIdx).toLowerCase();
  const restPath = rawPath.slice(slashIdx + 1);
  const cfg = PROVIDERS[providerKey];
  if (!cfg) {
    return jsonError(404, `Unknown LLM provider '${providerKey}'`);
  }
  if (!cfg.allowPath(restPath)) {
    return jsonError(403, `Disallowed endpoint '${restPath}' for provider '${providerKey}'`);
  }

  const apiKey = readServerEnv(cfg.envVars);
  if (!apiKey) {
    return jsonError(
      503,
      `Playground server is missing ${cfg.envVars.join(" / ")}. Configure it in Vercel Project Environment Variables (or local docs/.env).`
    );
  }

  const bodyText = await request.text();
  if (bodyText.length > 512_000) {
    return jsonError(413, "Request payload too large for playground proxy (max 512 KB).");
  }

  const upstreamUrl = `${cfg.upstreamBase}/${restPath}${url.search}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(cfg.extraHeaders ?? {}),
    ...cfg.authHeader(apiKey),
  };

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: bodyText,
    });
  } catch (err) {
    return jsonError(502, `Upstream LLM request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const outHeaders = new Headers();
  const ct = upstreamRes.headers.get("content-type");
  if (ct) outHeaders.set("content-type", ct);
  outHeaders.set("cache-control", "no-store");

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: outHeaders,
  });
};
