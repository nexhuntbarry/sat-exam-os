// scripts/audit-auto-approved.ts
//
// Programmatic sanity audit of the pile flipped to Approved by
// auto-promote-high-confidence (parsing_status='Approved' AND
// reviewed_by IS NULL). For each detected anomaly the row is demoted
// back to Needs Review with a parsing_note that names the failed
// check so the admin can find it later.
//
// Checks (all automatic, no human judgement required):
//
//   1. MCQ with choices.length !== 4
//   2. MCQ where correct_answer letter is not one of the choice labels
//   3. SPR with correct_answer that looks like a letter (A/B/C/D)
//      → solver leaked MCQ reasoning into an SPR row
//   4. Empty question_text
//   5. Empty correct_answer
//   6. R&W section row tagged as Student Produced Response
//      → R&W has no grid-ins; misclassification
//   7. has_image=true but image_urls empty → solver answered blind
//   8. question_text still contains the parser "blank" artifact
//      "____ blank" / "____\nblank"
//   9. question_text contains a pipe-flattened table run
//      (3+ "|" cells in one line, no header-separator row of dashes)
//  10. Re-run solver self-consistency on stored explanation:
//      if explanation's final-answer line disagrees with correct_answer
//
// Usage:
//   npx tsx scripts/audit-auto-approved.ts             # dry-run
//   npx tsx scripts/audit-auto-approved.ts --apply     # demote anomalies

import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import katex from "katex";

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

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error("Missing env");
  process.exit(1);
}
const apply = process.argv.includes("--apply");

type Row = {
  id: string;
  original_question_number: number | null;
  module_id: string;
  section: string | null;
  question_type: string | null;
  question_text: string | null;
  choices: Array<{ label: string; text: string }> | null;
  correct_answer: string | null;
  explanation: string | null;
  has_image: boolean | null;
  image_urls: string[] | null;
  has_table: boolean | null;
  ai_confidence_score: number | null;
};

function stripMath(text: string): string {
  return text
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\$[^$\n]*\$/g, " ");
}
function hasUnwrappedMath(text: string): boolean {
  const noMath = stripMath(text);
  if (/\\(?:frac|sqrt|pi|cdot|times|div|log|sin|cos|tan|int|sum)\b/.test(noMath)) return true;
  if (/[A-Za-z]\^\{[^}]+\}/.test(noMath)) return true;
  if (/[A-Za-z]_\{[^}]+\}/.test(noMath)) return true;
  if (/[A-Za-z]\^\d+(?!\$)/.test(noMath)) return true;
  if (/\bsqrt\s*\(/.test(noMath)) return true;
  return false;
}
function hasTableSyntax(text: string): boolean {
  if (/\|\s*-{3,}\s*\|/.test(text)) return true;
  let lines = 0;
  for (const line of stripMath(text).split("\n")) {
    if ((line.match(/\|/g) ?? []).length >= 3) lines++;
    if (lines >= 2) return true;
  }
  return false;
}
function mathRenderFails(text: string): boolean {
  if (!text) return false;
  const displayBlocks = text.match(/\$\$([\s\S]*?)\$\$/g) ?? [];
  for (const b of displayBlocks) {
    const expr = b.slice(2, -2);
    if (!expr.trim()) continue;
    try {
      katex.renderToString(expr, { throwOnError: true, displayMode: true });
    } catch {
      return true;
    }
  }
  const withoutDisplay = text.replace(/\$\$[\s\S]*?\$\$/g, " ");
  const inlineBlocks = withoutDisplay.match(/\$([^$\n]+)\$/g) ?? [];
  for (const b of inlineBlocks) {
    const expr = b.slice(1, -1);
    if (!expr.trim()) continue;
    try {
      katex.renderToString(expr, { throwOnError: true, displayMode: false });
    } catch {
      return true;
    }
  }
  return false;
}

function looksLikeValidUrl(u: string): boolean {
  if (!u || typeof u !== "string") return false;
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:";
  } catch {
    return false;
  }
}

type Anomaly = { row: Row; failedChecks: string[] };

function letterFromExplanationTrailer(explanation: string | null): string | null {
  if (!explanation) return null;
  // Pull the value off the "Final answer: X" trailer the solver is
  // required to emit.
  const m = explanation.match(/Final answer:\s*([^\n]+)/i);
  if (!m) return null;
  const value = m[1].trim().replace(/[.,;)]+$/, "");
  return value || null;
}

