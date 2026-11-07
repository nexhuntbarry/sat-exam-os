// scripts/auto-key-no-key-modules.ts
//
// Modules whose PDF carries NO answer key (official_answer null on every
// question): set the key automatically where the code-checked solve and a
// second independent solve agree on another answer
// (lib/verify-ai-key.ts autoKeyDecision). Each change goes through
// lib/key-change.ts applyKeyCorrection — explanation written from an
// independent solve and checked in the same write, answers rescored. Live-test
// questions are never changed: they get the disagreement note + [live-fix].
// Everything else that disagrees is queued (verify-ai-key note) as before.
//
// Checks are reused from .omc/reports/verify-ai-keys-results-<date>.jsonl when
// the stored key is unchanged since; --fresh re-runs them (AI calls).
//
//   npx tsx --env-file=.env.local scripts/auto-key-no-key-modules.ts            # dry run
//   npx tsx --env-file=.env.local scripts/auto-key-no-key-modules.ts --apply [--fresh] [--module <id>]
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { liveQuestionIds } from "../lib/live-questions";
import { applyKeyCorrection } from "../lib/key-change";
import { isQaEmail } from "../lib/qa";
import {
  autoKeyDecision,
  decideVerification,
  loadAiOnlyRows,
  moduleHasRealKey,
  runChecks,
  type VerifyChecks,
  type VerifyRow,
} from "../lib/verify-ai-key";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const FRESH = args.includes("--fresh");
const MODULES = args.flatMap((a, i) => (a === "--module" && args[i + 1] ? [args[i + 1]] : []));
const DATE = new Date().toISOString().slice(0, 10);
const RESULTS = path.join(process.cwd(), ".omc", "reports", "verify-ai-keys-results-2026-11-07.jsonl");

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function all<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

function storedChecks(): Map<string, { key: string | null; checks: VerifyChecks }> {
  const m = new Map<string, { key: string | null; checks: VerifyChecks }>();
  if (!fs.existsSync(RESULTS)) return m;
  for (const l of fs.readFileSync(RESULTS, "utf8").split("\n")) {
    if (!l.trim()) continue;
    const r = JSON.parse(l) as { id: string; key: string | null; checks?: VerifyChecks };
    if (r.checks) m.set(r.id, { key: r.key, checks: r.checks });
  }
  return m;
}

/** Real (non-QA) students with an answer on the question. */
async function affectedStudents(questionId: string): Promise<{ id: string; name: string; email: string }[]> {
  const recs = await all<{ submission_id: string }>((f, t) => db.from("answer_records").select("submission_id").eq("question_id", questionId).order("id").range(f, t));
  const subs = [...new Set(recs.map((r) => r.submission_id))];
  const ids = new Set<string>();
  for (let i = 0; i < subs.length; i += 100) {
    const { data } = await db.from("submissions").select("student_id").in("id", subs.slice(i, i + 100));
    for (const s of data ?? []) if (s.student_id) ids.add(s.student_id as string);
  }
  if (ids.size === 0) return [];
  const { data: users } = await db.from("users").select("id, display_name, email").in("id", [...ids]);
  return (users ?? [])
    .filter((u) => !isQaEmail(u.email as string | null))
    .map((u) => ({ id: u.id as string, name: (u.display_name as string | null) ?? "", email: (u.email as string | null) ?? "" }));
}

