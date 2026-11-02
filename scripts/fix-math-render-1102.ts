// One-off 2026-11-02: repair the 12 Approved questions where students would
// see raw LaTeX (found by scripts/scan-math-render.ts). Formatting only:
// answers untouched, status stays Approved, live-test questions tagged.
import { getServiceClient } from "@/lib/supabase";
import { problems } from "./scan-math-render";
import { liveQuestionIds, LIVE_FIX_TAG } from "@/lib/live-questions";

const IDS = ["49c46dd9", "8358cc63", "34d238ff", "26581c32", "578e6a85", "b88386e1", "2343f7e8", "4364bd4b", "c9f310b5", "396890df", "3966655b", "78d69a87"];
const DRY = process.argv.includes("--dry");

function fix(s: string | null): string | null {
  if (!s || problems(s).length === 0) return s; // only fields that render wrong
  let t = s;
  t = t.replace(/\\ \\\$/g, "\\$"); // "\ \$13" → "\$13"
  t = t.replace(/\\ \$(?=\d)/g, "\\$"); // "\ $13" → "\$13"
  // Whole-string math that opens with an escaped/bare "$" + number: "\$14(x+4) \geq ...$"
  const m = t.trim().match(/^\\?\$(\d[\d,.]*)([\s\S]*)\$$/);
  if (m && !m[2].includes("$") && /[a-z\\=<>(]/i.test(m[2])) t = `\${${m[1]}}${m[2]}$`;
  t = t.replace(/\(\\\$(\d+)([a-z][^$]*?)\\\$\)/g, (_x, n, rest) => `($\{${n}}${rest}$)`); // "(\$720y^{2}\$)"
  t = t.replace(/\\n(?=\\n|[A-Z]|\s|$)/g, "\n"); // literal "\n"
  return t;
}

async function main() {
  const db = getServiceClient();
  let all: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await db.from("questions").select("id, question_text, choices, explanation, correct_answer, parsing_status, parsing_notes").eq("parsing_status", "Approved").range(f, f + 999);
    all = all.concat(data ?? []);
    if ((data ?? []).length < 1000) break;
  }
  const rows = IDS.map((p) => all.find((q) => q.id.startsWith(p))!);
  const live = await liveQuestionIds(db, rows.map((r) => r.id));
  for (const q of rows) {
    const update: Record<string, unknown> = {};
    const stem = fix(q.question_text);
    if (stem !== q.question_text) update.question_text = stem;
    const choices = (q.choices ?? []).map((c: { label: string; text: string }) => ({ ...c, text: fix(c.text) }));
    if (JSON.stringify(choices) !== JSON.stringify(q.choices)) update.choices = choices;
    const expl = fix(q.explanation);
    if (expl !== q.explanation) update.explanation = expl;
    const left = [...problems((update.question_text as string) ?? q.question_text ?? ""), ...choices.flatMap((c: { text: string }) => problems(c.text ?? "")), ...problems((update.explanation as string) ?? q.explanation ?? "")];
    const isLive = live.has(q.id);
    for (const k of Object.keys(update)) console.log("   ", k, JSON.stringify(k === "choices" ? choices.filter((c: { text: string }, i: number) => c.text !== q.choices[i].text).map((c: { text: string }) => c.text) : (update[k] as string)).slice(0, 220));
    console.log(q.id.slice(0, 8), isLive ? "LIVE" : "", "fields:", Object.keys(update).join(",") || "none", left.length ? `STILL: ${left.join(" | ").slice(0, 200)}` : "clean");
    if (DRY || left.length || !Object.keys(update).length) continue;
    const note = `Formatting fix 2026-11-02: raw LaTeX/currency markup repaired so math displays (answer unchanged).`;
    update.parsing_notes = `${isLive ? `${LIVE_FIX_TAG} Math formatting repaired while this question is in a live test; kept Approved — please re-check. ` : ""}${note}\n${q.parsing_notes ?? ""}`;
    update.updated_at = new Date().toISOString();
    const { error } = await db.from("questions").update(update).eq("id", q.id).eq("parsing_status", "Approved");
    if (error) throw error;
  }
}
main();