function pipeFlattenedTable(text: string): boolean {
  // If the text has a real markdown-table dash row anywhere
  // (`| --- | --- |`), trust that the pipes belong to a proper
  // table and skip the check.
  if (/\|\s*-{3,}\s*\|/.test(text)) return false;
  // Math expressions are wrapped in $...$ / $$...$$ — absolute-value
  // bars inside math are pipes too but they are not table cells.
  // Strip math regions before counting pipes.
  const stripped = text
    .replace(/\$\$[\s\S]*?\$\$/g, "")
    .replace(/\$[^$\n]*\$/g, "");
  // Flag if any remaining line carries 3+ pipes — that's the
  // "Hoard name | Date | Year | Description Broighter…" shape the
  // parser was emitting before the table rule landed.
  for (const line of stripped.split("\n")) {
    const cells = (line.match(/\|/g) ?? []).length;
    if (cells >= 3) return true;
  }
  return false;
}

const CHECKS: Array<{
  id: string;
  description: string;
  failed: (r: Row) => boolean;
}> = [
  {
    id: "mcq-bad-choice-count",
    description: "MCQ with choices.length !== 4",
    failed: (r) =>
      r.question_type === "Multiple Choice" &&
      (!Array.isArray(r.choices) || r.choices.length !== 4),
  },
  {
    id: "mcq-answer-not-in-choices",
    description: "MCQ where correct_answer letter is not in choice labels",
    failed: (r) => {
      if (r.question_type !== "Multiple Choice") return false;
      if (!Array.isArray(r.choices) || r.choices.length === 0) return false;
      const ans = (r.correct_answer ?? "").trim().toUpperCase();
      if (!/^[A-D]$/.test(ans)) return true; // non-letter answer on MCQ
      const labels = new Set(
        r.choices.map((c) => (c.label ?? "").trim().toUpperCase()),
      );
      return !labels.has(ans);
    },
  },
  {
    id: "spr-with-letter-answer",
    description: "SPR row with letter answer (solver leaked MCQ)",
    failed: (r) =>
      r.question_type === "Student Produced Response" &&
      /^[A-D]$/i.test((r.correct_answer ?? "").trim()),
  },
  {
    id: "empty-text",
    description: "Empty question_text",
    failed: (r) => !r.question_text || r.question_text.trim().length === 0,
  },
  {
    id: "empty-answer",
    description: "Empty correct_answer",
    failed: (r) => !r.correct_answer || r.correct_answer.trim().length === 0,
  },
  {
    id: "rw-misclassified-as-spr",
    description: "R&W row tagged Student Produced Response (R&W has no grid-ins)",
    failed: (r) =>
      (r.section === "Reading & Writing" || r.section === "Reading and Writing") &&
      r.question_type === "Student Produced Response",
  },
  {
    id: "blind-image",
    description: "has_image=true but image_urls empty (solver answered blind)",
    failed: (r) =>
      r.has_image === true &&
      (!Array.isArray(r.image_urls) || r.image_urls.length === 0),
  },
  {
    id: "blank-artifact",
    description: 'question_text still contains "____ blank" parser artifact',
    failed: (r) =>
      r.question_text != null && /_{2,}\s*blank\b/i.test(r.question_text),
  },
  {
    id: "pipe-flattened-table",
    description: "question_text contains pipe-flattened table (not markdown table)",
    failed: (r) =>
      r.question_text != null && pipeFlattenedTable(r.question_text),
  },
  {
    id: "has-table-flag-but-no-table-in-text",
    description: "has_table=true but question_text has no table syntax (parser dropped the table)",
    failed: (r) =>
      r.has_table === true &&
      r.question_text != null &&
      !hasTableSyntax(r.question_text),
  },
  {
    id: "image-url-malformed",
    description: "has_image=true and image_urls non-empty, but at least one URL is malformed",
    failed: (r) => {
      if (r.has_image !== true) return false;
      const urls = Array.isArray(r.image_urls) ? r.image_urls : [];
      if (urls.length === 0) return false;
      return urls.some((u) => !looksLikeValidUrl(u));
    },
  },
  {
    id: "math-unwrapped",
    description: "Math expression present without $…$ delimiter (renderer prints raw LaTeX)",
    failed: (r) => {
      if (r.question_text && hasUnwrappedMath(r.question_text)) return true;
      if (Array.isArray(r.choices)) {
        for (const c of r.choices) {
          if (c.text && hasUnwrappedMath(c.text)) return true;
        }
      }
      return false;
    },
  },
  {
    id: "math-render-failed",
    description: "A $…$ region throws when rendered through KaTeX (student sees red error span / raw LaTeX)",
    failed: (r) => {
      if (r.question_text && mathRenderFails(r.question_text)) return true;
      if (r.explanation && mathRenderFails(r.explanation)) return true;
      if (Array.isArray(r.choices)) {
        for (const c of r.choices) {
          if (c.text && mathRenderFails(c.text)) return true;
        }
      }
      return false;
    },
  },
  {
    id: "explanation-final-mismatch",
    description: "Explanation 'Final answer:' disagrees with stored correct_answer",
    failed: (r) => {
      const trailer = letterFromExplanationTrailer(r.explanation);
      if (!trailer) return false; // no trailer to compare against
      const stored = (r.correct_answer ?? "").trim();
      // Single-letter trailer vs stored: exact match required.
      if (/^[A-D]$/i.test(trailer) && /^[A-D]$/i.test(stored)) {
        return trailer.toUpperCase() !== stored.toUpperCase();
      }
      // Numeric: normalize and compare numerically with tolerance.
      const tNum = parseFloat(trailer.replace(/[,]/g, ""));
      const sNum = parseFloat(stored.replace(/[,]/g, ""));
      if (!Number.isNaN(tNum) && !Number.isNaN(sNum)) {
        return Math.abs(tNum - sNum) > 0.0001;
      }
      // Otherwise: fall back to case-insensitive string equality after
      // trimming common quoting/whitespace.
      const norm = (s: string) => s.trim().toLowerCase().replace(/^["']|["']$/g, "");
      return norm(trailer) !== norm(stored);
    },
  },
];

async function main() {
  const sb = createClient(supabaseUrl!, supabaseKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await sb
    .from("questions")
    .select(
      "id, original_question_number, module_id, section, question_type, question_text, choices, correct_answer, explanation, has_image, image_urls, has_table, ai_confidence_score",
    )
    .eq("parsing_status", "Approved")
    .is("reviewed_by", null)
    .limit(10000);
  if (error) {
    console.error("[audit] select failed:", error);
    process.exit(1);
  }
  const rows: Row[] = (data ?? []) as Row[];
  console.log(
    `[audit] auto-approved rows scanned: ${rows.length} apply=${apply}`,
  );

  const anomalies: Anomaly[] = [];
  const checkHits: Record<string, number> = {};
  for (const row of rows) {
    const failed = CHECKS.filter((c) => c.failed(row)).map((c) => c.id);
    if (failed.length > 0) {
      anomalies.push({ row, failedChecks: failed });
      for (const id of failed) checkHits[id] = (checkHits[id] ?? 0) + 1;
    }
  }

  console.log(`[audit] anomalies: ${anomalies.length} (${((anomalies.length / Math.max(1, rows.length)) * 100).toFixed(1)}% of audited pool)`);
  console.log("[audit] hits by check:");
  for (const c of CHECKS) {
    const n = checkHits[c.id] ?? 0;
    if (n > 0) console.log(`  - ${c.id}: ${n}  (${c.description})`);
  }

  if (anomalies.length === 0) {
    console.log("[audit] clean. nothing to demote.");
    return;
  }

  if (anomalies.length <= 20) {
    console.log("[audit] anomaly rows:");
    for (const a of anomalies) {
      console.log(
        `  ${a.row.id} Q${a.row.original_question_number} (${a.row.section ?? "?"}) failed: ${a.failedChecks.join(", ")}`,
      );
    }
  }

  if (!apply) {
    console.log("[audit] DRY RUN — re-run with --apply to demote anomalies to Needs Review.");
    return;
  }

  const chunk = 100;
  let demoted = 0;
  for (let i = 0; i < anomalies.length; i += chunk) {
    const slice = anomalies.slice(i, i + chunk);
    for (const a of slice) {
      const note = `Demoted by audit-auto-approved.ts 2026-05-30: failed checks → ${a.failedChecks.join(", ")}`;
      const { error: upErr } = await sb
        .from("questions")
        .update({
          parsing_status: "Needs Review",
          parsing_notes: note,
          reviewed_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", a.row.id);
      if (upErr) {
        console.error(`  ! demote failed for ${a.row.id}:`, upErr.message);
        continue;
      }
      demoted++;
    }
    console.log(`[audit] demoted ${demoted}/${anomalies.length}`);
  }
  console.log(`[audit] DONE. demoted=${demoted}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
