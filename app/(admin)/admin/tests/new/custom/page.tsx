import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { getQaTestIds, onSide } from "@/lib/qa";
import { fullLengthEnabledFor } from "@/lib/full-length-admin";
import { NOT_ENABLED_MESSAGE, customTestStarted, customTestsReady, loadCustomTest, selectionFromOwners } from "@/lib/custom-test/db";
import { summariesFor } from "@/lib/custom-test/api";
import CustomTestBuilder, { type BuilderStart } from "./CustomTestBuilder";

export const dynamic = "force-dynamic";

// Custom test builder (plan .omc/plans/custom-test.md): Tests → New →
// Custom test. ?edit=<id> changes a Draft's questions (until a student
// starts); ?from=<id> is "Make another version" (same rules, none of the
// earlier versions' questions).
export default async function NewCustomTestPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; from?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") redirect("/sign-in");
  const db = getServiceClient();
  const { edit, from } = await searchParams;

  if (!(await customTestsReady(db))) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <a href="/admin/tests/new" className="text-sm text-soft-mute hover:text-charcoal">← Create Test</a>
        <div role="status" className="bg-surface border border-divider rounded-2xl p-6">
          <h1 className="text-lg font-semibold text-charcoal">Custom test</h1>
          <p className="mt-2 text-sm text-mid-gray">{NOT_ENABLED_MESSAGE}</p>
        </div>
      </div>
    );
  }

  const fullLengthEnabled = await fullLengthEnabledFor(db, { isQa: user.isQa });
  let start: BuilderStart = { mode: "new" };
  const sourceId = edit ?? from;
  if (sourceId) {
    const qaTests = await getQaTestIds();
    const loaded = onSide(sourceId, qaTests, user.isQa) ? await loadCustomTest(db, sourceId) : null;
    if (!loaded) redirect("/admin/tests/new/custom");
    const rules = loaded.test.custom_rules!;
    if (edit) {
      const ownerIds = Object.values(loaded.owners).flatMap((o) => (o ? [o.id] : []));
      const locked = loaded.test.status !== "Draft" || (await customTestStarted(db, sourceId, ownerIds));
      const selection = selectionFromOwners(rules, loaded.owners);
      start = {
        mode: "edit",
        testId: sourceId,
        name: loaded.test.test_name,
        rules,
        selection,
        questions: await summariesFor(db, selection),
        locked: locked
          ? loaded.test.status !== "Draft"
            ? "Only a Draft's questions can be changed. Move the test back to Draft first."
            : "Students have already started this test, so its questions are locked. Make another version instead."
          : null,
      };
    } else {
      start = {
        mode: "version",
        name: `${loaded.test.test_name.replace(/ \(v\d+\)$/, "")} (v${(rules.version ?? 1) + 1})`,
        rules,
        familyId: rules.family_id,
      };
    }
  }

  return <CustomTestBuilder start={start} fullLengthEnabled={fullLengthEnabled} />;
}
