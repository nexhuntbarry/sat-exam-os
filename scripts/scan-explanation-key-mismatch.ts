// scripts/scan-explanation-key-mismatch.ts
//
// Bank-wide scan for explanations a student must not see, then a rewrite
// through the key-change path (lib/key-change.ts settleExplanationForKey:
// independent solve first, explanation only if it agrees, every check incl.
// the numeric consistency check). Patterns:
//   wait / let me / re-check / hmm / other thinking aloud / hedging,
//   self-contradiction (two answers, or a computation that doesn't add up),
//   very long (> MAX_EXPLANATION_WORDS), final answer ≠ key.
// Questions whose key changed (notes "Answer key check: key …") are counted
// separately. A rewrite that fails: not live → Needs Review, stale text
// removed; live → stays Approved, [live-fix] note, explanation hidden unless
// the current one still passes every check. Never demotes a live question.
//
//   npx tsx --env-file=.env.local scripts/scan-explanation-key-mismatch.ts            # dry run: list
//   npx tsx --env-file=.env.local scripts/scan-explanation-key-mismatch.ts --apply [--limit N] [--only <pattern>]
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { liveQuestionIds } from "../lib/live-questions";
import { KEY_ROW_SELECT, settleExplanationForKey } from "../lib/key-change";
import type { AutoFixRow } from "../lib/explanation-autofix";
import { PATTERNS, scanPatterns, type Pattern } from "../lib/explanation-scan";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const LIMIT = Number(args[args.indexOf("--limit") + 1] ?? NaN) || Infinity;
const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const CONCURRENCY = 3;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  const rows: AutoFixRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("questions").select(KEY_ROW_SELECT).neq("parsing_status", "Rejected").order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as AutoFixRow[]));
    if (!data || data.length < 1000) break;
  }
  const scanned = rows.filter((r) => (r.correct_answer ?? "").trim() && (r.explanation ?? "").trim());
  const { data: mods } = await db.from("modules").select("id, module_name");
  const modName = new Map((mods ?? []).map((m) => [m.id as string, m.module_name as string]));
  let hits = scanned
    .map((r) => ({ r, ...scanPatterns(r), keyChanged: /Answer key check: key /.test(r.parsing_notes ?? "") }))
    .filter((h) => h.patterns.length > 0);
  if (ONLY) hits = hits.filter((h) => h.patterns.includes(ONLY as Pattern));
  const live = await liveQuestionIds(db, hits.map((h) => h.r.id));

  console.log(`scanned ${scanned.length} questions with a key and an explanation (${rows.length} non-Rejected rows)`);
  console.log(`matched ${hits.length} (live ${hits.filter((h) => live.has(h.r.id)).length}, not live ${hits.filter((h) => !live.has(h.r.id)).length})`);
  for (const p of PATTERNS) {
    const n = hits.filter((h) => h.patterns.includes(p));
    console.log(`  ${p.padEnd(19)} ${String(n.length).padStart(4)}  (live ${n.filter((h) => live.has(h.r.id)).length})`);
  }
  const kc = hits.filter((h) => h.keyChanged);
  console.log(`  key changed (notes "Answer key check: key"): ${kc.length} of ${scanned.filter((r) => /Answer key check: key /.test(r.parsing_notes ?? "")).length} such questions`);
  console.log("\n── List ──");
  for (const h of hits) {
    console.log(`${h.r.id.slice(0, 8)} ${(modName.get(h.r.module_id ?? "") ?? "?").slice(0, 44).padEnd(44)} Q${String(h.r.original_question_number).padEnd(3)} ${String(h.r.parsing_status).padEnd(12)} ${live.has(h.r.id) ? "LIVE" : "    "} key ${String(h.r.correct_answer).slice(0, 10).padEnd(10)} ${h.patterns.join(",")}${h.keyChanged ? " [key changed]" : ""} — ${h.details.join("; ").slice(0, 160)}`);
  }
  const reportDir = path.join(process.cwd(), ".omc", "reports");
  fs.mkdirSync(reportDir, { recursive: true });
  if (!APPLY) {
    const p = path.join(reportDir, `scan-explanations-${STAMP}.dry-run.json`);
    fs.writeFileSync(p, JSON.stringify(hits.map((h) => ({ id: h.r.id, module: modName.get(h.r.module_id ?? ""), q: h.r.original_question_number, status: h.r.parsing_status, live: live.has(h.r.id), key: h.r.correct_answer, patterns: h.patterns, details: h.details, keyChanged: h.keyChanged })), null, 2));
    console.log(`\ndry run — nothing written. list: ${p}`);
    return;
  }

  const todo = hits.slice(0, LIMIT);
  const backup = path.join(process.cwd(), ".omc", "backups", `scan-explanations-${STAMP}.json`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(backup, JSON.stringify(todo.map((h) => h.r), null, 2));
  console.log(`\nbackup: ${backup}\nrewriting ${todo.length}…`);
  const results: { id: string; live: boolean; patterns: Pattern[]; result: string; detail: string; status_after: string | null }[] = [];
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const h = todo[next++];
      const isLive = live.has(h.r.id);
      let result = "error";
      let detail = "";
      try {
        const s = await settleExplanationForKey(db, h.r.id, { live: isLive, route: "scan-explanations" });
        const ex = s.prepared?.explanation;
        result = !s.written ? "skipped" : s.ok ? "rewritten" : ex?.outcome === "ai_disagrees" ? "flagged-ai-disagrees" : "flagged-failed";
        detail = s.error ?? ex?.reason ?? "";
      } catch (e) {
        detail = e instanceof Error ? e.message : String(e);
      }
      const { data: after } = await db.from("questions").select("parsing_status").eq("id", h.r.id).maybeSingle();
      results.push({ id: h.r.id, live: isLive, patterns: h.patterns, result, detail, status_after: (after?.parsing_status as string | null) ?? null });
      console.log(`[${results.length}/${todo.length}] ${h.r.id.slice(0, 8)} Q${h.r.original_question_number} ${isLive ? "LIVE " : ""}${result}${detail ? ` — ${detail.slice(0, 140)}` : ""} (${h.r.parsing_status} → ${after?.parsing_status})`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const n = (f: (x: (typeof results)[number]) => boolean) => results.filter(f).length;
  console.log("\n── Result ──");
  console.log(`scanned ${scanned.length} | matched ${hits.length} | processed ${results.length}`);
  for (const r of ["rewritten", "flagged-ai-disagrees", "flagged-failed", "skipped", "error"]) {
    console.log(`  ${r.padEnd(21)} ${n((x) => x.result === r)} (live ${n((x) => x.result === r && x.live)}, not live ${n((x) => x.result === r && !x.live)})`);
  }
  console.log(`  live demoted: ${n((x) => x.live && x.status_after !== "Approved" && todo.find((h) => h.r.id === x.id)?.r.parsing_status === "Approved")}`);
  const p = path.join(reportDir, `scan-explanations-${STAMP}.apply.json`);
  fs.writeFileSync(p, JSON.stringify(results, null, 2));
  console.log(`report: ${p}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
