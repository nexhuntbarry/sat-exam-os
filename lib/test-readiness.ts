// lib/test-readiness.ts
//
// Can this test be published (Draft → Published, or Closed → Published)?
// One place for the rules the publish and reopen routes enforce and the
// Tests list shows before publishing (support 93e0f09e):
//   - a full-length SAT section is published through its parent;
//   - an ordinary test needs at least one module, a full-length test both
//     sections with two modules each (fullLengthPublishModules);
//   - every module must be fully approved: at least one Approved question
//     and none still Draft / Needs Review (Rejected ones don't count) —
//     students only see Approved questions.
// Not being assigned to anyone is only a warning: the publish route has
// never required it, and the UI asks for an extra confirm instead.
// Kept free of next/server so the unit tests can load it.
import type { SupabaseClient } from "@supabase/supabase-js";
import { FL_SECTIONS, fullLengthPublishModules, fullLengthStarted, loadChildTests } from "./full-length-admin";

export interface ModuleApproval {
  id: string;
  name: string;
  /** Where the module sits in the test: "Module 2", "R&W Module 1"… */
  label: string;
  /** Questions still Draft / Needs Review. */
  pending: number;
  approved: number;
}

export interface ReadinessIssue {
  code: "fl_section" | "no_modules" | "shape" | "questions_pending" | "no_questions" | "unassigned";
  message: string;
  /** Where to fix it. */
  href?: string;
  moduleId?: string;
}

export interface ReadinessInput {
  /** A full-length SAT section (published with its parent). */
  isFlSection: boolean;
  /** Full-length shape problem (missing section, one-module section). */
  shapeError: string | null;
  /** Every module the test serves, after shape checks passed. */
  modules: ModuleApproval[];
  /** Distinct students reached (direct + class members) and classes. */
  students: number;
  classes: number;
}

