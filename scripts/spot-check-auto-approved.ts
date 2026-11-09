// scripts/spot-check-auto-approved.ts
//
// Random spot-check of system-approved questions (lib/spot-check.ts): a 5%
// sample (at least 20) of the Approved questions no person reviewed is
// re-solved independently (lib/verify-ai-key.ts runChecks: code solve +
// plug-back + second solve; R&W two solves — none of them shown the key).
//   passed       → "Spot-check passed (…)" note
//   wrong        → both solves agree with each other on another answer: the
//                  verify-ai-key disagreement note tagged [spot-check DATE];
//                  not live → Needs Review (Review Queue key group), live →
//                  stays Approved with a [live-fix] note
//   inconclusive → nothing written, not counted
// The Question Bank and the Review Queue show "Spot-checked N · k wrong (x%)";
// auto-approval pauses above 5% (lib/review-auto.ts).
//
// AI COST: the dry run (default) only samples and prints a cost estimate from
// ai_usage_log (average cost_cents per verify-ai-key route × sample size).
// --apply makes the AI calls.
//
//   npx tsx --env-file=.env.prod scripts/spot-check-auto-approved.ts             # sample + estimate
//   npx tsx --env-file=.env.prod scripts/spot-check-auto-approved.ts --apply [--limit N]
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { VERIFY_SELECT, type VerifyRow } from "../lib/verify-ai-key";
import { loadSpotCheckResults, spotCheckStats } from "../lib/spot-check";
import { spotCheckOne } from "../lib/spot-check-run";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const LIMIT = Number(args[args.indexOf("--limit") + 1]) || Infinity;
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const MATH_ROUTES = ["verify-ai-key", "verify-ai-key-plugback", "verify-ai-key-math-alt"];
const RW_ROUTES = ["verify-ai-key-rw-standard", "verify-ai-key-rw-eliminate"];

async function avgCost(routes: string[]): Promise<number> {
  let total = 0;
  for (const route of routes) {
    let cents = 0;
    let n = 0;
    for (let from = 0; ; from += 1000) {
      const { data } = await db.from("ai_usage_log").select("id, cost_cents").eq("route", route).order("id").range(from, from + 999);
      for (const r of data ?? []) {
        cents += (r.cost_cents as number | null) ?? 0;
        n++;
      }
      if (!data || data.length < 1000) break;
    }
    total += n ? cents / n : 0;
  }
  return total;
}

async function main() {
  const stats = await spotCheckStats(db);
  const pool: VerifyRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("questions")
      .select(VERIFY_SELECT)
      .eq("parsing_status", "Approved")
      .is("reviewed_by", null)
      .not("correct_answer", "is", null)
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    pool.push(...((data ?? []) as VerifyRow[]));
    if (!data || data.length < 1000) break;
  }
  if (stats.error) throw new Error(`spot-check results unreadable: ${stats.error}`);
  const done = await loadSpotCheckResults(db);
  const unchecked = pool.filter((r) => !done.has(r.id));
  const need = Math.max(0, stats.sampleTarget - stats.checked);
  // Random sample (Fisher–Yates).
  for (let i = unchecked.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [unchecked[i], unchecked[j]] = [unchecked[j], unchecked[i]];
  }
  const sample = unchecked.slice(0, Math.min(need, LIMIT));
  const math = sample.filter((r) => r.section === "Math").length;
  const rw = sample.length - math;
  const [mathCost, rwCost] = await Promise.all([avgCost(MATH_ROUTES), avgCost(RW_ROUTES)]);
  const est = math * mathCost + rw * rwCost;
  console.log(`System-approved: ${stats.system} · already spot-checked: ${stats.checked} (${stats.wrong} wrong) · 5% target: ${stats.sampleTarget}`);
  console.log(`Sample now: ${sample.length} (${math} Math, ${rw} Reading & Writing)`);
  console.log(`Estimated AI cost: ${math} × ${mathCost.toFixed(2)}¢ + ${rw} × ${rwCost.toFixed(2)}¢ ≈ $${(est / 100).toFixed(2)} (averages of ai_usage_log routes ${[...MATH_ROUTES, ...RW_ROUTES].join(", ")})`);
  if (!APPLY) {
    console.log("\nDry run: no AI calls made. Re-run with --apply to check the sample.");
    return;
  }
  const backup = path.join(process.cwd(), ".omc", "backups", `spot-check-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(backup, JSON.stringify(sample, null, 2));
  // Same logic as the daily cron (lib/spot-check-run.ts): live status is
  // re-checked right before each write, a live question is never demoted.
  const tally = { passed: 0, wrong: 0, inconclusive: 0, error: 0 };
  for (const r of sample) {
    const l = await spotCheckOne(db, r);
    tally[l.outcome]++;
    const label = l.outcome === "wrong" ? (l.live ? "WRONG (live: kept Approved, [live-fix])" : "WRONG (→ Needs Review)") : l.outcome;
    console.log(`  ${label} Q${l.number} ${l.id.slice(0, 8)}: ${l.detail}`);
  }
  console.log(tally);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
