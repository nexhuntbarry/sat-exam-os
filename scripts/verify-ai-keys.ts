// scripts/verify-ai-keys.ts
//
// Code-verify every AI-only answer key (official_answer is null) with
// lib/verify-ai-key.ts: code solve + plug-back of the stored key + a second
// independent solve (R&W: two independent solves). Dry run by default.
// Never changes a key, never rescores, never demotes Approved / live rows.
//
//   node --env-file=.env.local --import tsx scripts/verify-ai-keys.ts                 # dry run, all groups
//   node --env-file=.env.local --import tsx scripts/verify-ai-keys.ts --apply --group 1
//   … --module <module id> (repeatable) | --group 1..4 | --limit N | --concurrency N | --resume
//
// Groups (priority order, owner 2026-11-07):
//   1  [Test #20] November 2024 SAT Math Module 1 + 2 (Approved, in published tests)
//   2  Math Module 001 Test, RW Module 001 Test
//   3  [Test #13] L Test M1/M2, [Test #14] J Test M2
//   4  everything else that is AI-only
//
// Every run appends one JSON line per question to
// .omc/reports/verify-ai-keys-results-<date>.jsonl (--resume skips ids already
// there) and rewrites .omc/reports/verify-ai-keys-<date>.md from all lines.
// Rows are backed up to .omc/backups before any write.
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { liveQuestionIds } from "../lib/live-questions";
import {
  decideVerification,
  loadAiOnlyRows,
  runChecks,
  type VerifyChecks,
  type VerifyOutcome,
  type VerifyRow,
} from "../lib/verify-ai-key";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const RESUME = args.includes("--resume");
const argVals = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const LIMIT = Number(argVals("--limit")[0] ?? Infinity);
const CONCURRENCY = Number(argVals("--concurrency")[0] ?? 4);
const GROUPS = argVals("--group").map(Number);
const MODULES = argVals("--module");
const DATE = "2026-11-07";

const GROUP_MODULES: Record<number, string[]> = {
  1: ["15d7e798-c0b5-4221-bc17-c0a4d9942f6e", "2125c698-b599-402c-94c3-1cedead81c6c"],
  2: ["4172ae56-db46-4940-a60d-08966bcf8f56", "86f950a0-e43a-4366-b92f-754a10f45fce"],
  3: ["44320ba2-d466-4373-85c0-865ad2c1b7ff", "0505e0d4-1c48-4e3a-9103-38b2ea0f5a2a", "acbb354c-4455-49b7-b975-5c4a1fbeca85"],
};

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const REPORT_DIR = path.join(process.cwd(), ".omc", "reports");
const RESULTS = path.join(REPORT_DIR, `verify-ai-keys-results-${DATE}.jsonl`);
const REPORT = path.join(REPORT_DIR, `verify-ai-keys-${DATE}.md`);

interface ResultLine {
  id: string;
  module_id: string | null;
  module: string;
  number: number | null;
  section: string | null;
  type: string | null;
  status_before: string | null;
  status_after: string | null;
  key: string | null;
  outcome: VerifyOutcome | "skipped" | "error";
  approved: boolean;
  summary: string;
  blockers: string[];
  ai?: string;
  value?: string | null;
  live: boolean;
  published: boolean;
  applied: boolean;
  checks?: VerifyChecks;
  at: string;
}

function groupOf(moduleId: string | null): number {
  for (const [g, ids] of Object.entries(GROUP_MODULES)) if (moduleId && ids.includes(moduleId)) return Number(g);
  return 4;
}

async function publishedSets() {
  const { data: tests, error } = await db
    .from("tests")
    .select("id, test_name, module_id, module_1_id, module_2_id, module_2_easy_id, module_2_hard_id, question_ids")
    .eq("status", "Published");
  if (error) throw error;
  const modules = new Map<string, string[]>();
  const questions = new Map<string, string[]>();
  for (const t of tests ?? []) {
    for (const m of [t.module_id, t.module_1_id, t.module_2_id, t.module_2_easy_id, t.module_2_hard_id]) {
      if (m) modules.set(m, [...(modules.get(m) ?? []), t.test_name]);
    }
    for (const q of (t.question_ids as string[] | null) ?? []) questions.set(q, [...(questions.get(q) ?? []), t.test_name]);
  }
  return { modules, questions };
}

async function studentCounts(ids: string[]): Promise<Map<string, { answers: number; students: number }>> {
  const out = new Map<string, { answers: number; students: number }>();
  for (const id of ids) {
    const recs: { submission_id: string }[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await db.from("answer_records").select("submission_id").eq("question_id", id).order("id").range(from, from + 999);
      recs.push(...((data ?? []) as { submission_id: string }[]));
      if (!data || data.length < 1000) break;
    }
    const subs = [...new Set(recs.map((r) => r.submission_id))];
    const students = new Set<string>();
    for (let i = 0; i < subs.length; i += 100) {
      const { data } = await db.from("submissions").select("student_id").in("id", subs.slice(i, i + 100));
      for (const s of data ?? []) if (s.student_id) students.add(s.student_id as string);
    }
    out.set(id, { answers: recs.length, students: students.size });
  }
  return out;
}

