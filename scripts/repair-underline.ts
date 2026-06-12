// scripts/repair-underline.ts
//
// One-off repair: for the 6 SAT R&W questions that ask "function of
// the underlined portion in the text" but whose question_text was
// parsed without the <u>…</u> markup, re-fetch the source PDF, ask
// Claude to identify the exact underlined run on the question's page,
// and patch question_text in DB.
//
// Usage:
//   npx tsx scripts/repair-underline.ts [--dry-run]
//
// Targets are picked dynamically: every question whose question_text
// matches "underlined portion" but does NOT already contain a <u>…</u>
// tag is included. Idempotent — running it again after a successful
// patch is a no-op.

import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";

// ── env loader (matches scripts/audit-needs-drawing.ts) ──────────
function loadEnv(file: string, overwrite: boolean) {
  try {
    const body = readFileSync(resolve(process.cwd(), file), "utf8");
    for (const line of body.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (!m) continue;
      if (overwrite || !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* ignore */
  }
}
loadEnv(".env.local", true);
loadEnv(".env", false);

if (process.env.NEXT_PUBLIC_SUPABASE_URL && !process.env.SUPABASE_URL) {
  process.env.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
}
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase credentials");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY");
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");

const RepairSchema = z.object({
  underlined_runs: z
    .array(z.string())
    .describe(
      "Each underlined run from the passage, in reading order, verbatim character-for-character. Empty array if no underline is visible. Many SAT R&W questions underline one run; some underline two (the question stem will say 'underlined portions').",
    ),
});

const SYSTEM = `You are reading an SAT Reading & Writing question page. One question on this page asks "Which choice best describes the function of the underlined portion(s) in the text…" — find every run of text in the passage that has an actual underline drawn under it in the PDF, and return them verbatim.

Rules:
- Copy each underlined run character-for-character from the passage. Do not paraphrase, summarize, normalize quotes, fix typos, expand abbreviations, or trim punctuation. Preserve the original spelling — including names you might be tempted to "correct" (e.g. "Findern" stays "Findern", not "Finderm").
- Include leading / trailing punctuation only if it is itself underlined.
- Underlines are drawn as horizontal lines under glyphs in the printed passage — not bolding, not italics. Make sure you're matching a real underline.
- Return each underline as a separate array entry, in the order they appear in the passage. If the question stem uses the singular "underlined portion", there will usually be exactly one; if it uses the plural "underlined portions", there will be two or more.
- If you cannot see any underline (rare — but possible if the PDF page was misrouted), return an empty array.

Return JSON only matching the schema.`;

async function findUnderlinedRuns(pdfBase64: string, questionNumber: number) {
  const result = await generateObject({
    model: anthropic("claude-sonnet-4-6"),
    schema: RepairSchema,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "file",
            data: pdfBase64,
            mediaType: "application/pdf",
          },
          {
            type: "text",
            text: `Question number on this page: Q${questionNumber}. Find every underlined run in the passage that this question's "function of the underlined portion(s)" prompt refers to. Return JSON: { underlined_runs: string[] }.`,
          },
        ],
      },
    ],
  });
  return result.object.underlined_runs.map((s) => s.trim()).filter(Boolean);
}

async function fetchPdfBase64(url: string): Promise<string> {
  // Module PDFs live in a private Vercel Blob store. The store accepts
  // a bearer token in the Authorization header (same shape the app's
  // /api/blob-image route uses to proxy these blobs).
  const headers: Record<string, string> = {};
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Fetch ${url} failed: ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("base64");
}

