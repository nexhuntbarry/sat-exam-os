import { getServiceClient } from "@/lib/supabase";
import type { AnswerRow, Occasion } from "@/lib/score-analysis";

// Every graded answer for a student, flattened for the strengths/weaknesses
// breakdown (is_correct + the question's section/domain/skill).
export async function getStudentBreakdownRows(studentId: string): Promise<AnswerRow[]> {
  const db = getServiceClient();
  const { data: subs } = await db
    .from("submissions")
    .select("id")
    .eq("student_id", studentId)
    .in("status", ["Submitted", "Late"]);
  const ids = (subs ?? []).map((s) => s.id);
  if (ids.length === 0) return [];
  const { data } = await db
    .from("answer_records")
    .select("is_correct, questions!inner(section, domain, skill)")
    .in("submission_id", ids);
  return ((data ?? []) as unknown as {
    is_correct: boolean;
    questions: { section: string | null; domain: string | null; skill: string | null };
  }[]).map((r) => ({
    is_correct: r.is_correct,
    section: r.questions?.section ?? null,
    domain: r.questions?.domain ?? null,
    skill: r.questions?.skill ?? null,
  }));
}

// One "occasion" per test attempt (adaptive sessions grouped into one), each
// with its date + answer rows, for the progress-over-time trend.
export async function getStudentProgressOccasions(studentId: string): Promise<Occasion[]> {
  const db = getServiceClient();
  const { data: subs } = await db
    .from("submissions")
    .select("id, session_id, submitted_at, tests!inner(test_name)")
    .eq("student_id", studentId)
    .in("status", ["Submitted", "Late"]);
  const rows = (subs ?? []) as unknown as {
    id: string;
    session_id: string | null;
    submitted_at: string | null;
    tests: { test_name: string };
  }[];
  if (rows.length === 0) return [];

  const { data: recs } = await db
    .from("answer_records")
    .select("submission_id, is_correct, questions!inner(section, domain, skill)")
    .in("submission_id", rows.map((r) => r.id));
  const bySub = new Map<string, AnswerRow[]>();
  for (const r of (recs ?? []) as unknown as {
    submission_id: string;
    is_correct: boolean;
    questions: { section: string | null; domain: string | null; skill: string | null };
  }[]) {
    const arr = bySub.get(r.submission_id) ?? [];
    arr.push({ is_correct: r.is_correct, section: r.questions?.section ?? null, domain: r.questions?.domain ?? null, skill: r.questions?.skill ?? null });
    bySub.set(r.submission_id, arr);
  }

  const occMap = new Map<string, Occasion>();
  for (const r of rows) {
    const key = r.session_id ?? r.id;
    let occ = occMap.get(key);
    if (!occ) {
      occ = { date: r.submitted_at ?? "", label: r.tests.test_name, rows: [] };
      occMap.set(key, occ);
    }
    if (r.submitted_at && r.submitted_at > occ.date) occ.date = r.submitted_at;
    occ.rows.push(...(bySub.get(r.id) ?? []));
  }
  return [...occMap.values()].filter((o) => o.rows.length > 0);
}
