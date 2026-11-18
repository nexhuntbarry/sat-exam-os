// lib/fix-proposal.ts
//
// "No correct choice: likely typo" (Premier ticket 3e0af153): when a
// question's key matches no choice (usually a typo in a choice), two choices
// are right, two questions are merged or text is missing, a local run writes
// a proposed fix instead of picking a key. The review queue shows it as one
// decision: "Fix choice D to … and keep key D" → Accept / Edit / Reject.
//
// Stored like lib/live-fix.ts (no schema change): the proposal is JSON in
// app_settings under "fix_proposal:<question id>", and a "[fix-proposal] …"
// note puts the question in the "typo_fix" group (lib/review-queue.ts).
// Proposals are written by local runs only (no AI calls on the site).

import type { SupabaseClient } from "@supabase/supabase-js";
import { FIX_KIND_LABEL, FIX_PROPOSAL_NOTE, isFixProposalNote, removeNotes, type FixKind } from "@/lib/review-queue";

export const FIX_PROPOSAL_SETTING_PREFIX = "fix_proposal:";

export type FixField = "questionText" | "A" | "B" | "C" | "D";

export interface FixEdit {
  field: FixField;
  /** The text as stored now (a substring of the field; "" = the field is empty). */
  from: string;
  to: string;
}

export interface FixProposal {
  kind: FixKind;
  /** One line: what is wrong ("V = πr³ + 4πr², but choice D reads 4πr³ + 4πr²"). */
  summary: string;
  /** The choice that is closest to the right answer (null: none / not a choice question). */
  closestChoice: string | null;
  /** How it differs from the right answer. */
  whatDiffers: string;
  fix: FixEdit[];
  /** The key once the fix is applied. */
  keyAfterFix: string;
  /** Where the error most likely comes from. */
  origin: "source" | "extraction" | "unclear";
  createdBy: string;
  createdAt: string;
}

/** Longest `to` text accepted (characters). */
export const MAX_FIX_TEXT = 4000;

const KINDS = new Set<FixKind>(["no_correct_choice", "two_correct", "merged", "missing_text"]);
const FIELDS = new Set<FixField>(["questionText", "A", "B", "C", "D"]);
const ORIGINS = new Set(["source", "extraction", "unclear"]);

/** The proposal if `v` is a well-formed one (null otherwise). */
export function parseFixProposal(v: unknown): FixProposal | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  const str = (x: unknown) => typeof x === "string";
  if (!KINDS.has(p.kind as FixKind) || !str(p.summary) || !(p.summary as string).trim()) return null;
  if (!str(p.keyAfterFix) || !(p.keyAfterFix as string).trim() || !ORIGINS.has(p.origin as string)) return null;
  const fix = parseFixEdits(p.fix);
  if (!fix) return null;
  return {
    kind: p.kind as FixKind,
    summary: (p.summary as string).trim(),
    closestChoice: str(p.closestChoice) && (p.closestChoice as string).trim() ? (p.closestChoice as string).trim() : null,
    whatDiffers: str(p.whatDiffers) ? (p.whatDiffers as string) : "",
    fix,
    keyAfterFix: (p.keyAfterFix as string).trim(),
    origin: p.origin as FixProposal["origin"],
    createdBy: str(p.createdBy) ? (p.createdBy as string) : "unknown",
    createdAt: str(p.createdAt) ? (p.createdAt as string) : new Date(0).toISOString(),
  };
}

/** The edits if `v` is a non-empty list of well-formed ones, one per field (null otherwise). */
export function parseFixEdits(v: unknown): FixEdit[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: FixEdit[] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") return null;
    const { field, from, to } = e as Record<string, unknown>;
    if (!FIELDS.has(field as FixField) || typeof from !== "string" || typeof to !== "string") return null;
    if (from === to || out.some((x) => x.field === field)) return null;
    // A choice is never emptied; nothing longer than a question.
    if (to.length > MAX_FIX_TEXT || (field !== "questionText" && !to.trim())) return null;
    out.push({ field: field as FixField, from, to });
  }
  return out;
}

/** The "[fix-proposal] …" note (no ";" so the notes still split right). */
export function fixProposalNote(p: Pick<FixProposal, "kind" | "summary">): string {
  const summary = p.summary.replace(/[;[\]]/g, ",").replace(/\s+/g, " ").trim();
  const line = `${FIX_PROPOSAL_NOTE} ${FIX_KIND_LABEL[p.kind]}: ${summary}`;
  return line.length > 240 ? `${line.slice(0, 239)}…` : line;
}

/** The notes without the fix-proposal note. */
export function dropFixProposalNote(notes: string | null | undefined): string | null {
  return removeNotes(notes, isFixProposalNote).notes;
}

type Choice = { label?: string; text?: string; [k: string]: unknown };

/**
 * Pure: the question_text / choices after the edits. An edit whose `to` is
 * already there counts as applied (someone fixed it by hand); one whose
 * `from` is no longer there is a conflict (the question changed since).
 */
