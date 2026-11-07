// scripts/audit-spr-rescore-impact.ts
//
// READ-ONLY impact report for the official College Board fill-in (SPR)
// rules (owner-approved 2026-11-07). Writes nothing to the database.
//
//   (a) every fill-in key that breaks the rules, with a suggested fix
//       (lib/key-check analyzeKeyRow), keys stored as an approximation of a
//       fraction (".6667" → 2/3), and verified keys longer than 5/6
//       characters (the answer box widens for those);
//   (b) every past answer_record on a fill-in question: the stored
//       is_correct vs the new rules (answersMatch with the key the record was
//       graded against + the question's rounding instruction), and for each
//       affected submission the old/new raw + scaled score, computed the way
//       lib/rescore.ts would (scoreFromRecords) — without writing.
//
// QA users (lib/qa isQaEmail) are excluded; records whose student no longer
// exists are listed separately as orphans.
//
// Usage: npx tsx scripts/audit-spr-rescore-impact.ts [--out=.omc/reports] [--tag=2026-11-07]

import { createClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

for (const l of readFileSync(".env.local", "utf-8").split("\n")) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const OUT = process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? ".omc/reports";
const TAG = process.argv.find((a) => a.startsWith("--tag="))?.slice(6) ?? "2026-11-07";

interface QRow {
  id: string;
  module_id: string | null;
  original_question_number: number | null;
  question_type: string | null;
  question_text: string | null;
  choices: unknown;
  correct_answer: string | null;
  official_answer: string | null;
  explanation: string | null;
  parsing_status: string | null;
  section: string | null;
}
interface ARow {
  id: string;
  submission_id: string;
  question_id: string;
  student_answer: string | null;
  correct_answer: string | null;
  is_correct: boolean | null;
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const { fetchAllRows } = await import("../lib/fetch-all-rows");
  const { isQaEmail } = await import("../lib/qa");
  const { analyzeKeyRow } = await import("../lib/key-check");
  const { answersMatch } = await import("../lib/grade-submission");
  const { scoreFromRecords } = await import("../lib/rescore");
  const { liveQuestionIds } = await import("../lib/live-questions");
  const { SPR_TYPE, keyCandidates, impliedExactValue, sprInputMaxChars, sprValue, normalizeKeyText, acceptedAnswersText } =
    await import("../lib/answer-key");

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Questions ──
  const { data: qs, error: qErr } = await fetchAllRows<QRow>((from, to) =>
    db
      .from("questions")
      .select("id, module_id, original_question_number, question_type, question_text, choices, correct_answer, official_answer, explanation, parsing_status, section")
      .eq("question_type", SPR_TYPE)
      .order("id")
      .range(from, to),
  );
  if (qErr) throw new Error(`questions: ${JSON.stringify(qErr)}`);
  const qById = new Map(qs.map((q) => [q.id, q]));
  const moduleIds = [...new Set(qs.map((q) => q.module_id).filter(Boolean))] as string[];
  const moduleName = new Map<string, string>();
  for (let i = 0; i < moduleIds.length; i += 200) {
    const { data } = await db.from("modules").select("id, module_name").in("id", moduleIds.slice(i, i + 200));
    for (const m of data ?? []) moduleName.set(m.id as string, m.module_name as string);
  }
  const live = await liveQuestionIds(db, qs.filter((q) => q.parsing_status === "Approved").map((q) => q.id));
  const qLabel = (q: QRow | undefined) =>
    q ? `${(q.module_id && moduleName.get(q.module_id)) || "?"} Q${q.original_question_number ?? "?"}` : "(deleted question)";

  // ── (a) Key problems ──
  type KeyIssue = { q: QRow; kind: string; reason: string; suggestion: string };
  const keyIssues: KeyIssue[] = [];
  for (const q of qs) {
    if (q.parsing_status === "Rejected") continue;
    const f = analyzeKeyRow(q);
    if (f) {
      const s = f.suggestion;
      const sug = s
        ? [s.correct_answer ? `key → ${s.correct_answer}` : null, s.question_type ? `type → ${s.question_type}` : null, s.clear_choices ? "remove choices" : null]
            .filter(Boolean)
            .join(", ") + (f.suggestionWhy ? ` (${f.suggestionWhy})` : "")
        : "(none — needs a person)";
      keyIssues.push({ q, kind: f.code, reason: f.reason, suggestion: sug });
    }
    for (const c of keyCandidates(q.correct_answer)) {
      const implied = impliedExactValue(c);
      const v = sprValue(normalizeKeyText(c));
      const exactAlsoListed = keyCandidates(q.correct_answer).some((o) => {
        const ov = sprValue(normalizeKeyText(o));
        return implied !== null && ov !== null && Math.abs(ov - implied) < 1e-9;
      });
      if (implied !== null && v !== null && Math.abs(implied - v) > 1e-12 && !exactAlsoListed) {
        const frac = (() => {
          for (let d = 2; d <= 100; d++) {
            const n = Math.round(implied * d);
            if (Math.abs(n / d - implied) < 1e-9) return `${n}/${d}`;
          }
          return String(implied);
        })();
        keyIssues.push({
          q,
          kind: "spr-approximate-key",
          reason: `key "${c}" looks like a rounded/truncated ${frac} (grading already credits ${acceptedAnswersText(frac)})`,
          suggestion: `key → ${(q.correct_answer ?? "").replace(c, frac)} (store the exact value)`,
        });
      }
    }
    const maxChars = sprInputMaxChars(q.correct_answer);
    if (maxChars > 6) {
      keyIssues.push({
        q,
        kind: "spr-long-key",
        reason: `key "${q.correct_answer}" is ${maxChars} characters, longer than the official 5 (6 with a minus); the answer box allows ${maxChars} for this question and the exact key is credited`,
        suggestion: "verify the key against the source; keep it if verified",
      });
    }
  }

  // ── (b) Past answer_records ──
  const sprIds = qs.map((q) => q.id);
  const records: ARow[] = [];
  for (let i = 0; i < sprIds.length; i += 100) {
    const chunk = sprIds.slice(i, i + 100);
    const { data, error } = await fetchAllRows<ARow>((from, to) =>
      db
        .from("answer_records")
        .select("id, submission_id, question_id, student_answer, correct_answer, is_correct")
        .in("question_id", chunk)
        .order("id")
        .range(from, to),
    );
    if (error) throw new Error(`answer_records: ${JSON.stringify(error)}`);
    records.push(...data);
  }

  const flips = records
    .map((r) => {
      const q = qById.get(r.question_id);
      const key = r.correct_answer ?? q?.correct_answer ?? null;
      const now = answersMatch(r.student_answer, key, q?.question_text ?? null);
      return { r, q, key, now };
    })
    .filter((x) => x.now !== !!x.r.is_correct);

  const subIds = [...new Set(flips.map((f) => f.r.submission_id))];
  type Sub = { id: string; student_id: string | null; test_id: string | null; status: string | null; correct_count: number | null; total_questions: number | null; scaled_score: number | null; adaptive_track: string | null; submitted_at: string | null };
  const subs = new Map<string, Sub>();
  const subRecords = new Map<string, { id: string; is_correct: boolean | null }[]>();
  for (let i = 0; i < subIds.length; i += 100) {
    const chunk = subIds.slice(i, i + 100);
    const { data } = await db
      .from("submissions")
      .select("id, student_id, test_id, status, correct_count, total_questions, scaled_score, adaptive_track, submitted_at")
      .in("id", chunk);
    for (const s of (data ?? []) as Sub[]) subs.set(s.id, s);
    const { data: recs } = await fetchAllRows<{ id: string; submission_id: string; is_correct: boolean | null }>((from, to) =>
      db.from("answer_records").select("id, submission_id, is_correct").in("submission_id", chunk).order("id").range(from, to),
    );
    for (const r of recs) {
      const arr = subRecords.get(r.submission_id) ?? [];
      arr.push({ id: r.id, is_correct: r.is_correct });
      subRecords.set(r.submission_id, arr);
    }
  }
  const studentIds = [...new Set([...subs.values()].map((s) => s.student_id).filter(Boolean))] as string[];
  const testIds = [...new Set([...subs.values()].map((s) => s.test_id).filter(Boolean))] as string[];
  const users = new Map<string, { display_name: string | null; email: string | null }>();
  for (let i = 0; i < studentIds.length; i += 200) {
    const { data } = await db.from("users").select("id, display_name, email").in("id", studentIds.slice(i, i + 200));
    for (const u of data ?? []) users.set(u.id as string, u as { display_name: string | null; email: string | null });
  }
  const tests = new Map<string, string>();
  for (let i = 0; i < testIds.length; i += 200) {
    const { data } = await db.from("tests").select("id, test_name").in("id", testIds.slice(i, i + 200));
    for (const t of data ?? []) tests.set(t.id as string, (t.test_name as string) ?? "Test");
  }

  // Per-submission old/new score: flip only this submission's changed records.
  const flipIdsBySub = new Map<string, Map<string, boolean>>();
  for (const f of flips) {
    const m = flipIdsBySub.get(f.r.submission_id) ?? new Map<string, boolean>();
    m.set(f.r.id, f.now);
    flipIdsBySub.set(f.r.submission_id, m);
  }
  const subScore = new Map<string, { oldRaw: number; newRaw: number; total: number; oldScaled: number | null; recomputedOldScaled: number | null; newScaled: number | null }>();
  for (const [sid, m] of flipIdsBySub) {
    const recs = subRecords.get(sid) ?? [];
    const oldS = scoreFromRecords(recs);
    const newS = scoreFromRecords(recs.map((r) => (m.has(r.id) ? { is_correct: m.get(r.id)! } : r)));
    subScore.set(sid, {
      oldRaw: oldS?.correctCount ?? 0,
      newRaw: newS?.correctCount ?? 0,
      total: oldS?.total ?? 0,
      oldScaled: subs.get(sid)?.scaled_score ?? null,
      recomputedOldScaled: oldS?.scaledScore ?? null,
      newScaled: newS?.scaledScore ?? null,
    });
  }

  type Row = {
    group: "student" | "qa" | "orphan";
    studentName: string;
    email: string;
    test: string;
    track: string;
    question: string;
    entry: string;
    key: string;
    currentKey: string;
    oldCorrect: boolean;
    newCorrect: boolean;
    submissionId: string;
  };
  const rows: Row[] = flips.map((f) => {
    const sub = subs.get(f.r.submission_id);
    const u = sub?.student_id ? users.get(sub.student_id) : undefined;
    const group: Row["group"] = !sub || !sub.student_id || !u ? "orphan" : isQaEmail(u.email) ? "qa" : "student";
    return {
      group,
      studentName: u?.display_name ?? "",
      email: u?.email ?? "",
      test: (sub?.test_id && tests.get(sub.test_id)) || (sub ? "(deleted test)" : "(deleted submission)"),
      track: sub?.adaptive_track ?? "",
      question: qLabel(f.q),
      entry: f.r.student_answer ?? "",
      key: f.key ?? "",
      currentKey: f.q?.correct_answer ?? "",
      oldCorrect: !!f.r.is_correct,
      newCorrect: f.now,
      submissionId: f.r.submission_id,
    };
  });
  rows.sort((a, b) => a.group.localeCompare(b.group) || a.email.localeCompare(b.email) || a.test.localeCompare(b.test) || a.question.localeCompare(b.question));
  const real = rows.filter((r) => r.group === "student");
  const orphans = rows.filter((r) => r.group === "orphan");
  const qaCount = rows.filter((r) => r.group === "qa").length;

  // ── Write CSV + Markdown ──
  mkdirSync(OUT, { recursive: true });
  const header = ["group", "student_name", "email", "test", "module_track", "question", "entry", "graded_key", "current_key", "old_is_correct", "new_is_correct", "submission_id", "old_raw", "new_raw", "total", "old_scaled_stored", "old_scaled_recomputed", "new_scaled"];
  const csv = [header.join(",")];
  for (const r of [...real, ...orphans]) {
    const s = subScore.get(r.submissionId);
    csv.push(
      [r.group, r.studentName, r.email, r.test, r.track, r.question, r.entry, r.key, r.currentKey, r.oldCorrect, r.newCorrect, r.submissionId, s?.oldRaw, s?.newRaw, s?.total, s?.oldScaled, s?.recomputedOldScaled, s?.newScaled]
        .map(csvCell)
        .join(","),
    );
  }
  const csvPath = join(OUT, `spr-rescore-impact-${TAG}.csv`);
  writeFileSync(csvPath, csv.join("\n") + "\n");

  const realSubs = [...new Set(real.map((r) => r.submissionId))];
  const realStudents = new Set(real.map((r) => r.email));
  const gains = real.filter((r) => r.newCorrect).length;
  const losses = real.filter((r) => !r.newCorrect).length;
  const deltas = realSubs.map((sid) => {
    const s = subScore.get(sid)!;
    return { sid, raw: s.newRaw - s.oldRaw, scaled: (s.newScaled ?? 0) - (s.recomputedOldScaled ?? 0) };
  });
  const byKind: Record<string, number> = {};
  for (const k of keyIssues) byKind[k.kind] = (byKind[k.kind] ?? 0) + 1;
  // Entry patterns that flip (why).
  const why = (r: Row) => {
    const e = r.entry.trim();
    if (/,/.test(e)) return "comma in entry";
    if (/\d\s+\d+\s*\/\s*\d/.test(e)) return "mixed number";
    if (/[%$]/.test(e)) return "% or $";
    if (/[a-z]/i.test(e)) return "units or letters in the entry";
    if (!r.newCorrect && /^-?[\d./]+$/.test(e) && e.replace(/^-/, "").length > 5) {
      return "approximation longer than 5 characters (the old box allowed 12 and a 0.0001 tolerance credited it)";
    }
    if (!r.newCorrect && /^-?\d*\.\d+$/.test(e)) return "approximation that doesn't fill the space (or isn't truncation/rounding)";
    if (r.newCorrect) return "credited under the new rules (fill-the-space / rounding / approximate key)";
    return "other";
  };
  const whyCount: Record<string, number> = {};
  for (const r of real) whyCount[why(r)] = (whyCount[why(r)] ?? 0) + 1;

  const md: string[] = [];
  md.push(`# SPR official-rules rescore impact — ${TAG}`, "");
  md.push("READ-ONLY. Nothing was rescored or written. Grading of NEW submits follows the new rules once deployed; past scores stay as they are unless someone runs a rescore.", "");
  md.push("## Summary", "");
  md.push(`- Fill-in (SPR) questions scanned: ${qs.length}`);
  md.push(`- Past answer records on fill-in questions: ${records.length}`);
  md.push(`- Records whose correctness would change (real students): ${real.length} (${gains} wrong→right, ${losses} right→wrong)`);
  md.push(`- Attempts (submissions) affected: ${realSubs.length}; students affected: ${realStudents.size}`);
  md.push(`- Raw-score deltas per attempt: ${deltas.length ? deltas.map((d) => (d.raw > 0 ? `+${d.raw}` : `${d.raw}`)).join(", ") : "none"}`);
  md.push(`- Scaled-score deltas per attempt (module scale): ${deltas.length ? deltas.map((d) => (d.scaled > 0 ? `+${d.scaled}` : `${d.scaled}`)).join(", ") : "none"}`);
  md.push(`- QA-user records excluded: ${qaCount}; orphan records (student/submission deleted): ${orphans.length}`);
  md.push("");
  if (Object.keys(whyCount).length) {
    md.push("### Why entries change", "");
    for (const [k, n] of Object.entries(whyCount)) md.push(`- ${k}: ${n}`);
    md.push("");
  }
  md.push("## (b) Affected attempts (real students)", "");
  if (real.length === 0) md.push("None.", "");
  else {
    md.push("| Student | Email | Test | Question | Entry | Key | Old → New | Raw old→new | Scaled old→new |", "|---|---|---|---|---|---|---|---|---|");
    for (const r of real) {
      const s = subScore.get(r.submissionId)!;
      md.push(`| ${r.studentName} | ${r.email} | ${r.test}${r.track ? ` (${r.track})` : ""} | ${r.question} | \`${r.entry}\` | \`${r.key}\` | ${r.oldCorrect ? "✓" : "✗"} → ${r.newCorrect ? "✓" : "✗"} | ${s.oldRaw}/${s.total} → ${s.newRaw}/${s.total} | ${s.oldScaled ?? "—"} → ${s.newScaled ?? "—"} |`);
    }
    md.push("");
  }
  md.push("## Orphan records (student or submission no longer exists)", "");
  if (orphans.length === 0) md.push("None.", "");
  else {
    md.push("| Submission | Test | Question | Entry | Key | Old → New |", "|---|---|---|---|---|---|");
    for (const r of orphans) md.push(`| ${r.submissionId} | ${r.test} | ${r.question} | \`${r.entry}\` | \`${r.key}\` | ${r.oldCorrect ? "✓" : "✗"} → ${r.newCorrect ? "✓" : "✗"} |`);
    md.push("");
  }
  md.push("## (a) Fill-in keys to look at", "");
  md.push(Object.entries(byKind).map(([k, n]) => `- ${k}: ${n}`).join("\n") || "None.", "");
  if (keyIssues.length) {
    md.push("| Question | Status | Live | Key | Problem | Suggested fix |", "|---|---|---|---|---|---|");
    for (const k of keyIssues.sort((a, b) => Number(live.has(b.q.id)) - Number(live.has(a.q.id)) || qLabel(a.q).localeCompare(qLabel(b.q)))) {
      md.push(`| ${qLabel(k.q)} | ${k.q.parsing_status} | ${live.has(k.q.id) ? "yes" : ""} | \`${k.q.correct_answer ?? ""}\` | ${k.kind}: ${k.reason.replace(/\|/g, "/")} | ${k.suggestion.replace(/\|/g, "/")} |`);
    }
    md.push("");
  }
  const mdPath = join(OUT, `spr-rescore-impact-${TAG}.md`);
  writeFileSync(mdPath, md.join("\n"));
  console.log(md.slice(0, 16).join("\n"));
  console.log(`\nwrote ${csvPath} and ${mdPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
