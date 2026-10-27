// scripts/apply-duplicate-table-fixes.ts
//
// Removes table SCREENSHOTS from questions whose stem already carries the
// same table as Markdown (the student saw the table twice). Input:
// .omc/qa/duplicate-table-images.json from scripts/find-duplicate-table-images.ts.
//
// DRY RUN by default; `--apply` writes. Same pattern as
// scripts/apply-choice-audit-fixes.ts: live re-check, full-row backup to
// .omc/backups/ before any write.
//
// Only "confirmed" rows are touched, and only when, re-checked live:
//   - the stem still has a Markdown table, and
//   - the image's alt names a table and nothing else (isRedundantTableRegion), and
//   - the screenshot's cells match the stem's Markdown table: the image is
//     read back (Claude vision) and ≥ 90% of its cells must appear in the
//     stem table. Anything else is left alone and reported.
// Real figures on the same question stay. has_image goes false only when no
// image is left. "candidate" rows are never touched — they're listed.
//
//   npx tsx scripts/apply-duplicate-table-fixes.ts            # dry run
//   npx tsx scripts/apply-duplicate-table-fixes.ts --apply    # write
import { readFileSync, writeFileSync, mkdirSync } from "fs";

const envText = readFileSync(".env.local", "utf-8");
for (const l of envText.split("\n")) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const APPLY = process.argv.includes("--apply");
const INPUT = ".omc/qa/duplicate-table-images.json";
const FIX_DATE = "2026-10-26";

interface Entry {
  verdict: "confirmed" | "candidate";
  module: string;
  question_number: number;
  question_id: string;
  image_alts: string[];
}

/** Cell values of every Markdown table in a stem, normalized. */
function stemCells(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => l.trim().startsWith("|") && !/^\|?\s*:?-{2,}/.test(l.trim()))
    .flatMap((l) => l.split("|"))
    .map(normCell)
    .filter(Boolean);
}
function normCell(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/\\\$/g, "$")
    .replace(/\\[a-zA-Z]+/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, "");
}

