// scripts/auto-fix-explanations.ts
//
// One-off: fix explanation-only problems across Needs Review + Approved
// questions (lib/explanation-autofix.ts) — cut-off explanations, broken
// formatting, explanations arguing a different choice than the official key.
// Regenerates from the saved key; saves only when the new explanation is
// complete, supports the key and the AI's own answer agrees. Needs Review
// rows whose only problem was the explanation are Approved.
//
//   node --env-file=.env.local --import tsx scripts/auto-fix-explanations.ts            # dry run (AI calls, no writes)
//   node --env-file=.env.local --import tsx scripts/auto-fix-explanations.ts --apply    # writes (backs up rows first)
//   options: --concurrency=4  --limit=N  --ids=<uuid,uuid>
//
// Writes .omc/reports/auto-fix-explanations-<date>.md (+ .json with every outcome),
// and on --apply a backup of every target row to .omc/backups/.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { getServiceClient } from "@/lib/supabase";
import {
  autoFixExplanations,
  explanationTargetReasons,
  loadAutoFixRows,
  summarize,
  targetGroup,
  type AutoFixGroup,
  type AutoFixOutcome,
} from "@/lib/explanation-autofix";

const APPLY = process.argv.includes("--apply");
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const CONCURRENCY = Number(arg("concurrency") ?? 4);
const LIMIT = arg("limit") ? Number(arg("limit")) : Infinity;
const IDS = arg("ids")?.split(",").filter(Boolean);
const DATE = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const REPORT = `.omc/reports/auto-fix-explanations-${DATE}.md`;
const DRY_JSON = `.omc/reports/auto-fix-explanations-${DATE}.dry-run.json`;
const APPLY_JSON = `.omc/reports/auto-fix-explanations-${DATE}.apply.json`;

const GROUP_LABEL: Record<AutoFixGroup, string> = {
  fixed_approved: "Fixed + approved (Needs Review → Approved)",
  fixed_kept_approved: "Fixed (kept Approved)",
  fixed_still_review: "Fixed, still in review for other reasons",
  fixed_live_held: "Fixed, would be approved but in a live test (status kept, [live-fix])",
  disagree: "AI answer differs from the key → person (regenDisagreeNote)",
  still_cut_off: "Still cut off after retry (left as-is)",
  unverified: "AI gave no independent answer (left as-is)",
  draft_rejected: "New explanation failed a check (left as-is)",
  failed: "AI call failed (left as-is)",
  skipped: "Skipped (row changed meanwhile / write failed)",
};
const ORDER = Object.keys(GROUP_LABEL) as AutoFixGroup[];

