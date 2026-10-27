// scripts/find-duplicate-table-images.ts
//
// READ-ONLY. Lists questions whose stem carries a Markdown table AND an
// attached image that is (or may be) a screenshot of that same table — the
// student sees the table twice. Never writes.
//
//   confirmed — every image's alt (the parser/cropper region description)
//               names a table and no other kind of figure, or is the
//               full-page fallback stamped only because has_table was set.
//   candidate — Markdown table + image(s), but the alt doesn't settle it
//               (empty alt, or a real figure kind is named) → eyeball it.
//
//   npx tsx scripts/find-duplicate-table-images.ts [--module <id>] [--json <path>]
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const envText = readFileSync(".env.local", "utf-8");
for (const l of envText.split("\n")) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const argv = process.argv.slice(2);
const arg = (f: string) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const MODULE = arg("--module");
const JSON_OUT = arg("--json");

async function main() {
  const { getServiceClient } = await import("../lib/supabase");
  const { hasMarkdownTable, isRedundantTableRegion } = await import("../lib/ai/extract-images");
  const db = getServiceClient();

  const { data: mods } = await db.from("modules").select("id, module_name");
  const modName = new Map((mods ?? []).map((m) => [m.id as string, m.module_name as string]));

  const rows: Record<string, unknown>[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = db
      .from("questions")
      .select("id, module_id, original_question_number, parsing_status, has_image, has_table, image_urls, image_alts, parsing_notes, question_text")
      .not("image_urls", "eq", "{}")
      .order("id")
      .range(from, from + PAGE - 1);
    if (MODULE) q = q.eq("module_id", MODULE);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }

  const out: {
    verdict: "confirmed" | "candidate";
    module: string;
    question_number: number;
    question_id: string;
    parsing_status: string;
    has_image: boolean;
    has_table: boolean;
    image_urls: string[];
    image_alts: string[];
    parsing_notes: string | null;
  }[] = [];
  for (const r of rows) {
    const urls = Array.isArray(r.image_urls) ? (r.image_urls as string[]) : [];
    if (urls.length === 0) continue;
    const text = (r.question_text as string | null) ?? "";
    if (!hasMarkdownTable(text)) continue;
    const alts = Array.isArray(r.image_alts) ? (r.image_alts as string[]) : [];
    const confirmed =
      alts.length === urls.length &&
      alts.every((alt) => isRedundantTableRegion({ question_text: text, has_image: false }, { alt }));
    out.push({
      verdict: confirmed ? "confirmed" : "candidate",
      module: modName.get(r.module_id as string) ?? (r.module_id as string),
      question_number: r.original_question_number as number,
      question_id: r.id as string,
      parsing_status: r.parsing_status as string,
      has_image: !!r.has_image,
      has_table: !!r.has_table,
      image_urls: urls,
      image_alts: alts,
      parsing_notes: (r.parsing_notes as string | null) ?? null,
    });
  }
  out.sort((a, b) => a.module.localeCompare(b.module) || a.question_number - b.question_number);

  for (const o of out) {
    console.log(
      `[${o.verdict}] ${o.module} Q${o.question_number} (${o.parsing_status}) id=${o.question_id} alts=${JSON.stringify(o.image_alts)}`,
    );
  }
  console.log(
    `\n${out.length} question(s) with a Markdown table + image: ${out.filter((o) => o.verdict === "confirmed").length} confirmed, ${out.filter((o) => o.verdict === "candidate").length} candidate(s).`,
  );
  if (JSON_OUT) {
    mkdirSync(dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
    console.log(`Wrote ${JSON_OUT}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
