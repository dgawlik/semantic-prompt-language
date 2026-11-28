import { NextRequest, NextResponse } from "next/server";
import { serverTranslateProse } from "@/lib/spl-server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      prose?: string;
      catalog?: unknown;
      model?: string;
      apiKey?: string;
      mode?: "live" | "demo";
      maxAttempts?: number;
    };

    if (!body.prose || typeof body.prose !== "string" || !body.prose.trim()) {
      return NextResponse.json({ error: "Prose instructions cannot be empty." }, { status: 400 });
    }

    const result = await serverTranslateProse({
      prose: body.prose,
      catalog: body.catalog,
      model: body.model,
      apiKey: body.apiKey,
      mode: body.mode,
      maxAttempts: body.maxAttempts,
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