export function applyFixEdits(
  row: { question_text: string | null; choices: unknown },
  edits: FixEdit[],
): { patch: { question_text?: string; choices?: Choice[] }; conflicts: string[] } {
  const conflicts: string[] = [];
  let text = row.question_text ?? "";
  let textChanged = false;
  const choices: Choice[] = Array.isArray(row.choices) ? (row.choices as Choice[]).map((c) => ({ ...c })) : [];
  let choicesChanged = false;
  const edit = (cur: string, e: FixEdit, what: string): string | null => {
    if (e.from === "") {
      if (cur.trim() === "") return e.to;
      if (cur === e.to) return null;
    } else {
      const hasFrom = cur.includes(e.from);
      // Already fixed ("x" → "x + 1" with "x + 1" there, or the typo gone and the fix there).
      if (e.to && cur.includes(e.to) && (!hasFrom || e.to.includes(e.from))) return null;
      if (hasFrom) return cur.replace(e.from, () => e.to);
    }
    conflicts.push(`${what} no longer contains "${e.from.length > 60 ? `${e.from.slice(0, 60)}…` : e.from}"`);
    return null;
  };
  for (const e of edits) {
    if (e.field === "questionText") {
      const next = edit(text, e, "the question text");
      if (next !== null) {
        text = next;
        textChanged = true;
      }
      continue;
    }
    const c = choices.find((x) => x.label === e.field);
    if (!c) {
      conflicts.push(`there is no choice ${e.field}`);
      continue;
    }
    const next = edit(c.text ?? "", e, `choice ${e.field}`);
    if (next !== null) {
      c.text = next;
      choicesChanged = true;
    }
  }
  const patch: { question_text?: string; choices?: Choice[] } = {};
  if (textChanged) patch.question_text = text;
  if (choicesChanged) patch.choices = choices;
  return { patch, conflicts };
}

/** Plain one-line decision: "Fix choice D to … and keep key D". */
export function fixDecisionLine(p: Pick<FixProposal, "fix" | "keyAfterFix">, currentKey: string | null): string {
  const what = p.fix.map((e) => (e.field === "questionText" ? "the question text" : `choice ${e.field}`)).join(" and ");
  const key = (currentKey ?? "").trim() === p.keyAfterFix ? `keep key ${p.keyAfterFix}` : `change the key ${currentKey ?? "∅"} → ${p.keyAfterFix}`;
  return `Fix ${what} and ${key}`;
}

/**
 * Store a proposal (local runs): the app_settings row, then the
 * "[fix-proposal]" note on the question (replacing an earlier one). The
 * status is not touched. Compare-and-set on updated_at for the note.
 */
export async function saveFixProposal(
  db: SupabaseClient,
  questionId: string,
  input: Omit<FixProposal, "createdAt"> & { createdAt?: string },
): Promise<{ ok: true; proposal: FixProposal } | { ok: false; error: string }> {
  const proposal = parseFixProposal({ ...input, createdAt: input.createdAt ?? new Date().toISOString() });
  if (!proposal) return { ok: false, error: "malformed proposal" };
  const { data: q, error: readErr } = await db.from("questions").select("id, parsing_notes, updated_at").eq("id", questionId).maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!q) return { ok: false, error: "question not found" };
  const { error: setErr } = await db
    .from("app_settings")
    .upsert({ key: `${FIX_PROPOSAL_SETTING_PREFIX}${questionId}`, value: proposal, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (setErr) return { ok: false, error: setErr.message };
  const notes = [dropFixProposalNote(q.parsing_notes as string | null), fixProposalNote(proposal)].filter(Boolean).join("; ");
  let upd = db.from("questions").update({ parsing_notes: notes, updated_at: new Date().toISOString() }).eq("id", questionId);
  if (q.updated_at) upd = upd.eq("updated_at", q.updated_at);
  const { data: w, error } = await upd.select("id");
  if (error) return { ok: false, error: error.message };
  if (!w?.length) return { ok: false, error: "question changed while saving; run again" };
  return { ok: true, proposal };
}

export async function loadFixProposals(db: SupabaseClient, ids: string[]): Promise<Map<string, FixProposal>> {
  const out = new Map<string, FixProposal>();
  for (let i = 0; i < ids.length; i += 100) {
    const keys = ids.slice(i, i + 100).map((id) => `${FIX_PROPOSAL_SETTING_PREFIX}${id}`);
    const { data, error } = await db.from("app_settings").select("key, value").in("key", keys);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      const p = parseFixProposal(r.value);
      if (p) out.set((r.key as string).slice(FIX_PROPOSAL_SETTING_PREFIX.length), p);
    }
  }
  return out;
}

export async function clearFixProposal(db: SupabaseClient, id: string): Promise<void> {
  await db.from("app_settings").delete().eq("key", `${FIX_PROPOSAL_SETTING_PREFIX}${id}`);
}
