// Server-only helper for the admin tests pages (create flow, full-length
// detail re-sync picker).
import { getServiceClient } from "@/lib/supabase";
import { getQaTestIds, scopeIds } from "@/lib/qa";
import { fullLengthLinksOrNone, hideChildTests } from "@/lib/full-length";
import {
  SOURCE_COLUMNS,
  defaultSectionLimits,
  testModuleIds,
  twoModuleError,
  type SourceTest,
} from "@/lib/full-length-admin";
import { allModulesApproved } from "./module-approval";

/** A section test a full-length SAT can be built from. */
export interface FullLengthSource {
  id: string;
  test_name: string;
  section: "rw" | "math";
  isAdaptive: boolean;
  /** Modules of this test that still have questions not Approved. */
  unapprovedModules: number;
  /** Module time limits to prefill. */
  limits: { m1: number; m2: number };
  /** Its module setup, to fill a section of a full-length test picked directly. */
  pick: { m1: string; m2: string; easy: string; hard: string; threshold: number };
}

// Section tests a full-length SAT can be built from: two modules, all in
// one section, on the viewer's side; never a full-length test or one of
// its sections. Approval state is shown (publishing needs it), not required.
export async function getFullLengthSources(
  viewerIsQa: boolean,
  modules: { id: string; section: string; approved: number; approvalTotal: number }[],
): Promise<FullLengthSource[]> {
  const db = getServiceClient();
  const links = await fullLengthLinksOrNone(db);
  const { data, error } = await hideChildTests(
    scopeIds(db.from("tests").select(SOURCE_COLUMNS), "id", await getQaTestIds(), viewerIsQa),
    new Set([...links.parentOf.keys(), ...links.childrenOf.keys()]),
  ).order("created_at", { ascending: false });
  if (error) {
    console.error("[admin/tests/new] full-length sources", error);
    return [];
  }
  const moduleById = new Map(modules.map((m) => [m.id, m]));
  const out: FullLengthSource[] = [];
  for (const t of (data ?? []) as unknown as SourceTest[]) {
    if (twoModuleError(t, "")) continue;
    const ids = testModuleIds(t);
    const mods = ids.map((id) => moduleById.get(id));
    if (mods.some((m) => !m)) continue;
    const sections = new Set(mods.map((m) => m!.section));
    if (sections.size !== 1) continue;
    const section = [...sections][0];
    const key = section === "Math" ? "math" : section === "Reading & Writing" ? "rw" : null;
    if (!key) continue;
    out.push({
      id: t.id,
      test_name: t.test_name,
      section: key,
      isAdaptive: Boolean(t.is_adaptive),
      unapprovedModules: ids.length - mods.filter((m) => allModulesApproved([m!])).length,
      limits: defaultSectionLimits(t, key),
      pick: {
        m1: (t.is_adaptive ? t.module_1_id : t.module_id) ?? "",
        m2: (t.is_adaptive ? null : t.module_2_id) ?? "",
        easy: (t.is_adaptive ? t.module_2_easy_id : null) ?? "",
        hard: (t.is_adaptive ? t.module_2_hard_id : null) ?? "",
        threshold: t.adaptive_threshold ?? 60,
      },
    });
  }
  return out;
}