function normalizePunct(s: string) {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// Wrap each underlined run in <u>…</u> inside text. Tries exact
// substring first, then a punctuation-normalised retry, then a small
// fuzzy fallback that lets the AI's run differ from stored text by
// up to 2 character edits (handles OCR-ish "Findern" vs "Finderm"
// without going overboard).
function wrapUnderlinedRuns(text: string, runs: string[]): { next: string; matched: number } {
  let next = text;
  let matched = 0;
  for (const run of runs) {
    if (!run) continue;
    if (next.includes(run)) {
      next = next.replace(run, `<u>${run}</u>`);
      matched++;
      continue;
    }
    const normText = normalizePunct(next);
    const normRun = normalizePunct(run);
    if (normText.includes(normRun)) {
      // Replace the punctuation-normalised text wholesale so the wrap
      // sits on the stored characters.
      next = next.replace(new RegExp(escapeRegExp(normRun), "g"), `<u>${normRun}</u>`);
      matched++;
      continue;
    }
    // Fuzzy: scan stored text for the closest substring of the same
    // length within edit distance 2. Cheap because there's only one
    // candidate region in practice.
    const m = fuzzyFindSubstring(next, run, 2);
    if (m) {
      next = next.slice(0, m.start) + `<u>${m.found}</u>` + next.slice(m.end);
      matched++;
      continue;
    }
  }
  return { next, matched };
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function levenshtein(a: string, b: string, cap: number): number {
  // Iterative DP with an early-exit when the running minimum on a row
  // exceeds cap. Good enough for ~200 char runs in this script.
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let j = 0; j <= b.length; j++) dp[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = i - 1;
    dp[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
      if (dp[j] < rowMin) rowMin = dp[j];
    }
    if (rowMin > cap) return cap + 1;
  }
  return dp[b.length];
}

function fuzzyFindSubstring(
  haystack: string,
  needle: string,
  maxEdits: number,
): { start: number; end: number; found: string } | null {
  // Slide a window of needle.length over haystack and keep the best
  // match within maxEdits. For SAT-passage scale this is fine.
  const n = needle.length;
  let best: { start: number; end: number; dist: number } | null = null;
  for (let i = 0; i <= haystack.length - n; i++) {
    // Cheap early-skip: require either first or last char to be close.
    const window = haystack.slice(i, i + n);
    const d = levenshtein(window, needle, maxEdits);
    if (d <= maxEdits && (!best || d < best.dist)) {
      best = { start: i, end: i + n, dist: d };
      if (d === 0) break;
    }
  }
  if (!best) return null;
  return { start: best.start, end: best.end, found: haystack.slice(best.start, best.end) };
}

async function main() {
  const sb = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: candidates, error } = await sb
    .from("questions")
    .select("id, original_question_number, question_text, source_pdf_url, page_number")
    .ilike("question_text", "%underlined portion%");
  if (error) {
    console.error("Query failed:", error);
    process.exit(1);
  }

  // Filter to ones that don't already have <u>…</u> markup.
  const needsRepair = (candidates ?? []).filter(
    (q) => !/<u\b/i.test(q.question_text ?? ""),
  );
  console.log(
    `[underline-repair] candidates=${candidates?.length ?? 0} needs_repair=${needsRepair.length} dry_run=${dryRun}`,
  );

  let patched = 0;
  let skipped = 0;
  for (const q of needsRepair) {
    if (!q.source_pdf_url) {
      console.log(`  ⤳ Q${q.original_question_number} ${q.id} — no source_pdf_url, skip`);
      skipped++;
      continue;
    }
    try {
      const pdfBase64 = await fetchPdfBase64(q.source_pdf_url);
      const runs = await findUnderlinedRuns(
        pdfBase64,
        q.original_question_number ?? 0,
      );
      if (runs.length === 0) {
        console.log(
          `  ⤳ Q${q.original_question_number} ${q.id} — solver found no underline, skip`,
        );
        skipped++;
        continue;
      }
      const { next, matched } = wrapUnderlinedRuns(q.question_text, runs);
      if (matched === 0) {
        console.log(
          `  ⤳ Q${q.original_question_number} ${q.id} — none of ${runs.length} run(s) matched question_text. runs=${JSON.stringify(runs.map((r) => r.slice(0, 60)))}`,
        );
        skipped++;
        continue;
      }
      const summary = runs
        .map((r) => `"${r.slice(0, 50)}${r.length > 50 ? "…" : ""}"`)
        .join(", ");
      console.log(
        `  ✓ Q${q.original_question_number} ${q.id} — wrapped ${matched}/${runs.length} run(s): ${summary}`,
      );
      if (!dryRun) {
        const { error: upErr } = await sb
          .from("questions")
          .update({ question_text: next })
          .eq("id", q.id);
        if (upErr) {
          console.error(`    ! update failed for ${q.id}:`, upErr.message);
          skipped++;
          continue;
        }
      }
      patched++;
    } catch (e) {
      console.error(
        `  ! Q${q.original_question_number} ${q.id} — error:`,
        e instanceof Error ? e.message : e,
      );
      skipped++;
    }
  }
  console.log(`[underline-repair] done. patched=${patched} skipped=${skipped}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