function readResults(): ResultLine[] {
  if (!fs.existsSync(RESULTS)) return [];
  const latest = new Map<string, ResultLine>();
  for (const l of fs.readFileSync(RESULTS, "utf8").split("\n")) {
    if (!l.trim()) continue;
    const r = JSON.parse(l) as ResultLine;
    latest.set(r.id, r);
  }
  return [...latest.values()];
}

async function writeReport() {
  const all = readResults();
  const applied = all.filter((r) => r.applied);
  const shown = applied.length > 0 ? applied : all;
  const mode = applied.length > 0 ? "applied" : "dry run";
  const byModule = new Map<string, ResultLine[]>();
  for (const r of shown) byModule.set(r.module, [...(byModule.get(r.module) ?? []), r]);
  const n = (rs: ResultLine[], o: string) => rs.filter((r) => r.outcome === o).length;
  const pubDisagree = shown.filter((r) => r.outcome === "disagree" && r.published);
  const counts = await studentCounts(pubDisagree.map((r) => r.id));
  const order = [...byModule.entries()].sort((a, b) => groupOf(a[1][0].module_id) - groupOf(b[1][0].module_id) || a[0].localeCompare(b[0]));

  const lines: string[] = [];
  lines.push(`# AI-only answer keys — code verification (${DATE})`, "");
  lines.push(
    `Source: \`scripts/verify-ai-keys.ts\` (${mode}). Each AI-only key (official_answer is null) was checked three ways: a code-computed solve (the model writes the computation, code evaluates it with \`lib/math/safe-eval.ts\`, applies the rounding and maps it to a choice), a plug-back of the stored key (conditions evaluated in code), and a second independent solve with a different model and method. Reading & Writing: two independent solves. No key was changed and nothing was rescored. Approved and live-test questions were never demoted.`,
    "",
  );
  lines.push(`Totals: ${shown.length} questions — verified ${n(shown, "verified")} (approved now ${shown.filter((r) => r.approved).length}), disagree ${n(shown, "disagree")}, unverified ${n(shown, "unverified")}, no-answer ${n(shown, "no-answer")}${n(shown, "error") ? `, error ${n(shown, "error")}` : ""}${n(shown, "skipped") ? `, skipped ${n(shown, "skipped")}` : ""}.`, "");

  lines.push("## ⚠ Disagreements on questions in published tests", "");
  if (pubDisagree.length === 0) lines.push("None.", "");
  else {
    lines.push("| Module | Q | Status | Live | Key | AI says | Checks | Students answered (answers) |", "|---|---|---|---|---|---|---|---|");
    for (const r of pubDisagree.sort((a, b) => a.module.localeCompare(b.module) || (a.number ?? 0) - (b.number ?? 0))) {
      const c = counts.get(r.id) ?? { answers: 0, students: 0 };
      lines.push(`| ${r.module} | ${r.number} | ${r.status_after} | ${r.live ? "yes" : "no"} | ${r.key} | ${r.ai ?? "?"}${r.value ? ` (${r.value})` : ""} | ${r.summary.replace(/\|/g, "/")} | ${c.students} (${c.answers}) |`);
    }
    lines.push("");
  }

  lines.push("## Per module", "", "| Group | Module | Questions | Verified | Approved now | Disagree | Unverified | No answer | Published |", "|---|---|---|---|---|---|---|---|---|");
  for (const [m, rs] of order) {
    lines.push(`| ${groupOf(rs[0].module_id)} | ${m} | ${rs.length} | ${n(rs, "verified")} | ${rs.filter((r) => r.approved).length} | ${n(rs, "disagree")} | ${n(rs, "unverified")} | ${n(rs, "no-answer")} | ${rs.some((r) => r.published) ? "yes" : "no"} |`);
  }
  lines.push("");

  lines.push("## All disagreements (go to a person)", "");
  const dis = shown.filter((r) => r.outcome === "disagree");
  if (dis.length === 0) lines.push("None.", "");
  for (const r of dis.sort((a, b) => a.module.localeCompare(b.module) || (a.number ?? 0) - (b.number ?? 0))) {
    lines.push(`- **${r.module} Q${r.number}** (${r.type === "Student Produced Response" ? "fill-in" : "MC"}, ${r.status_after}${r.live ? ", live" : ""}${r.published ? ", published" : ""}): key **${r.key}**, AI **${r.ai ?? "?"}**${r.value ? ` (${r.value})` : ""} — ${r.summary}`);
  }
  lines.push("");

  lines.push("## Verified but still in review (other blockers)", "");
  const held = shown.filter((r) => r.outcome === "verified" && !r.approved && r.status_after !== "Approved");
  if (held.length === 0) lines.push("None.", "");
  for (const r of held) lines.push(`- ${r.module} Q${r.number} (${r.status_after}${r.live ? ", live" : ""}): ${r.blockers.slice(0, 3).join("; ") || "status kept (live test / Draft)"}`);
  lines.push("");

  lines.push("## Unverified / no answer (inconclusive — nothing written)", "");
  const inc = shown.filter((r) => r.outcome === "unverified" || r.outcome === "no-answer" || r.outcome === "error");
  if (inc.length === 0) lines.push("None.", "");
  for (const r of inc) lines.push(`- ${r.module} Q${r.number}: ${r.outcome} — ${r.summary}`);
  lines.push("");
  lines.push(
    "## Note format",
    "",
    "Disagreements carry one parsing_notes segment (constant `AI_KEY_DISAGREE_PREFIX` / `AI_KEY_DISAGREE_RE` in `lib/verify-ai-key.ts`, parse with `parseAiKeyDisagreeNote`):",
    "",
    "`Needs review: key says <KEY>, AI says <AI>[ (<VALUE>)] — <per-check detail> [verify-ai-key <date>]`",
    "",
  );
  fs.writeFileSync(REPORT, lines.join("\n"));
  console.log(`report: ${REPORT}`);
}

