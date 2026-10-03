import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const t = readFileSync(".env.local", "utf-8");
for (const l of t.split("\n")) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, ""); }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
const APPLY = process.argv.includes("--apply");

// Guard against the "wrong image — it's the previous question's figure"
// bug on pure-algebra math questions. These questions carry the equation
// in their TEXT already; the figure-recovery pass sometimes also attaches
// a crop, and that crop often grabs the neighbouring question's region.
// When a math question's attached image is just an EQUATION (not a real
// graph/diagram/table) AND the equation is already present as text, the
// image is redundant and unsafe — strip it.
//
// Conservative: only equation-type alts, only when the stem has LaTeX, and
// never when the alt mentions a real figure kind.
const EQUATION_ALT = /\b(equation|system of equations|expression|formula|inequalit)/i;
const REAL_FIGURE = /\b(graph|plot|scatter|diagram|figure|chart|table|number line|triangle|circle|rectangle|square|polygon|geometr|coordinate|histogram|bar|curve|parabola|line graph|dot plot|box plot|angle|shaded|shape|grid|map|drawing|image of|photo)/i;
const HAS_LATEX = /\$[^$]+\$|\\dfrac|\\frac|\\sqrt|\\left|x\^\{?\d/;

type Row = {
  id: string; original_question_number: number | null; section: string | null;
  has_image: boolean | null; image_urls: unknown; image_alts: unknown;
  question_text: string; parsing_status: string; parsing_notes: string | null;
  modules: { module_name: string } | null;
};

async function main() {
  const PAGE = 1000; let from = 0; const rows: Row[] = [];
  for (;;) {
    const { data } = await db
      .from("questions")
      .select("id, original_question_number, section, has_image, image_urls, image_alts, question_text, parsing_status, parsing_notes, modules(module_name)")
      .neq("parsing_status", "Rejected")
      .range(from, from + PAGE - 1);
    const batch = (data ?? []) as unknown as Row[];
    rows.push(...batch);
    if (batch.length < PAGE) break; from += PAGE;
  }
  console.log(`Scanned ${rows.length} questions.`);

  const hits: Row[] = [];
  for (const q of rows) {
    const isMath = (q.section ?? "").toLowerCase().includes("math");
    const urls = Array.isArray(q.image_urls) ? (q.image_urls as string[]) : [];
    if (!isMath || !q.has_image || urls.length === 0) continue;
    const alt = (Array.isArray(q.image_alts) ? (q.image_alts as string[]) : []).join(" ; ");
    const stem = q.question_text ?? "";
    // Equation-type image, no real-figure words, and the equation is in the stem.
    if (EQUATION_ALT.test(alt) && !REAL_FIGURE.test(alt) && HAS_LATEX.test(stem)) {
      hits.push(q);
    }
  }

  console.log(`\nRedundant equation-image math questions: ${hits.length}`);
  for (const q of hits.slice(0, 30)) {
    const alt = (Array.isArray(q.image_alts) ? (q.image_alts as string[]) : []).join(" ; ");
    console.log(`  ${(q.modules?.module_name ?? "?").slice(0, 40)} Q${q.original_question_number} [${q.parsing_status}] alt="${alt.slice(0, 60)}"`);
  }

  if (!APPLY) { console.log("\n(dry run — pass --apply to strip these redundant images)"); return; }

  let fixed = 0;
  for (const q of hits) {
    const notes = appendNote(q.parsing_notes, "Removed redundant equation-crop image (equation already in the question text; crop was unreliable).");
    await db.from("questions").update({
      has_image: false, image_urls: [], image_alts: [],
      parsing_notes: notes, updated_at: new Date().toISOString(),
    }).eq("id", q.id);
    fixed++;
  }
  console.log(`\nAPPLIED. stripped images on ${fixed} questions.`);
}

function appendNote(existing: string | null, add: string): string {
  const base = (existing ?? "").trim();
  if (base.includes(add)) return base;
  return base ? `${base}; ${add}` : add;
}

main();
