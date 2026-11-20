import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/version — the version this deployment was built from, so a
// running (possibly older) client can tell a newer deploy exists.
// The value is baked in at build time (next.config env); outside
// Vercel it is "local", which the client treats as "no update".
export async function GET() {
  const version = process.env.NEXT_PUBLIC_APP_VERSION || "local";
  return NextResponse.json({ version }, { headers: { "Cache-Control": "no-store" } });
}
