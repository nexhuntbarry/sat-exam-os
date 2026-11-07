// scripts/compare-figures.ts
//
// Figure / table / choices check (lib/figure-compare.ts): compare the stored
// figure, table or choices of every Needs Review question whose notes ask for
// it with the source PDF. Match → figure notes cleared, approved when nothing
// else blocks (live-test rows keep their status + [live-fix]). Differs → a
// note links the PDF version for the side-by-side review (review queue and
// the question page).
//
//   node --env-file=.env.local --import tsx scripts/compare-figures.ts            # dry run (AI calls; DB untouched)
//   node --env-file=.env.local --import tsx scripts/compare-figures.ts --apply    # writes (backs up rows first)
//   options: --ids=<uuid,uuid>  --concurrency=3
//
// The dry run still uploads fresh PDF crops to Blob (needed to compare them);
// nothing references them unless --apply records a difference.
// Writes .omc/reports/compare-figures-<date>.(dry-run|apply).json and, on
// --apply, a backup of every target row to .omc/backups/.
import { mkdirSync, writeFileSync } from "fs";
import { getServiceClient } from "@/lib/supabase";
import { fetchPdfBase64 } from "@/lib/repair-ops";
import { extractChoicesFromPdfText, type PdfTextChoices } from "@/lib/pdf-text-choices";
import { liveQuestionIds } from "@/lib/live-questions";
import {
  compareFigureWithPdf,
  decideFigure,
  loadFigureTargets,
  uploadProposal,
  type FigureGroup,
  type FigureRow,
} from "@/lib/figure-compare";

const APPLY = process.argv.includes("--apply");
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const IDS = arg("ids")?.split(",").filter(Boolean);
const CONCURRENCY = Number(arg("concurrency") ?? 3);
const DATE = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

interface Outcome {
  id: string;
  module: string;
  number: number | null;
  group: FigureGroup | "failed" | "skipped";
  checked: string[];
  detail: string[];
  blockers: string[];
  removedNotes: string[];
  status_after: string | null;
  proposalUrl?: string | null;
}

async function main() {
  const db = getServiceClient();
  mkdirSync(".omc/reports", { recursive: true });
  mkdirSync(".omc/backups", { recursive: true });
  const targets = await loadFigureTargets(db, IDS);
  const { data: mods } = await db.from("modules").select("id, module_name, pdf_url");
  const mod = new Map((mods ?? []).map((m) => [m.id as string, m as { module_name: string; pdf_url: string | null }]));
  console.log(`${APPLY ? "APPLY" : "DRY RUN"}: ${targets.length} figure/table/choices targets`);

  if (APPLY && targets.length) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const { data, error } = await db.from("questions").select("*").in("id", targets.map((t) => t.id));
    if (error || (data ?? []).length !== targets.length) throw new Error(`backup failed: ${error?.message ?? `${data?.length} of ${targets.length} rows`}`);
    const file = `.omc/backups/compare-figures-${ts}.json`;
    writeFileSync(file, JSON.stringify(data, null, 1));
    console.log(`backup: ${file} (${data!.length} rows)`);
  }

  const live = await liveQuestionIds(db, targets.map((t) => t.id)).catch(() => new Set(targets.map((t) => t.id)));
  const pdfCache = new Map<string, Promise<{ b64: string; text: PdfTextChoices | null }>>();
  const pdfFor = (r: FigureRow) => {
    const url = r.source_pdf_url ?? mod.get(r.module_id ?? "")?.pdf_url ?? null;
    if (!url) return null;
    if (!pdfCache.has(url)) {
      pdfCache.set(
        url,
        (async () => {
          const b64 = await fetchPdfBase64(url);
          const text = await extractChoicesFromPdfText(b64).catch(() => null);
          return { b64, text };
        })(),
      );
    }
    return pdfCache.get(url)!;
  };

  const out: Outcome[] = [];
  const queue = [...targets];
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const base = { id: r.id, module: mod.get(r.module_id ?? "")?.module_name ?? "?", number: r.original_question_number };
      let o: Outcome;
      try {
        const pdf = pdfFor(r);
        if (!pdf) throw new Error("no source PDF");
        const { b64, text } = await pdf;
        const res = await compareFigureWithPdf(r, b64, text);
        const proposalUrl = res.outcome === "differs" && APPLY ? await uploadProposal(res.proposal) : null;
        const d = decideFigure(r, res, live.has(r.id), proposalUrl);
        o = {
          ...base,
          group: d.group,
          checked: res.checked,
          detail: res.detail,
          blockers: d.blockers,
          removedNotes: d.removedNotes,
          status_after: (d.update?.parsing_status as string | undefined) ?? r.parsing_status,
          proposalUrl,
        };
        if (APPLY && d.update) {
          let q = db.from("questions").update(d.update).eq("id", r.id);
          if (r.updated_at) q = q.eq("updated_at", r.updated_at);
          const { data, error } = await q.select("id");
          if (error || !data?.length) o = { ...o, group: "skipped", status_after: r.parsing_status, detail: [...o.detail, error ? error.message : "row changed since it was read"] };
        }
      } catch (e) {
        o = { ...base, group: "failed", checked: [], detail: [e instanceof Error ? e.message : String(e)], blockers: [], removedNotes: [], status_after: r.parsing_status };
      }
      out.push(o);
      console.log(`[${out.length}/${targets.length}] ${o.group.padEnd(18)} ${o.module} Q${o.number} — ${[...o.detail, ...o.blockers.map((b) => `blocks: ${b}`)].join(" | ").slice(0, 300)}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));

  const summary: Record<string, number> = {};
  for (const o of out) summary[o.group] = (summary[o.group] ?? 0) + 1;
  console.log(summary);
  const file = `.omc/reports/compare-figures-${DATE}.${APPLY ? "apply" : "dry-run"}.json`;
  writeFileSync(file, JSON.stringify({ apply: APPLY, summary, outcomes: out }, null, 1));
  console.log(`report: ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
