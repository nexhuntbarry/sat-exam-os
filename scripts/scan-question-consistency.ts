import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const t = readFileSync(".env.local", "utf-8");
for (const l of t.split("\n")) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, ""); }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
const APPLY = process.argv.includes("--apply");

type Choice = { label: string; text: string };
type Row = {
  id: string; module_id: string; original_question_number: number | null;
  question_type: string | null; choices: unknown; correct_answer: string | null;
  parsing_status: string; parsing_notes: string | null;
  modules: { module_name: string } | null;
};

const ansNumeric = (a: string) => /^-?(\d+(\.\d+)?|\d*\.?\d+\/\d+|\d+\/\d+|\.\d+)$/.test(a.trim());
const ansLabel = (a: string) => /^[A-D]$/i.test(a.trim());

async function main() {
  // Pull every non-rejected question.
  const PAGE = 1000;
  let from = 0;
  const rows: Row[] = [];
  for (;;) {
    const { data } = await db
      .from("questions")
      .select("id, module_id, original_question_number, question_type, choices, correct_answer, parsing_status, parsing_notes, modules(module_name)")
      .neq("parsing_status", "Rejected")
      .range(from, from + PAGE - 1);
    const batch = (data ?? []) as unknown as Row[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  console.log(`Scanned ${rows.length} questions.\n`);

  const buckets: Record<string, Row[]> = {
    AUTOFIX_spr_with_spurious_choices: [],
    FLAG_spr_but_answer_is_label: [],
    FLAG_mc_missing_choices: [],
    FLAG_mc_too_many_choices: [],
    FLAG_mc_answer_not_a_label: [],
    FLAG_mc_answer_label_absent: [],
    FLAG_spr_answer_is_label: [],
  };

  for (const q of rows) {
    const type = q.question_type ?? "";
    const isMC = type === "Multiple Choice";
    const isSPR = type === "Student Produced Response";
    const ch = Array.isArray(q.choices) ? (q.choices as Choice[]) : [];
    const nCh = ch.length;
    const ans = (q.correct_answer ?? "").trim();

    if (isSPR && nCh > 0) {
      // SPR must have NO choices. If the stored answer is numeric/griddable,
      // the choices are spurious (the Q18 case) → safe to clear.
      if (ans && ansNumeric(ans)) buckets.AUTOFIX_spr_with_spurious_choices.push(q);
      else buckets.FLAG_spr_but_answer_is_label.push(q); // likely MC mislabeled
      continue;
    }
    if (isMC) {
      if (nCh > 0 && nCh < 4) { buckets.FLAG_mc_missing_choices.push(q); continue; }
      if (nCh > 4) { buckets.FLAG_mc_too_many_choices.push(q); continue; }
      if (nCh === 0) { buckets.FLAG_mc_missing_choices.push(q); continue; }
      if (ans && !ansLabel(ans)) { buckets.FLAG_mc_answer_not_a_label.push(q); continue; }
      if (ans && ansLabel(ans) && !ch.some((c) => (c.label ?? "").toUpperCase() === ans.toUpperCase())) {
        buckets.FLAG_mc_answer_label_absent.push(q); continue;
      }
    }
    if (isSPR && nCh === 0 && ans && ansLabel(ans)) buckets.FLAG_spr_answer_is_label.push(q);
  }

  // Report
  let total = 0;
  for (const [k, list] of Object.entries(buckets)) {
    total += list.length;
    console.log(`${k}: ${list.length}`);
    for (const q of list.slice(0, 4)) {
      console.log(`   ${(q.modules?.module_name ?? "?").slice(0, 42)} Q${q.original_question_number} [${q.parsing_status}] ans=${q.correct_answer} type=${q.question_type} nCh=${Array.isArray(q.choices) ? (q.choices as []).length : 0}`);
    }
  }
  console.log(`\nTOTAL flagged/fixable: ${total}`);

  if (!APPLY) { console.log("\n(dry run — pass --apply to clear spurious SPR choices and flag the rest for review)"); return; }

  // Apply
  let fixed = 0, flagged = 0;
  for (const q of buckets.AUTOFIX_spr_with_spurious_choices) {
    const note = appendNote(q.parsing_notes, "Auto-fix: removed spurious multiple-choice options from a Student Produced Response question.");
    await db.from("questions").update({ choices: [], parsing_notes: note, updated_at: new Date().toISOString() }).eq("id", q.id);
    fixed++;
  }
  const flagLists: [string, Row[]][] = [
    ["Needs review: SPR question has a letter answer — may actually be multiple choice.", buckets.FLAG_spr_but_answer_is_label],
    ["Needs review: multiple-choice question is missing answer choices (should have 4).", buckets.FLAG_mc_missing_choices],
    ["Needs review: multiple-choice question has more than 4 options.", buckets.FLAG_mc_too_many_choices],
    ["Needs review: multiple-choice answer is not a letter (A–D).", buckets.FLAG_mc_answer_not_a_label],
    ["Needs review: the marked answer letter is not among the choices.", buckets.FLAG_mc_answer_label_absent],
    ["Needs review: fill-in (SPR) answer looks like a leftover choice letter.", buckets.FLAG_spr_answer_is_label],
  ];
  for (const [msg, list] of flagLists) {
    for (const q of list) {
      // Only downgrade if currently Approved/Draft (don't touch Rejected; already excluded).
      await db.from("questions").update({
        parsing_status: "Needs Review",
        parsing_notes: appendNote(q.parsing_notes, msg),
        updated_at: new Date().toISOString(),
      }).eq("id", q.id);
      flagged++;
    }
  }
  console.log(`\nAPPLIED. auto-fixed(cleared choices)=${fixed}, flagged-for-review=${flagged}`);
}

function appendNote(existing: string | null, add: string): string {
  const base = (existing ?? "").trim();
  if (base.includes(add)) return base;
  return base ? `${base}; ${add}` : add;
}

main();