async function main() {
  const { getServiceClient } = await import("../lib/supabase");
  const { fetchPdfAsBase64 } = await import("../lib/ai/parse-pdf");
  const { hasMarkdownTable, isRedundantTableRegion } = await import("../lib/ai/extract-images");
  const { anthropic } = await import("@ai-sdk/anthropic");
  const { generateObject } = await import("ai");
  const { z } = await import("zod");
  const db = getServiceClient();

  const entries = JSON.parse(readFileSync(INPUT, "utf-8")) as Entry[];
  const confirmed = entries.filter((e) => e.verdict === "confirmed");
  const candidates = entries.filter((e) => e.verdict === "candidate");

  type Plan = {
    e: Entry;
    row: Record<string, unknown>;
    removeIdx: number[];
    keepUrls: string[];
    keepAlts: string[];
    match: string;
    ok: boolean;
    reason?: string;
  };
  const plans: Plan[] = [];

  for (const e of confirmed) {
    const { data: row } = await db.from("questions").select("*").eq("id", e.question_id).maybeSingle();
    if (!row) {
      plans.push({ e, row: {}, removeIdx: [], keepUrls: [], keepAlts: [], match: "—", ok: false, reason: "row not found" });
      continue;
    }
    const text = (row.question_text as string | null) ?? "";
    const urls = Array.isArray(row.image_urls) ? (row.image_urls as string[]) : [];
    const alts = Array.isArray(row.image_alts) ? (row.image_alts as string[]) : [];
    const base: Omit<Plan, "match" | "ok" | "removeIdx" | "keepUrls" | "keepAlts"> = { e, row };
    if (!hasMarkdownTable(text)) {
      plans.push({ ...base, removeIdx: [], keepUrls: urls, keepAlts: alts, match: "—", ok: false, reason: "stem has no Markdown table any more" });
      continue;
    }
    const removeIdx = urls
      .map((_, i) => i)
      .filter((i) => isRedundantTableRegion({ question_text: text, has_image: false }, { alt: alts[i] ?? "" }));
    if (removeIdx.length === 0) {
      plans.push({ ...base, removeIdx, keepUrls: urls, keepAlts: alts, match: "—", ok: false, reason: "no image whose alt is only a table" });
      continue;
    }

    // Verify each screenshot really is the stem's table: read its cells back.
    const cells = new Set(stemCells(text));
    let worst = 1;
    let readErr = "";
    for (const i of removeIdx) {
      try {
        const b64 = await fetchPdfAsBase64(urls[i]); // any Blob file; base64 of the PNG
        const res = await generateObject({
          model: anthropic("claude-sonnet-4-6"),
          schema: z.object({ cells: z.array(z.string()).describe("Every cell of the table (headers + body), verbatim, row by row") }),
          system: "Read the data table in this image. Return every cell (header and body) verbatim, row by row. If the image is not a table, return an empty list.",
          messages: [{ role: "user", content: [{ type: "image", image: Buffer.from(b64, "base64"), mediaType: "image/png" }] }],
          maxRetries: 2,
        });
        const img = res.object.cells.map(normCell).filter(Boolean);
        const hit = img.length ? img.filter((c) => cells.has(c)).length / img.length : 0;
        worst = Math.min(worst, hit);
      } catch (err) {
        readErr = err instanceof Error ? err.message : String(err);
        worst = 0;
      }
    }
    const ok = worst >= 0.9;
    plans.push({
      ...base,
      removeIdx,
      keepUrls: urls.filter((_, i) => !removeIdx.includes(i)),
      keepAlts: alts.filter((_, i) => !removeIdx.includes(i)),
      match: readErr ? `read failed: ${readErr.slice(0, 60)}` : `${Math.round(worst * 100)}% of screenshot cells in stem table`,
      ok,
      reason: ok ? undefined : "screenshot doesn't match the stem table closely enough — left for a human",
    });
  }

  console.log(`\n${APPLY ? "APPLY" : "DRY RUN"} — duplicate table screenshots\n`);
  console.log("| Module | Q | Status | Images before → after | has_image after | Table match | Action |");
  console.log("|---|---|---|---|---|---|---|");
  for (const p of plans) {
    const before = Array.isArray(p.row.image_urls) ? (p.row.image_urls as string[]).length : 0;
    console.log(
      `| ${p.e.module} | ${p.e.question_number} | ${p.row.parsing_status ?? "—"} | ${before} → ${p.ok ? p.keepUrls.length : before} | ${p.ok ? p.keepUrls.length > 0 : p.row.has_image} | ${p.match} | ${p.ok ? `remove table screenshot (${p.removeIdx.length})` : `SKIP: ${p.reason}`} |`,
    );
  }
  console.log(`\nUnconfirmed candidates (NOT touched): ${candidates.length}`);
  console.log("| Module | Q | Status | Image alts |\n|---|---|---|---|");
  for (const c of candidates) {
    const { data: r } = await db.from("questions").select("parsing_status").eq("id", c.question_id).maybeSingle();
    console.log(`| ${c.module} | ${c.question_number} | ${r?.parsing_status ?? "—"} | ${JSON.stringify(c.image_alts).slice(0, 90)} |`);
  }
  const todo = plans.filter((p) => p.ok);
  console.log(`\nWould fix ${todo.length}/${confirmed.length} confirmed; skipped ${confirmed.length - todo.length}.`);

  if (!APPLY) {
    console.log("\nDry run only. Re-run with --apply to write.");
    return;
  }

  mkdirSync(".omc/backups", { recursive: true });
  const backup = `.omc/backups/duplicate-table-fixes-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(backup, JSON.stringify({ questions: todo.map((p) => p.row) }, null, 2));
  console.log(`\nBackup written: ${backup}`);
  for (const p of todo) {
    const base = ((p.row.parsing_notes as string | null) ?? "").trim();
    const note = `Fixed ${FIX_DATE}: removed table screenshot — the same table is in the question text as Markdown`;
    const { error } = await db
      .from("questions")
      .update({
        image_urls: p.keepUrls,
        image_alts: p.keepAlts,
        has_image: p.keepUrls.length > 0,
        parsing_notes: base ? `${base}; ${note}` : note,
        updated_at: new Date().toISOString(),
      })
      .eq("id", p.e.question_id);
    console.log(`${p.e.module} Q${p.e.question_number}: ${error ? `FAILED ${error.message}` : "fixed"}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
