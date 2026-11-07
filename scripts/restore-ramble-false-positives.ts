// scripts/restore-ramble-false-positives.ts
//
// The 2026-11-07 explanation scan (scan-explanation-key-mismatch.ts) used a
// "thinking aloud" regex that also matched normal text ("Customers wait, on
// average", "Students recheck"). For every question that scan touched whose
// ONLY reason was that regex: if its old explanation passes every pattern
// under the corrected rule, put the old explanation, notes and status back
// (an Approved question demoted by the scan goes back to Approved only when
// nothing else blocks it — lib/review-decide decideBlockers; live questions
// were never demoted). Compare-and-set on updated_at.
//
//   npx tsx --env-file=.env.local scripts/restore-ramble-false-positives.ts            # dry run
//   npx tsx --env-file=.env.local scripts/restore-ramble-false-positives.ts --apply
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { draftRejection, type AutoFixRow } from "../lib/explanation-autofix";
import { removeNotes, splitLiveFixNote } from "../lib/review-queue";
import { REGEN_DISAGREE_PREFIX } from "../lib/ai/solve-question";
import { KEY_EXPLANATION_FAILED_PREFIX } from "../lib/key-change";
import { NARRATION_PATTERNS, scanPatterns } from "../lib/explanation-scan";
import { decideBlockers } from "../lib/review-decide";
import { KEY_ROW_SELECT } from "../lib/key-change";

const APPLY = process.argv.includes("--apply");
const STAMP = "2026-11-07T21-17-19-718Z";
const BACKUP = path.join(process.cwd(), ".omc", "backups", `scan-explanations-${STAMP}.json`);
const RESULTS = path.join(process.cwd(), ".omc", "reports", `scan-explanations-${STAMP}.apply.json`);

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  const before = JSON.parse(fs.readFileSync(BACKUP, "utf8")) as AutoFixRow[];
  const results = JSON.parse(fs.readFileSync(RESULTS, "utf8")) as { id: string; live: boolean; patterns: string[]; result: string }[];
  const out: string[] = [];
  let restored = 0;
  for (const r of results) {
    const old = before.find((b) => b.id === r.id);
    if (!old) continue;
    const narrationOnly = r.patterns.length > 0 && r.patterns.every((p) => (NARRATION_PATTERNS as string[]).includes(p));
    if (!narrationOnly) continue;
    // A rewrite already passed every check (and an independent solve): keep it.
    if (r.result === "rewritten") {
      out.push(`keep   ${r.id.slice(0, 8)} rewritten — the checked rewrite stays`);
      continue;
    }
    const now = scanPatterns(old);
    const rejected = draftRejection(old, old.explanation ?? "");
    if (now.patterns.length > 0 || rejected) {
      out.push(`keep   ${r.id.slice(0, 8)} ${r.result} — old text still fails: ${[...now.details, rejected].filter(Boolean).join("; ")}`);
      continue;
    }
    const { data: cur } = await db.from("questions").select(KEY_ROW_SELECT).eq("id", r.id).maybeSingle();
    const c = cur as AutoFixRow | null;
    if (!c) continue;
    if ((c.correct_answer ?? "") !== (old.correct_answer ?? "")) {
      out.push(`skip   ${r.id.slice(0, 8)} — key changed since the scan`);
      continue;
    }
    // Status: the old one, except an Approved row comes back only if nothing blocks it.
    let status = old.parsing_status;
    if (old.parsing_status === "Approved" && c.parsing_status !== "Approved" && decideBlockers(old).length > 0) status = c.parsing_status;
    // Notes: the old ones, plus anything added since the scan that isn't the
    // scan's own (failure / disagreement notes, its [live-fix] lead).
    const scanOwn = (seg: string) => seg.startsWith(KEY_EXPLANATION_FAILED_PREFIX) || seg.startsWith(REGEN_DISAGREE_PREFIX);
    const oldSegs = new Set(removeNotes(old.parsing_notes, () => false).notes?.split("; ") ?? []);
    const added = (removeNotes(splitLiveFixNote(c.parsing_notes).rest, scanOwn).notes ?? "").split("; ").filter((x) => x && !oldSegs.has(x));
    const notes = [old.parsing_notes, ...added].filter(Boolean).join("; ") || null;
    const update = { explanation: old.explanation, parsing_notes: notes, parsing_status: status, updated_at: new Date().toISOString() };
    out.push(`restore ${r.id.slice(0, 8)} ${r.live ? "LIVE " : ""}${r.result}: explanation + notes restored, status ${c.parsing_status} → ${status}`);
    if (APPLY) {
      let q = db.from("questions").update(update).eq("id", r.id);
      if (c.updated_at) q = q.eq("updated_at", c.updated_at);
      const { data: w, error } = await q.select("id");
      if (error || !w?.length) out[out.length - 1] += ` — NOT written (${error?.message ?? "row changed"})`;
      else restored++;
    }
  }
  console.log(out.join("\n"));
  console.log(`\n${APPLY ? `restored ${restored}` : "dry run"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
