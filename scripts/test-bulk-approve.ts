// scripts/test-bulk-approve.ts
//
// Bulk Approve must never pull a live question out of a running exam
// (review H1). Pure checks of planBulkApprove, then a read-only check
// against a real live Approved question with its key swapped for a bad one
// IN MEMORY — no row is written.
//
//   set -a; source <(grep -E '^[A-Z_]+=' .env.local); set +a
//   npx tsx scripts/test-bulk-approve.ts
import { createClient } from "@supabase/supabase-js";
import { BULK_APPROVE_STATUSES, planBulkApprove, type BulkApproveRow } from "../lib/bulk-approve";
import { liveQuestionIds, LIVE_FIX_TAG } from "../lib/live-questions";

// In published test a58f0bb8… with a class assigned (same as test-live-guard).
const LIVE_ID = "fa61d7b3-3cf6-4169-8d7a-3d5b3dd86957";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

const now = new Date().toISOString();
const spr = (over: Partial<BulkApproveRow>): BulkApproveRow => ({
  id: "x",
  question_text: "What is the value of x?",
  choices: [],
  question_type: "Student Produced Response",
  correct_answer: "C", // letter key on a fill-in question = blocker
  parsing_status: "Needs Review",
  parsing_notes: null,
  ...over,
});

async function main() {
  // ── Pure planning ──────────────────────────────────────────────────
  {
    const live = new Set(["live-approved"]);
    const plan = planBulkApprove(
      [
        spr({ id: "live-approved", parsing_status: "Approved" }),
        spr({ id: "approved", parsing_status: "Approved" }),
        spr({ id: "rejected", parsing_status: "Rejected" }),
        spr({ id: "draft-bad", parsing_status: "Draft" }),
        spr({ id: "nr-good", correct_answer: "12" }),
      ],
      live,
      now,
    );
    check("Approved (live and not live) and Rejected rows are skipped", JSON.stringify(plan.skipped) === JSON.stringify(["live-approved", "approved", "rejected"]), plan.skipped);
    check("no hold is written for an Approved row", !plan.holds.some((h) => h.id === "live-approved" || h.id === "approved"));
    check("Draft with a bad key is held in Needs Review", plan.holds.length === 1 && plan.holds[0].id === "draft-bad" && plan.holds[0].update.parsing_status === "Needs Review", plan.holds);
    check("good Needs Review row is approved", JSON.stringify(plan.clean) === JSON.stringify(["nr-good"]));
  }
  {
    // Re-running doesn't stack the same note.
    const first = planBulkApprove([spr({ id: "a" })], new Set(), now).holds[0].update.parsing_notes as string;
    const second = planBulkApprove([spr({ id: "a", parsing_notes: first })], new Set(), now).holds[0].update.parsing_notes as string;
    check("same key-check note isn't appended twice", first === second, { first, second });
  }
  check("only Draft / Needs Review are in scope", JSON.stringify(BULK_APPROVE_STATUSES) === JSON.stringify(["Draft", "Needs Review"]));

  // ── Real live question (read-only) ────────────────────────────────
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: row, error } = await db
    .from("questions")
    .select("id, question_text, choices, question_type, correct_answer, parsing_status, parsing_notes")
    .eq("id", LIVE_ID)
    .maybeSingle();
  if (error || !row) {
    check("live fixture row readable", false, error?.message ?? "not found");
  } else {
    check("fixture is Approved", row.parsing_status === "Approved", row.parsing_status);
    const live = await liveQuestionIds(db, [LIVE_ID]);
    check("fixture is in a live test", live.has(LIVE_ID));

    // The route's question_ids select only returns Draft / Needs Review.
    const { data: selected } = await db
      .from("questions")
      .select("id")
      .in("id", [LIVE_ID])
      .in("parsing_status", [...BULK_APPROVE_STATUSES]);
    check("question_ids select excludes the live Approved row", (selected ?? []).length === 0, selected);

    // Even if it reached planning (filter path, race), a bad key leaves it alone.
    const badKey: BulkApproveRow = {
      ...(row as BulkApproveRow),
      question_type: "Student Produced Response",
      choices: [],
      correct_answer: "C",
    };
    const plan = planBulkApprove([badKey], live, now);
    check("live Approved row with a bad key: skipped, not approved, not held", plan.skipped[0] === LIVE_ID && plan.clean.length === 0 && plan.holds.length === 0, plan);

    // Nothing was written: the row is unchanged.
    const { data: after } = await db.from("questions").select("parsing_status, correct_answer, parsing_notes").eq("id", LIVE_ID).maybeSingle();
    check(
      "live row still Approved and unchanged",
      after?.parsing_status === "Approved" && after?.correct_answer === row.correct_answer && after?.parsing_notes === row.parsing_notes,
      after,
    );
    check("no new [live-fix] tag was written", (after?.parsing_notes ?? "").startsWith(LIVE_FIX_TAG) === (row.parsing_notes ?? "").startsWith(LIVE_FIX_TAG));
  }

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