async function main() {
  const db = getServiceClient();
  mkdirSync(".omc/reports", { recursive: true });
  mkdirSync(".omc/backups", { recursive: true });

  let rows = await loadAutoFixRows(db);
  if (IDS) rows = rows.filter((r) => IDS.includes(r.id));
  const targets = rows.filter((r) => explanationTargetReasons(r)).slice(0, LIMIT);
  const byTarget: Record<string, number> = {};
  for (const r of targets) {
    const k = `${r.parsing_status} / ${targetGroup(explanationTargetReasons(r)!)}`;
    byTarget[k] = (byTarget[k] ?? 0) + 1;
  }
  console.log(`${APPLY ? "APPLY" : "DRY RUN"}: ${targets.length} targets of ${rows.length} Needs Review + Approved rows`);
  console.log(byTarget);

  const { data: mods } = await db.from("modules").select("id, module_name");
  const moduleName = new Map((mods ?? []).map((m) => [m.id as string, m.module_name as string]));

  if (APPLY) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backup: unknown[] = [];
    const ids = targets.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await db.from("questions").select("*").in("id", ids.slice(i, i + 200));
      if (error) throw new Error(`backup: ${error.message}`);
      backup.push(...(data ?? []));
    }
    if (backup.length !== ids.length) throw new Error(`backup has ${backup.length} rows, expected ${ids.length}`);
    const path = `.omc/backups/auto-fix-explanations-${ts}.json`;
    writeFileSync(path, JSON.stringify(backup, null, 1));
    console.log(`backup: ${path} (${backup.length} rows)`);
  }

  const t0 = Date.now();
  const outcomes = await autoFixExplanations(db, targets, {
    apply: APPLY,
    concurrency: CONCURRENCY,
    usageRoute: "auto-fix-explanations-script",
    onOutcome: (o, done, total) =>
      console.log(`[${done}/${total}] ${o.group.padEnd(20)} ${o.id.slice(0, 8)} ${moduleName.get(o.module_id ?? "") ?? "?"} Q${o.number} (${o.target})${o.detail ? ` — ${o.detail}` : ""}`),
  });
  const s = summarize(outcomes);
  writeFileSync(APPLY ? APPLY_JSON : DRY_JSON, JSON.stringify(outcomes, null, 1));

  // ── Report ──
  const dry: AutoFixOutcome[] | null = APPLY && existsSync(DRY_JSON) ? JSON.parse(readFileSync(DRY_JSON, "utf-8")) : null;
  const ds = dry ? summarize(dry) : null;
  const lines: string[] = [];
  const label = (o: AutoFixOutcome) => `${moduleName.get(o.module_id ?? "") ?? o.module_id} Q${o.number} (\`${o.id}\`)`;
  lines.push(`# Explanation auto-fix — ${DATE} (${APPLY ? "APPLIED to prod" : "dry run, nothing written"})`, "");
  lines.push(`Targets: ${targets.length} (of ${rows.length} Needs Review + Approved rows). Concurrency ${CONCURRENCY}. Took ${Math.round((Date.now() - t0) / 1000)}s.`, "");
  lines.push("Targets by status / problem:", "");
  for (const [k, v] of Object.entries(byTarget)) lines.push(`- ${k}: ${v}`);
  lines.push("", "## Outcome per group", "", `| Group | ${APPLY ? "Apply" : "Dry run"}${ds ? " | Dry run" : ""} |`, `|---|---:${ds ? "|---:" : ""}|`);
  for (const g of ORDER) if (s[g] || ds?.[g]) lines.push(`| ${GROUP_LABEL[g]} | ${s[g] ?? 0}${ds ? ` | ${ds[g] ?? 0}` : ""} |`);
  if (ds) lines.push("", "_Dry run and apply call the AI separately, so a few rows can land in different groups._");

  const still = outcomes.filter((o) => o.group === "fixed_still_review");
  if (still.length) {
    const tally = new Map<string, number>();
    for (const o of still) for (const b of o.blockers) tally.set(b.slice(0, 110), (tally.get(b.slice(0, 110)) ?? 0) + 1);
    lines.push("", "## Fixed but still in review — other reasons", "", "| Reason | Rows |", "|---|---:|");
    for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) lines.push(`| ${k.replace(/\|/g, "\\|")} | ${v} |`);
    lines.push("", "<details><summary>Rows</summary>", "");
    for (const o of still) lines.push(`- ${label(o)}: ${o.blockers.join("; ")}`);
    lines.push("", "</details>");
  }
  const section = (g: AutoFixGroup, title: string) => {
    const xs = outcomes.filter((o) => o.group === g);
    if (!xs.length) return;
    lines.push("", `## ${title} (${xs.length})`, "");
    for (const o of xs) lines.push(`- ${label(o)} [${o.status_before}→${o.status_after}] key ${o.key}${o.aiAnswer ? `, AI ${o.aiAnswer}` : ""}${o.detail ? ` — ${o.detail}` : ""}`);
  };
  section("disagree", "Disagreements — AI's own answer differs from the key");
  section("still_cut_off", "Still cut off after retry");
  section("draft_rejected", "New explanation rejected");
  section("unverified", "No independent AI answer");
  section("failed", "AI call failed");
  section("skipped", "Skipped");
  section("fixed_live_held", "Live-test rows held");
  section("fixed_approved", "Approved");
  section("fixed_kept_approved", "Kept Approved");
  writeFileSync(REPORT, lines.join("\n") + "\n");

  console.log("\n=== per group ===");
  for (const g of ORDER) if (s[g]) console.log(`${String(s[g]).padStart(4)}  ${GROUP_LABEL[g]}`);
  console.log(`\nreport: ${REPORT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
