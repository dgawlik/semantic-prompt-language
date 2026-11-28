import { NextRequest, NextResponse } from "next/server";
import { serverCompileSpl } from "@/lib/spl-server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { source?: string; catalog?: unknown };
    if (typeof body.source !== "string") {
      return NextResponse.json({ error: "Missing SPL source string." }, { status: 400 });
    }
    const result = serverCompileSpl(body.source, body.catalog);
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