export interface Readiness {
  canPublish: boolean;
  /** Hard stops: the server refuses while any is present. */
  blockers: ReadinessIssue[];
  /** Overridable after an extra confirm. */
  warnings: ReadinessIssue[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Pure readiness rules (unit-tested). */
export function publishReadiness(input: ReadinessInput): Readiness {
  const blockers: ReadinessIssue[] = [];
  if (input.isFlSection) {
    blockers.push({ code: "fl_section", message: "This is a section of a full-length SAT — publish the full-length test instead." });
  } else if (input.shapeError) {
    blockers.push({ code: "shape", message: input.shapeError });
  } else if (input.modules.length === 0) {
    blockers.push({ code: "no_modules", message: "No module selected" });
  } else {
    for (const m of input.modules) {
      if (m.pending > 0) {
        blockers.push({
          code: "questions_pending",
          message: `${plural(m.pending, "question")} still in review (${m.label})`,
          href: "/admin/review-queue",
          moduleId: m.id,
        });
      } else if (m.approved === 0) {
        blockers.push({
          code: "no_questions",
          message: `${m.label} has no approved questions`,
          href: `/admin/modules/${m.id}`,
          moduleId: m.id,
        });
      }
    }
  }
  const warnings: ReadinessIssue[] =
    input.students === 0 && input.classes === 0
      ? [{ code: "unassigned", message: "Not assigned to anyone yet" }]
      : [];
  return { canPublish: blockers.length === 0, blockers, warnings };
}

/** "1 class · 4 students" (zeros left out); "No one" when empty. */
export function audienceText(classes: number, students: number): string {
  const parts = [classes ? plural(classes, "class", "classes") : null, students ? plural(students, "student") : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No one";
}

/** Server error text for a refused publish / reopen. */
export function blockersMessage(blockers: ReadinessIssue[]): string {
  return blockers.map((b) => b.message).join("; ");
}

// ------------------------------------------------------------------ loaders

const SLOTS = [
  ["module_id", "Module 1"],
  ["module_2_id", "Module 2"],
  ["module_1_id", "Module 1"],
  ["module_2_easy_id", "Module 2 (easier)"],
  ["module_2_hard_id", "Module 2 (harder)"],
] as const;

type ModuleRow = Partial<Record<(typeof SLOTS)[number][0], string | null>>;

/** Module ids of a row with their labels, first label wins on duplicates. */
function labelled(row: ModuleRow, prefix = "", only?: Set<string>): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  for (const [col, label] of SLOTS) {
    const id = row[col];
    if (!id || out.some((x) => x.id === id) || (only && !only.has(id))) continue;
    out.push({ id, label: `${prefix}${label}` });
  }
  return out;
}

/**
 * Per-module approval counts (the moduleApprovalError rule). Throws on a
 * lookup error so callers fail closed.
 */
export async function moduleApprovals(
  db: SupabaseClient,
  mods: { id: string; label: string }[],
): Promise<ModuleApproval[]> {
  const ids = Array.from(new Set(mods.map((m) => m.id)));
  if (ids.length === 0) return [];
  const [pending, approved, names] = await Promise.all([
    db.from("questions").select("module_id").in("module_id", ids).not("parsing_status", "in", "(Approved,Rejected)"),
    db.from("questions").select("module_id").in("module_id", ids).eq("parsing_status", "Approved"),
    db.from("modules").select("id, module_name").in("id", ids),
  ]);
  if (pending.error || approved.error) throw new Error("Could not verify module question status");
  const count = (rows: { module_id: unknown }[] | null, id: string) => (rows ?? []).filter((r) => r.module_id === id).length;
  return mods.map((m) => ({
    id: m.id,
    label: m.label,
    name: ((names.data ?? []) as { id: string; module_name: string | null }[]).find((n) => n.id === m.id)?.module_name ?? m.id,
    pending: count(pending.data, m.id),
    approved: count(approved.data, m.id),
  }));
}

export interface TestReadiness extends Readiness {
  testId: string;
  testName: string;
  status: string;
  openDate: string | null;
  dueDate: string | null;
  students: number;
  classes: number;
  audience: string;
  /** Any submission / full-length attempt exists (blocks "Back to draft"). */
  hasSubmissions: boolean;
}

/**
 * Everything the publish confirm needs, loaded with the service client.
 * Returns null when the test doesn't exist. Throws on a lookup error.
 */
export async function loadTestReadiness(db: SupabaseClient, testId: string): Promise<TestReadiness | null> {
  const { data: test, error } = await db
    .from("tests")
    .select("id, test_name, status, open_date, due_date, test_kind, parent_test_id, module_id, module_2_id, module_1_id, module_2_easy_id, module_2_hard_id")
    .eq("id", testId)
    .maybeSingle();
  if (error) throw new Error(`test lookup failed: ${error.message}`);
  if (!test) return null;

  const isFlSection = Boolean(test.parent_test_id) || test.test_kind === "fl_section";
  let shapeError: string | null = null;
  let mods: { id: string; label: string }[] = [];
  let childIds: string[] = [];
  if (!isFlSection && test.test_kind === "full_length") {
    const { children, error: loadErr } = await loadChildTests(db, testId);
    if (loadErr) throw new Error(loadErr);
    childIds = Object.values(children).flatMap((c) => (c ? [c.id] : []));
    const { moduleIds, error: shapeErr } = fullLengthPublishModules(children);
    shapeError = shapeErr;
    if (!shapeErr) {
      const only = new Set(moduleIds);
      for (const s of FL_SECTIONS) {
        const prefix = s.key === "rw" ? "R&W " : "Math ";
        mods.push(...labelled(children[s.key] as ModuleRow, prefix, only));
      }
    }
  } else if (!isFlSection) {
    mods = labelled(test as ModuleRow);
  }
  const modules = isFlSection || shapeError ? [] : await moduleApprovals(db, mods);

  const { data: asg, error: asgErr } = await db
    .from("test_assignments")
    .select("student_ids, class_group_ids")
    .eq("test_id", testId)
    .maybeSingle();
  if (asgErr) throw new Error(`assignment lookup failed: ${asgErr.message}`);
  const classIds = ((asg?.class_group_ids ?? []) as string[]).filter(Boolean);
  const studentIds = new Set(((asg?.student_ids ?? []) as string[]).filter(Boolean));
  if (classIds.length > 0) {
    const { data: members, error: memErr } = await db
      .from("class_group_members")
      .select("student_id")
      .in("class_group_id", classIds);
    if (memErr) throw new Error(`class members lookup failed: ${memErr.message}`);
    for (const m of members ?? []) studentIds.add(m.student_id as string);
  }

  const hasSubmissions = await testHasSubmissions(db, testId, test.test_kind === "full_length" ? childIds : null);

  const r = publishReadiness({ isFlSection, shapeError, modules, students: studentIds.size, classes: classIds.length });
  return {
    ...r,
    testId,
    testName: test.test_name as string,
    status: test.status as string,
    openDate: (test.open_date as string | null) ?? null,
    dueDate: (test.due_date as string | null) ?? null,
    students: studentIds.size,
    classes: classIds.length,
    audience: audienceText(classIds.length, studentIds.size),
    hasSubmissions,
  };
}

/**
 * Has anyone started this test? Full-length parents (pass their child ids):
 * rows on a section or an attempt. Throws on a lookup error.
 */
export async function testHasSubmissions(db: SupabaseClient, testId: string, flChildIds: string[] | null): Promise<boolean> {
  if (flChildIds) {
    const { started, error } = await fullLengthStarted(db, testId, flChildIds);
    if (error) throw new Error(error);
    return started;
  }
  const { data, error } = await db.from("submissions").select("id").eq("test_id", testId).limit(1);
  if (error) throw new Error(`submissions lookup failed: ${error.message}`);
  return (data ?? []).length > 0;
}
