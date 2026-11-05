import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { sendEmail } from "@/lib/email/send";

export const maxDuration = 60;

// Daily AI-cost guard (Vercel Cron, 13:00 UTC ≈ 9 AM New York). Runs on
// Vercel so it doesn't depend on the operator's Mac. Emails ALERT_EMAIL only
// when something needs attention:
//   - last 24h spend over AI_SPEND_DAILY_ALERT_USD (default $10)
//   - month-to-date spend crossed AI_SPEND_MONTHLY_ALERT_USD (default $60)
//     in the last 24h (so the monthly alert fires once, not every day)
//   - the Anthropic API rejects a 1-token probe (e.g. credit balance is out,
//     which stops PDF parsing and AI explanations)
// Costs come from ai_usage_log.cost_cents, which the app writes per AI call.

const DAY_MS = 24 * 60 * 60 * 1000;

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

async function sumCostCents(
  db: ReturnType<typeof getServiceClient>,
  fromIso: string,
): Promise<number> {
  let total = 0;
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db
      .from("ai_usage_log")
      .select("cost_cents")
      .gte("created_at", fromIso)
      .range(offset, offset + 999);
    if (error) throw new Error(`ai_usage_log: ${error.message}`);
    for (const r of data ?? []) total += r.cost_cents ?? 0;
    if (!data || data.length < 1000) return total;
  }
}

async function probeAnthropic(): Promise<string | null> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 1,
        messages: [{ role: "user", content: "ok" }],
      }),
    });
    if (res.ok) return null;
    const j = await res.json().catch(() => null);
    return j?.error?.message ?? `HTTP ${res.status}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET;
  const provided = req.headers.get("authorization") ?? "";
  if (expected && provided !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dailyLimit = Number(process.env.AI_SPEND_DAILY_ALERT_USD ?? 10) * 100;
  const monthlyLimit = Number(process.env.AI_SPEND_MONTHLY_ALERT_USD ?? 60) * 100;
  const now = new Date();
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const db = getServiceClient();
  const [last24h, monthToDate] = await Promise.all([
    sumCostCents(db, dayAgo.toISOString()),
    sumCostCents(db, monthStart.toISOString()),
  ]);
  // Month-to-date as it stood 24h ago (0 when the month started since then).
  const monthBefore = dayAgo < monthStart ? 0 : monthToDate - last24h;
  const apiError = await probeAnthropic();

  const alerts: string[] = [];
  if (last24h > dailyLimit) {
    alerts.push(`AI spend in the last 24 hours is ${usd(last24h)}, over the daily alert of ${usd(dailyLimit)}.`);
  }
  if (monthToDate >= monthlyLimit && monthBefore < monthlyLimit) {
    alerts.push(`AI spend this month reached ${usd(monthToDate)}, past the monthly alert of ${usd(monthlyLimit)}.`);
  }
  if (apiError) {
    alerts.push(
      /credit balance/i.test(apiError)
        ? "The Anthropic API is out of credit. PDF parsing and AI explanations will fail until it's topped up."
        : `The Anthropic API check failed: ${apiError}`,
    );
  }

  // ?test=1 (still behind CRON_SECRET) sends the email even when all is well,
  // to confirm delivery end to end.
  const test = new URL(req.url).searchParams.get("test") === "1";
  const to = process.env.ALERT_EMAIL;
  let emailed = false;
  if ((alerts.length > 0 || test) && to) {
    await sendEmail({
      to,
      subject: `${test ? "[Test] " : ""}SAT Exam OS: AI spend alert`,
      html: [
        alerts.length > 0
          ? `<p>${alerts.map((a) => a.replace(/</g, "&lt;")).join("</p><p>")}</p>`
          : `<p>Test email: no alert right now. Real alerts come from this address.</p>`,
        `<p>Last 24 hours: ${usd(last24h)}<br>This month: ${usd(monthToDate)}</p>`,
        `<p>Details: https://sat.nexhunt.xyz/admin/ai-usage</p>`,
      ].join(""),
    });
    emailed = true;
  }

  return NextResponse.json({
    last24hUsd: last24h / 100,
    monthToDateUsd: monthToDate / 100,
    apiOk: !apiError,
    alerts,
    emailed,
  });
}
