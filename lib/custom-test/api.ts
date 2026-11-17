// lib/custom-test/api.ts
//
// Shared by the /api/admin/custom-tests routes: admin auth + schema check,
// the eligible pool for the viewer's side, preview summaries.

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getQaUserIds } from "@/lib/qa";
import { NOT_ENABLED_MESSAGE, customTestsReady, familyQuestionIds } from "@/lib/custom-test/db";
import { BANK_COLUMNS, ineligibleReason, loadPool, partOfSection, toPoolQuestion, type BankRow, type LoadedPool } from "@/lib/custom-test/pool";
import { selectionIds, type PoolQuestion, type Selection } from "@/lib/custom-test/select";

export type Admin = { userId: string; isQa: boolean };

/** Admin only, and only once migration 0035 is in. */
export async function customTestAdmin(): Promise<{ admin: Admin; db: SupabaseClient } | NextResponse> {
  const auth = await requireRole("admin");
  if (auth instanceof NextResponse) return auth;
  const db = getServiceClient();
  if (!(await customTestsReady(db))) return NextResponse.json({ error: NOT_ENABLED_MESSAGE, code: "not_enabled" }, { status: 503 });
  return { admin: auth, db };
}

/** The pool for this admin: QA uploads only for QA admins. */
export async function poolFor(db: SupabaseClient, admin: Admin): Promise<LoadedPool> {
  return loadPool(db, { qaUploaders: admin.isQa ? new Set() : await getQaUserIds(), viewerIsQa: admin.isQa });
}

/** Earlier versions' questions when making another version (empty otherwise). */
export async function familyExclusions(db: SupabaseClient, familyId: unknown): Promise<{ ids: Set<string>; versions: number }> {
  if (typeof familyId !== "string" || !familyId) return { ids: new Set(), versions: 0 };
  return familyQuestionIds(db, familyId);
}

export interface QuestionSummary {
  id: string;
  domain: string;
  skill: string;
  difficulty: string;
  /** First words of the question (passage + stem). */
  snippet: string;
  /** "<module name> · Q12". */
  source: string;
}

/** Preview summaries for every question of a selection. */
export function summaries(pool: LoadedPool, selection: Selection): Record<string, QuestionSummary> {
  const byId = new Map(pool.questions.map((q) => [q.id, q]));
  const out: Record<string, QuestionSummary> = {};
  for (const id of selectionIds(selection)) {
    const q = byId.get(id);
    const row = pool.rows.get(id);
    const text = (row?.question_text ?? "")
      .replace(/<[^>]*>/g, " ")
      .replace(/[*_`#>|$\\]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    out[id] = {
      id,
      domain: q?.domain ?? "—",
      skill: q?.skill ?? "—",
      difficulty: q?.difficulty ?? "—",
      snippet: text.length > 160 ? `${text.slice(0, 157)}…` : text,
      source: `${row?.module_name ?? "Question"}${row?.original_question_number ? ` · Q${row.original_question_number}` : ""}`,
    };
  }
  return out;
}

/**
 * Summaries of saved questions (editing a Draft), eligible or not: one
 * that no longer is shows "(no longer eligible)" so the admin replaces it.
 */
export async function summariesFor(db: SupabaseClient, selection: Selection): Promise<Record<string, QuestionSummary>> {
  const ids = selectionIds(selection);
  if (ids.length === 0) return {};
  const { data, error } = await db.from("questions").select(`${BANK_COLUMNS}, modules(section, module_name)`).in("id", ids);
  if (error) throw new Error(`question lookup: ${error.message}`);
  type Row = BankRow & { modules: { section: string | null; module_name: string | null } | null };
  const rows = (data ?? []) as unknown as Row[];
  const questions: PoolQuestion[] = [];
  const byRow = new Map<string, BankRow & { module_name: string | null }>();
  for (const r of rows) {
    const q = toPoolQuestion(r, r.modules?.section);
    const part = partOfSection(r.section) ?? partOfSection(r.modules?.section) ?? "rw";
    questions.push(
      q ?? { id: r.id, part, domain: r.domain ?? "—", skill: `${r.skill ?? "—"} (no longer eligible: ${ineligibleReason(r) ?? "unknown"})`, difficulty: (r.difficulty ?? "Medium") as "Medium", dupKey: r.id },
    );
    byRow.set(r.id, { ...r, module_name: r.modules?.module_name ?? null });
  }
  return summaries({ questions, rows: byRow }, selection);
}

/** A selection from a request, shape-checked (contents are checked by selectionErrors). */
export function parseSelection(raw: unknown): Selection | null {
  if (!raw || typeof raw !== "object") return null;
  const parts = (raw as { parts?: unknown }).parts;
  if (!parts || typeof parts !== "object") return null;
  const out: Selection = { parts: {}, shortfalls: [] };
  for (const key of ["rw", "math"] as const) {
    const stages = (parts as Record<string, unknown>)[key];
    if (stages === undefined) continue;
    if (!Array.isArray(stages)) return null;
    out.parts[key] = [];
    for (const s of stages) {
      const k = (s as { key?: unknown })?.key;
      const ids = (s as { questionIds?: unknown })?.questionIds;
      if (!["m1", "m2", "m2_easy", "m2_hard"].includes(k as string) || !Array.isArray(ids) || ids.some((x) => typeof x !== "string")) return null;
      out.parts[key]!.push({ key: k as "m1", questionIds: (ids as string[]).slice(0, 60) });
    }
  }
  const sf = (raw as { shortfalls?: unknown }).shortfalls;
  if (Array.isArray(sf)) {
    out.shortfalls = sf
      .filter((x) => x && typeof x === "object" && typeof (x as { message?: unknown }).message === "string")
      .slice(0, 60)
      .map((x) => x as Selection["shortfalls"][number]);
  }
  return out;
}
