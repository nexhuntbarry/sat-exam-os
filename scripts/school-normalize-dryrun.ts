/**
 * DRY-RUN: School name normalization
 *
 * Reads student_profiles, groups school name variants by similarity,
 * proposes canonical names, flags invalid/suspicious entries, and writes
 * .omc/reports/school-merge-2026-11-07.md.
 *
 * DOES NOT modify any data.
 *
 * Usage:
 *   npx tsx scripts/school-normalize-dryrun.ts
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/school-normalize-dryrun.ts
 */

import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Need NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/\s+/g, " ")
    .replace(/\b(high school|hs|h\.s\.)\b/g, "hs")
    .replace(/\b(middle school|ms|m\.s\.)\b/g, "ms")
    .replace(/\b(the|a|an)\b\s*/g, "")
    .replace(/[^\w\s]/g, "")
    .trim();
}

/** Levenshtein distance (bounded at maxDist for speed). */
function levenshtein(a: string, b: string, maxDist = 5): number {
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array(n + 1).fill(0).map((_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function isSimilar(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const dist = levenshtein(na, nb);
  return dist <= Math.max(2, Math.floor(Math.min(na.length, nb.length) * 0.2));
}

/** True if the value looks obviously invalid/bogus. */
function isInvalidEntry(s: string): { invalid: boolean; reason: string } {
  if (!s || s.trim().length === 0) return { invalid: true, reason: "empty" };
  const v = s.trim();
  if (v.length <= 1) return { invalid: true, reason: "single character" };
  if (/^\d+$/.test(v)) return { invalid: true, reason: "numeric only" };
  if (/^[^a-zA-Z]{0,3}$/.test(v)) return { invalid: true, reason: "no letters" };
  if (/^(.)\1{3,}$/.test(v)) return { invalid: true, reason: "repeated character" };
  if (/^[a-z]$/i.test(v)) return { invalid: true, reason: "single character" };
  return { invalid: false, reason: "" };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { data, error } = await db
    .from("student_profiles")
    .select("user_id, school, grade, parent_name");

  if (error) {
    console.error("Failed to fetch student_profiles:", error.message);
    process.exit(1);
  }

  const rows = data ?? [];
  console.log(`Fetched ${rows.length} student_profiles`);

  // ── 1. School grouping ──────────────────────────────────────────────────────

  // Count distinct school names (excluding null/blank)
  const schoolCounts = new Map<string, { count: number; userId: string }>();
  for (const row of rows) {
    const school = (row.school as string | null)?.trim();
    if (!school) continue;
    const existing = schoolCounts.get(school);
    if (existing) existing.count++;
    else schoolCounts.set(school, { count: 1, userId: row.user_id as string });
  }

  const allSchools = Array.from(schoolCounts.entries()).sort((a, b) => b[1].count - a[1].count);
  console.log(`Distinct school names: ${allSchools.length}`);

  // Group by similarity
  const groups: { canonical: string; variants: string[]; totalStudents: number }[] = [];
  const assigned = new Set<string>();

  for (const [school, { count }] of allSchools) {
    if (assigned.has(school)) continue;
    const group: string[] = [school];
    assigned.add(school);
    for (const [other, { count: otherCount }] of allSchools) {
      if (assigned.has(other)) continue;
      if (isSimilar(school, other)) {
        group.push(other);
        assigned.add(other);
      }
    }
    // Pick canonical: most common, or longest if tied
    const sorted = group.sort((a, b) => {
      const diff = (schoolCounts.get(b)?.count ?? 0) - (schoolCounts.get(a)?.count ?? 0);
      return diff !== 0 ? diff : b.length - a.length;
    });
    const totalStudents = group.reduce((sum, s) => sum + (schoolCounts.get(s)?.count ?? 0), 0);
    groups.push({ canonical: sorted[0], variants: sorted.slice(1), totalStudents });
  }

  const mergeGroups = groups.filter((g) => g.variants.length > 0).sort((a, b) => b.totalStudents - a.totalStudents);
  const singletons = groups.filter((g) => g.variants.length === 0);

  // ── 2. Invalid profile entries ───────────────────────────────────────────────

  type InvalidEntry = { userId: string; field: string; value: string; reason: string };
  const invalidEntries: InvalidEntry[] = [];

  for (const row of rows) {
    const school = (row.school as string | null)?.trim();
    if (school) {
      const { invalid, reason } = isInvalidEntry(school);
      if (invalid) {
        invalidEntries.push({ userId: row.user_id as string, field: "school", value: school, reason });
      }
    }

    const parentName = (row.parent_name as string | null)?.trim();
    if (parentName) {
      const { invalid, reason } = isInvalidEntry(parentName);
      if (invalid) {
        invalidEntries.push({ userId: row.user_id as string, field: "parent_name", value: parentName, reason });
      }
    }

    const grade = (row.grade as string | null)?.trim();
    if (grade) {
      // Grade should be 9–12 or empty; flag non-numeric / multi-token values
      if (!/^\d{1,2}$/.test(grade) || parseInt(grade) < 1 || parseInt(grade) > 16) {
        invalidEntries.push({ userId: row.user_id as string, field: "grade", value: grade, reason: "unexpected grade value" });
      }
    }
  }

  // ── 3. Report ───────────────────────────────────────────────────────────────

  const lines: string[] = [];
  lines.push("# School Normalization Dry-Run — 2026-11-07");
  lines.push("");
  lines.push(`**DO NOT apply without review.** This is a read-only analysis of ${allSchools.length} distinct school names across ${rows.length} student profiles.`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");

  // Summary
  lines.push("## Summary");
  lines.push("");
  lines.push(`| | Count |`);
  lines.push(`|---|---|`);
  lines.push(`| Total profiles | ${rows.length} |`);
  lines.push(`| Profiles with school set | ${schoolCounts.size > 0 ? Array.from(schoolCounts.values()).reduce((s, v) => s + v.count, 0) : 0} |`);
  lines.push(`| Distinct school names | ${allSchools.length} |`);
  lines.push(`| Groups with variants (proposed merges) | ${mergeGroups.length} |`);
  lines.push(`| Singletons (no merge needed) | ${singletons.length} |`);
  lines.push(`| Invalid/suspicious profile entries | ${invalidEntries.length} |`);
  lines.push("");

  // Merge proposals
  lines.push("## Proposed Merges");
  lines.push("");
  lines.push("These school names appear to be variants of the same school. The first entry is the proposed canonical name (most common / longest).");
  lines.push("");
  if (mergeGroups.length === 0) {
    lines.push("*No merge candidates found.*");
    lines.push("");
  } else {
    for (const group of mergeGroups) {
      lines.push(`### ${group.canonical} *(${group.totalStudents} students)*`);
      lines.push("");
      lines.push(`| Variant | Students |`);
      lines.push(`|---|---|`);
      lines.push(`| **${group.canonical}** *(proposed canonical)* | ${schoolCounts.get(group.canonical)?.count ?? 0} |`);
      for (const v of group.variants) {
        lines.push(`| ${v} | ${schoolCounts.get(v)?.count ?? 0} |`);
      }
      lines.push("");
      lines.push("```sql");
      lines.push(`-- Merge variants into canonical`);
      for (const v of group.variants) {
        lines.push(`UPDATE student_profiles SET school = '${group.canonical.replace(/'/g, "''")}' WHERE school = '${v.replace(/'/g, "''")}';`);
      }
      lines.push("```");
      lines.push("");
    }
  }

  // Invalid entries
  lines.push("## Invalid / Suspicious Profile Entries");
  lines.push("");
  lines.push("These entries likely need admin review and profile correction.");
  lines.push("");
  if (invalidEntries.length === 0) {
    lines.push("*No invalid entries found.*");
    lines.push("");
  } else {
    lines.push(`| User ID | Field | Value | Reason |`);
    lines.push(`|---|---|---|---|`);
    for (const e of invalidEntries) {
      lines.push(`| \`${e.userId}\` | ${e.field} | \`${e.value}\` | ${e.reason} |`);
    }
    lines.push("");
  }

  // All singletons (for reference)
  lines.push("## Singletons (no merge candidate)");
  lines.push("");
  lines.push("<details><summary>Show all singletons</summary>");
  lines.push("");
  lines.push("| School | Students |");
  lines.push("|---|---|");
  for (const g of singletons.sort((a, b) => b.totalStudents - a.totalStudents)) {
    lines.push(`| ${g.canonical} | ${g.totalStudents} |`);
  }
  lines.push("");
  lines.push("</details>");
  lines.push("");

  const reportPath = join(process.cwd(), ".omc/reports/school-merge-2026-11-07.md");
  mkdirSync(join(process.cwd(), ".omc/reports"), { recursive: true });
  writeFileSync(reportPath, lines.join("\n"), "utf-8");
  console.log(`Report written to: ${reportPath}`);
  console.log(`  ${mergeGroups.length} merge groups | ${invalidEntries.length} invalid entries`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