async function main() {
  const { data: mods } = await db.from("modules").select("id, module_name");
  const modName = new Map((mods ?? []).map((m) => [m.id as string, m.module_name as string]));
  const allRows = await all<{ module_id: string | null; official_answer: string | null }>((f, t) =>
    db.from("questions").select("module_id, official_answer").order("id").range(f, t),
  );
  const byModule = new Map<string, { official_answer: string | null }[]>();
  for (const r of allRows) if (r.module_id) byModule.set(r.module_id, [...(byModule.get(r.module_id) ?? []), r]);
  const noKeyModules = [...byModule.entries()].filter(([, rs]) => !moduleHasRealKey(rs)).map(([id]) => id);
  const targetModules = MODULES.length ? noKeyModules.filter((m) => MODULES.includes(m)) : noKeyModules;
  console.log(`${noKeyModules.length} modules with no real answer key:`);
  for (const m of noKeyModules) console.log(`  - ${modName.get(m) ?? m}`);

  const rows = (await loadAiOnlyRows(db, targetModules)).filter((r) => r.parsing_status !== "Rejected");
  const live = await liveQuestionIds(db, rows.map((r) => r.id));
  const stored = storedChecks();
  console.log(`\n${rows.length} questions (${APPLY ? "APPLY" : "dry run"}${FRESH ? ", fresh checks" : ", stored checks"})\n`);

  const out: { row: VerifyRow; action: string; detail: string; students?: { id: string; name: string; email: string }[] }[] = [];
  if (APPLY) {
    const backup = path.join(process.cwd(), ".omc", "backups", `auto-key-${DATE}-${Date.now()}.json`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, JSON.stringify(rows, null, 2));
    console.log(`backup: ${backup}`);
  }
  for (const r of rows.sort((a, b) => String(a.module_id).localeCompare(String(b.module_id)) || (a.original_question_number ?? 0) - (b.original_question_number ?? 0))) {
    const label = `${modName.get(r.module_id ?? "") ?? r.module_id} Q${r.original_question_number}`;
    let checks: VerifyChecks | null = null;
    const s = stored.get(r.id);
    if (!FRESH && s && s.key === r.correct_answer) checks = s.checks;
    else if (FRESH) checks = await runChecks(r);
    if (!checks) {
      out.push({ row: r, action: "no-checks", detail: "no stored checks for the current key (run with --fresh)" });
      continue;
    }
    const isLive = live.has(r.id);
    const d = autoKeyDecision(r, checks, { moduleHasRealKey: false, live: isLive });
    if (d.action === "none") {
      out.push({ row: r, action: "none", detail: d.reason });
      continue;
    }
    if (d.action === "queue_live") {
      // Same disagreement note the verifier writes ([live-fix], stays Approved).
      const v = decideVerification(r, checks, true);
      if (APPLY && v.update) {
        await db.from("questions").update(v.update).eq("id", r.id).eq("updated_at", r.updated_at as string);
      }
      out.push({ row: r, action: "queued-live", detail: `${d.reason} → ${r.correct_answer} kept, queued` });
      continue;
    }
    const students = await affectedStudents(r.id);
    if (!APPLY) {
      out.push({ row: r, action: "would-set", detail: `${r.correct_answer} → ${d.key}: ${d.reason}`, students });
      continue;
    }
    const res = await applyKeyCorrection(db, {
      id: r.id,
      correct_answer: d.key,
      expectedKey: r.correct_answer,
      rescore: true,
      source: "auto-key (module has no answer key, code solve + second solve agree)",
      // Re-checked at write time: a test may have gone live since the scan.
      refuseLive: true,
    });
    if (!res.ok) {
      out.push({ row: r, action: "error", detail: res.error });
      continue;
    }
    const ex = res.explanation;
    out.push({
      row: r,
      action: res.explanationOk ? "set" : "set-explanation-failed",
      detail: `${r.correct_answer} → ${d.key}: ${d.reason}; explanation ${ex?.outcome ?? "?"}${ex?.reason ? ` (${ex.reason})` : ""}; rescored ${res.rescore?.recordsUpdated ?? 0} answers / ${res.rescore?.submissionsRescored ?? 0} attempts`,
      students,
    });
    console.log(`${label}: ${out[out.length - 1].action} — ${out[out.length - 1].detail}`);
  }

  const count = (a: string) => out.filter((o) => o.action === a).length;
  console.log("\n── Summary ──");
  for (const a of ["would-set", "set", "set-explanation-failed", "queued-live", "none", "no-checks", "error"]) if (count(a)) console.log(`${a}: ${count(a)}`);
  console.log("\n── Key changes ──");
  for (const o of out.filter((x) => x.action.startsWith("set") || x.action === "would-set" || x.action === "queued-live")) {
    const st = o.students?.length ? ` — real students affected: ${o.students.map((s) => `${s.name || "?"} <${s.email}>`).join(", ")}` : " — no real student answers";
    console.log(`${o.action.padEnd(22)} ${modName.get(o.row.module_id ?? "") ?? o.row.module_id} Q${o.row.original_question_number}: ${o.detail}${o.action === "queued-live" ? "" : st}`);
  }
  const reportPath = path.join(process.cwd(), ".omc", "reports", `auto-key-no-key-modules-${DATE}${APPLY ? "" : ".dry-run"}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(out.map((o) => ({ id: o.row.id, module: modName.get(o.row.module_id ?? ""), q: o.row.original_question_number, key: o.row.correct_answer, action: o.action, detail: o.detail, students: o.students })), null, 2));
  console.log(`\nreport: ${reportPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
