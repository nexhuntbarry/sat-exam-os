// scripts/audit-graph-choices.ts
//
// Graph-choice audit (lib/figure-compare.ts auditGraphChoices): every question
// whose answer choices are images is checked for a wrong choice count, a
// choice without an image, blank crops, ink touching the crop border (cut
// off) and — with --vision — crops that contain another question.
//
//   node --env-file=.env.local --import tsx scripts/audit-graph-choices.ts            # report only
//   node --env-file=.env.local --import tsx scripts/audit-graph-choices.ts --vision   # + Claude vision check
//   node --env-file=.env.local --import tsx scripts/audit-graph-choices.ts --flag     # non-live rows with problems → Needs Review (backs up first)
//
// Live-test rows are never demoted: they're only listed (fix the crop by hand,
// keep Approved, tag [live-fix]). Writes .omc/reports/graph-choice-audit-<date>.json.
import { mkdirSync, writeFileSync } from "fs";
import { getServiceClient } from "@/lib/supabase";
import { choiceImageUrls } from "@/lib/parse-guards";
import { liveQuestionIds } from "@/lib/live-questions";
import { auditGraphChoices, type GraphChoiceAudit } from "@/lib/figure-compare";

const VISION = process.argv.includes("--vision");
const FLAG = process.argv.includes("--flag");
const DATE = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const GRAPH_CHOICE_NOTE = "Needs review: graph-choice audit";

interface Row {
  id: string;
  module_id: string | null;
  original_question_number: number | null;
  choices: unknown;
  parsing_status: string | null;
  parsing_notes: string | null;
  updated_at: string | null;
}

async function main() {
  const db = getServiceClient();
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("questions")
      .select("id, module_id, original_question_number, choices, parsing_status, parsing_notes, updated_at")
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  const targets = rows.filter((r) => choiceImageUrls(r.choices).length > 0);
  const live = await liveQuestionIds(db, targets.map((t) => t.id));
  const { data: mods } = await db.from("modules").select("id, module_name");
  const modName = new Map((mods ?? []).map((m) => [m.id as string, m.module_name as string]));

  const out: (GraphChoiceAudit & { id: string; module: string; number: number | null; status: string | null; live: boolean; action: string })[] = [];
  for (const r of targets) {
    const a = await auditGraphChoices(r, { vision: VISION });
    let action = a.problems.length ? "listed" : "ok";
    if (FLAG && a.problems.length && !live.has(r.id) && r.parsing_status !== "Needs Review") {
      mkdirSync(".omc/backups", { recursive: true });
      writeFileSync(`.omc/backups/graph-choice-audit-${r.id}.json`, JSON.stringify(r, null, 1));
      const note = `${GRAPH_CHOICE_NOTE} (${DATE}): ${a.problems.join("; ")} — re-crop the choice images from the PDF`;
      let q = db
        .from("questions")
        .update({ parsing_status: "Needs Review", parsing_notes: r.parsing_notes ? `${r.parsing_notes}; ${note}` : note, updated_at: new Date().toISOString() })
        .eq("id", r.id);
      if (r.updated_at) q = q.eq("updated_at", r.updated_at);
      const { data, error } = await q.select("id");
      action = error || !data?.length ? `flag failed: ${error?.message ?? "row changed"}` : "→ Needs Review";
    }
    const o = { id: r.id, module: modName.get(r.module_id ?? "") ?? "?", number: r.original_question_number, status: r.parsing_status, live: live.has(r.id), action, ...a };
    out.push(o);
    console.log(`${o.module} Q${o.number} ${o.status}${o.live ? " LIVE" : ""} — ${o.problems.join("; ") || "ok"} [${action}]`);
  }
  const summary = { checked: out.length, withProblems: out.filter((o) => o.problems.length).length, live: out.filter((o) => o.live).length };
  console.log(summary);
  mkdirSync(".omc/reports", { recursive: true });
  const file = `.omc/reports/graph-choice-audit-${DATE}.json`;
  writeFileSync(file, JSON.stringify({ vision: VISION, flag: FLAG, summary, outcomes: out }, null, 1));
  console.log(`report: ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