async function main() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  if (args.includes("--report-only")) return writeReport();

  const { data: mods } = await db.from("modules").select("id, module_name");
  const modName = new Map((mods ?? []).map((m) => [m.id as string, m.module_name as string]));
  let rows = await loadAiOnlyRows(db, MODULES.length ? MODULES : undefined);
  if (GROUPS.length) rows = rows.filter((r) => GROUPS.includes(groupOf(r.module_id)));
  if (RESUME) {
    const done = new Set(readResults().filter((r) => r.applied === APPLY && r.outcome !== "error").map((r) => r.id));
    rows = rows.filter((r) => !done.has(r.id));
  }
  rows.sort((a, b) => groupOf(a.module_id) - groupOf(b.module_id) || String(a.module_id).localeCompare(String(b.module_id)) || (a.original_question_number ?? 0) - (b.original_question_number ?? 0));
  rows = rows.slice(0, LIMIT);
  console.log(`${rows.length} AI-only questions (${APPLY ? "APPLY" : "dry run"})`);
  if (rows.length === 0) return writeReport();

  const backupDir = path.join(process.cwd(), ".omc", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, `verify-ai-keys-${DATE}-${Date.now()}.json`);
  fs.writeFileSync(backup, JSON.stringify(rows, null, 2));
  console.log(`backup: ${backup}`);

  const live = await liveQuestionIds(db, rows.map((r) => r.id));
  const pub = await publishedSets();
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const r = rows[next++] as VerifyRow;
      const published = pub.questions.has(r.id) || (!!r.module_id && pub.modules.has(r.module_id));
      const base = {
        id: r.id,
        module_id: r.module_id,
        module: modName.get(r.module_id ?? "") ?? String(r.module_id),
        number: r.original_question_number,
        section: r.section ?? null,
        type: r.question_type,
        status_before: r.parsing_status,
        key: r.correct_answer,
        live: live.has(r.id),
        published,
        applied: APPLY,
      };
      let line: ResultLine;
      try {
        const checks = await runChecks(r);
        const d = decideVerification(r, checks, live.has(r.id));
        let statusAfter = (d.update?.parsing_status as string | undefined) ?? r.parsing_status;
        let outcome: ResultLine["outcome"] = d.outcome;
        if (APPLY && d.update) {
          // Only if nobody changed the row meanwhile.
          const { data, error } = await db.from("questions").update(d.update).eq("id", r.id).eq("updated_at", r.updated_at as string).select("id");
          if (error) throw new Error(error.message);
          if (!data || data.length === 0) {
            outcome = "skipped";
            statusAfter = r.parsing_status;
          }
        }
        line = {
          ...base,
          status_after: statusAfter,
          outcome,
          approved: d.approved && outcome !== "skipped",
          summary: d.summary,
          blockers: d.blockers,
          ai: d.disagreement?.ai,
          value: d.disagreement?.value ?? null,
          checks,
          at: new Date().toISOString(),
        };
      } catch (e) {
        line = { ...base, status_after: r.parsing_status, outcome: "error", approved: false, summary: e instanceof Error ? e.message : String(e), blockers: [], at: new Date().toISOString() };
      }
      fs.appendFileSync(RESULTS, JSON.stringify(line) + "\n");
      done++;
      console.log(`[${done}/${rows.length}] ${line.module} Q${line.number}: ${line.outcome}${line.approved ? " → Approved" : ""} — ${line.summary}${line.outcome === "disagree" ? ` (key ${line.key}, AI ${line.ai})` : ""}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
  await writeReport();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
