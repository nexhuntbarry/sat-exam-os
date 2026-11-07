// scripts/audit-figures.ts
//
// Stem-figure audit (every questions.image_urls crop), the companion of
// scripts/audit-graph-choices.ts. Flags (no writes):
//   - blank crops / ink touching the crop border (pixels, lib/choice-crop-check);
//   - a figure that may run across a page break: the question is the last one
//     on its page and the next page starts with an image before any
//     question-number bar (PDF text layer, figureMayContinue);
//   - with --vision: a question-number box, page header/footer, another
//     question's content, or a visibly cut-off figure (auditStemFigure).
//
//   node --env-file=.env.local --import tsx scripts/audit-figures.ts [--vision] [--ids=a,b] [--concurrency=4]
//
// Writes .omc/reports/figure-audit-<date>.json. Fix / flag by hand after
// looking at each finding (live-test rows: never demote, [live-fix] note).
import { mkdirSync, writeFileSync } from "fs";
import { getServiceClient } from "@/lib/supabase";
import { liveQuestionIds } from "@/lib/live-questions";
import { fetchPdfBase64 } from "@/lib/repair-ops";
import { figureExclusionZones, readPrintoutLayout, type PrintoutLayout, type ExclusionZone } from "@/lib/printout-layout";
import { figureMayContinue } from "@/lib/choice-crop-check";
import { auditStemFigure } from "@/lib/figure-compare";

const VISION = process.argv.includes("--vision");
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const IDS = arg("ids")?.split(",").filter(Boolean);
const CONCURRENCY = Number(arg("concurrency") ?? 4);
const DATE = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

interface Row {
  id: string;
  module_id: string | null;
  original_question_number: number | null;
  page_number: number | null;
  image_urls: string[] | null;
  parsing_status: string | null;
  source_pdf_url: string | null;
}

async function main() {
  const db = getServiceClient();
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from("questions").select("id, module_id, original_question_number, page_number, image_urls, parsing_status, source_pdf_url");
    if (IDS?.length) q = q.in("id", IDS);
    const { data, error } = await q.order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  const targets = rows.filter((r) => Array.isArray(r.image_urls) && r.image_urls.length > 0);
  const live = await liveQuestionIds(db, targets.map((t) => t.id));
  const { data: mods } = await db.from("modules").select("id, module_name, pdf_url");
  const mod = new Map((mods ?? []).map((m) => [m.id as string, m as { module_name: string; pdf_url: string | null }]));

  const layouts = new Map<string, Promise<{ layout: PrintoutLayout; zones: ExclusionZone[] } | null>>();
  const layoutFor = (r: Row) => {
    const url = r.source_pdf_url ?? mod.get(r.module_id ?? "")?.pdf_url ?? null;
    if (!url) return Promise.resolve(null);
    if (!layouts.has(url)) {
      layouts.set(
        url,
        fetchPdfBase64(url)
          .then(readPrintoutLayout)
          .then((layout) => (layout.pages.length ? { layout, zones: figureExclusionZones(layout) } : null))
          .catch(() => null),
      );
    }
    return layouts.get(url)!;
  };

  const out: { id: string; module: string; number: number | null; status: string | null; live: boolean; problems: string[] }[] = [];
  const queue = [...targets];
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const problems: string[] = [];
      try {
        for (const u of r.image_urls ?? []) problems.push(...(await auditStemFigure(u, r.original_question_number, { vision: VISION })).problems);
        const l = await layoutFor(r);
        if (l && r.page_number && r.original_question_number && figureMayContinue(l.layout, l.zones, r.page_number, r.original_question_number)) {
          problems.push(`figure may continue on PDF page ${r.page_number + 1} (question is last on page ${r.page_number}, next page starts with an image)`);
        }
      } catch (e) {
        problems.push(`check failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const o = { id: r.id, module: mod.get(r.module_id ?? "")?.module_name ?? "?", number: r.original_question_number, status: r.parsing_status, live: live.has(r.id), problems };
      out.push(o);
      if (problems.length) console.log(`${o.module} Q${o.number} ${o.status}${o.live ? " LIVE" : ""} ${o.id} — ${problems.join("; ")}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));
  const summary = { checked: out.length, withProblems: out.filter((o) => o.problems.length).length, live: out.filter((o) => o.live).length };
  console.log(summary);
  mkdirSync(".omc/reports", { recursive: true });
  const file = `.omc/reports/figure-audit-${DATE}.json`;
  writeFileSync(file, JSON.stringify({ vision: VISION, summary, outcomes: out.sort((a, b) => a.module.localeCompare(b.module) || (a.number ?? 0) - (b.number ?? 0)) }, null, 1));
  console.log(`report: ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
