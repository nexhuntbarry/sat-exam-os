// scripts/backfill-key-source.ts
//
// Label every answer key by how it was set (Premier retest 2026-11-08 item 4).
// lib/key-source.ts derives most sources from data already on the row (PDF key,
// "Answer key check … (applied by …)" notes, hand-fix notes, verify-ai-key
// notes, the explanation auto-fix's independent solve, reviewed_by). This
// script fills in what only lives elsewhere and records it as a
// "Key source for <key>: <kind> — <detail>" note (tied to the key, so it stops
// counting when the key changes):
//   - verify-ai-key results (.omc/reports/verify-ai-keys-results-*.jsonl,
//     backed by ai_usage_log routes verify-ai-key*) that VERIFIED the current
//     key but whose note was later overwritten → "ai-checked";
//   - the reviewer who approved the question (reviewed_by → users) when the
//     source would otherwise be "Source not recorded" → "reviewer".
// Notes only (also on live-test questions); never the key, status or content.
// Dry run by default; idempotent (a row that already has the note, or whose
// source is already known, is skipped).
//
//   npx tsx --env-file=.env.prod scripts/backfill-key-source.ts           # dry run
//   npx tsx --env-file=.env.prod scripts/backfill-key-source.ts --apply
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { keySource, keySourceNote, moduleKeyFacts, KEY_SOURCE_NOTE_PREFIX, type KeySourceKind } from "../lib/key-source";

const APPLY = process.argv.includes("--apply");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Row = {
  id: string;
  module_id: string | null;
  original_question_number: number | null;
  question_type: string | null;
  question_text: string | null;
  correct_answer: string | null;
  official_answer: string | null;
  parsing_notes: string | null;
  parsing_status: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  updated_at: string | null;
};

async function main() {
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("questions")
      .select("id, module_id, original_question_number, question_type, question_text, correct_answer, official_answer, parsing_notes, parsing_status, reviewed_by, reviewed_at, updated_at")
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  const byModule = new Map<string, Row[]>();
  for (const r of rows) byModule.set(r.module_id ?? "", [...(byModule.get(r.module_id ?? "") ?? []), r]);
  const facts = new Map([...byModule].map(([id, rs]) => [id, moduleKeyFacts(rs)]));

  // verify-ai-key results: the latest line per question.
  const verified = new Map<string, { key: string | null; summary: string; at: string }>();
  const dir = path.join(process.cwd(), ".omc", "reports");
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => /^verify-ai-keys-results-.*\.jsonl$/.test(x)).sort() : []) {
    for (const l of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!l.trim()) continue;
      const r = JSON.parse(l) as { id: string; key: string | null; outcome: string; summary: string; at: string };
      if (r.outcome === "verified") verified.set(r.id, { key: r.key, summary: r.summary, at: r.at });
      else verified.delete(r.id);
    }
  }
  // ai_usage_log: which questions the verifier ran on (evidence it really ran).
  const verifyLogged = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("ai_usage_log").select("id, route, metadata").like("route", "verify-ai-key%").order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const l of data ?? []) {
      const q = (l.metadata as { question_id?: string } | null)?.question_id;
      if (q) verifyLogged.add(q);
    }
    if (!data || data.length < 1000) break;
  }
  const reviewerIds = [...new Set(rows.map((r) => r.reviewed_by).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  for (let i = 0; i < reviewerIds.length; i += 100) {
    const { data } = await db.from("users").select("id, display_name, email").in("id", reviewerIds.slice(i, i + 100));
    for (const u of data ?? []) names.set(u.id as string, ((u.display_name as string | null) || (u.email as string | null) || "a reviewer") as string);
  }

  const before = new Map<KeySourceKind, number>();
  const after = new Map<KeySourceKind, number>();
  const plans: { r: Row; note: string; kind: KeySourceKind }[] = [];
  const date = new Date().toISOString().slice(0, 10);
  for (const r of rows) {
    if (!(r.correct_answer ?? "").trim() || r.parsing_status === "Rejected") continue;
    const mod = facts.get(r.module_id ?? "") ?? null;
    const src = keySource({ ...r, reviewer_name: r.reviewed_by ? names.get(r.reviewed_by) ?? null : null }, mod);
    before.set(src.kind, (before.get(src.kind) ?? 0) + 1);
    let note: string | null = null;
    let kind: KeySourceKind = src.kind;
    if ((r.parsing_notes ?? "").includes(`${KEY_SOURCE_NOTE_PREFIX} `)) {
      // already recorded
    } else if ((src.kind === "unknown" || src.kind === "ai" || src.kind === "ai-agreed") && verified.get(r.id)?.key === r.correct_answer && verifyLogged.has(r.id)) {
      const v = verified.get(r.id)!;
      kind = "ai-checked";
      note = keySourceNote(r.correct_answer!, "ai-checked", `re-solved and checked in code on ${v.at.slice(0, 10)} (${v.summary.replace(/[()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)}) [backfill ${date}]`);
    } else if (src.kind === "unknown" && r.reviewed_by && r.reviewed_at) {
      kind = "reviewer";
      note = keySourceNote(r.correct_answer!, "reviewer", `confirmed by ${names.get(r.reviewed_by) ?? "a reviewer"} on ${new Date(r.reviewed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" })}.`);
    }
    after.set(kind, (after.get(kind) ?? 0) + 1);
    if (note) plans.push({ r, note, kind });
  }
  console.log(`${APPLY ? "APPLY" : "DRY RUN"}: key sources of ${[...before.values()].reduce((a, b) => a + b, 0)} keyed questions (not Rejected)`);
  console.log("before:", Object.fromEntries(before));
  console.log("after: ", Object.fromEntries(after));
  console.log(`${plans.length} notes to add`);
  for (const p of plans.slice(0, 40)) console.log(`  ${p.r.id.slice(0, 8)} Q${p.r.original_question_number} ${p.r.correct_answer}: ${p.note}`);
  if (!APPLY || plans.length === 0) return;
  const backup = path.join(process.cwd(), ".omc", "backups", `backfill-key-source-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(backup, JSON.stringify(plans.map((p) => ({ id: p.r.id, parsing_notes: p.r.parsing_notes, updated_at: p.r.updated_at })), null, 2));
  console.log(`backup: ${backup}`);
  let ok = 0;
  for (const p of plans) {
    // Notes only; compare-and-set on updated_at so a concurrent edit wins.
    const { data } = await db
      .from("questions")
      .update({ parsing_notes: [p.r.parsing_notes, p.note].filter(Boolean).join("; "), updated_at: new Date().toISOString() })
      .eq("id", p.r.id)
      .eq("updated_at", p.r.updated_at as string)
      .select("id");
    if (data?.length) ok++;
  }
  console.log(`written: ${ok}/${plans.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
