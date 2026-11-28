import { NextRequest, NextResponse } from "next/server";
import { serverRunBytecode } from "@/lib/spl-server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      bytecode?: string;
      inputs?: Record<string, unknown>;
      initialState?: Record<string, unknown>;
      catalog?: unknown;
    };
    if (!body.bytecode || typeof body.bytecode !== "string") {
      return NextResponse.json({ error: "Missing compiled SPLB 5 bytecode." }, { status: 400 });
    }
    const result = await serverRunBytecode({
      bytecode: body.bytecode,
      inputs: body.inputs,
      initialState: body.initialState,
      catalog: body.catalog,
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
