import { NextResponse } from "next/server";
import { selectUsageRange, USAGE_RANGES, type UsageRange } from "@/lib/usage";
import { getUsageService } from "@/lib/usage-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const range = params.get("range") ?? "30d";
  const timeZone = params.get("timeZone") ?? "UTC";
  const view = params.get("view") ?? "range";
  const refresh = params.get("refresh") ?? "0";
  if (refresh !== "0" && refresh !== "1") {
    return NextResponse.json({ error: "Invalid usage refresh" }, { status: 400, headers });
  }
  if (view !== "range" && view !== "snapshot") {
    return NextResponse.json({ error: "Invalid usage view" }, { status: 400, headers });
  }
  if (!USAGE_RANGES.includes(range as UsageRange)) {
    return NextResponse.json({ error: "Invalid usage range" }, { status: 400, headers });
  }
  try {
    if (!timeZone || timeZone.length > 100) throw new Error("Invalid time zone");
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    return NextResponse.json({ error: "Invalid time zone" }, { status: 400, headers });
  }
  try {
    const snapshot = await getUsageService().getSnapshot(timeZone, refresh === "1");
    return NextResponse.json(view === "snapshot" ? snapshot : selectUsageRange(snapshot, range as UsageRange), { headers });
  } catch (error) {
    console.error("[pi-web] Failed to read token usage:", error);
    return NextResponse.json({ error: "Unable to read session usage" }, { status: 500, headers });
  }
}
