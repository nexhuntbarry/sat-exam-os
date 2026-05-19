import PageIntro from "@/components/shared/PageIntro";
import { getServiceClient } from "@/lib/supabase";
import FormulaSheetSetting from "./FormulaSheetSetting";

async function getFormulaSheet() {
  const db = getServiceClient();
  const { data } = await db
    .from("app_settings")
    .select("value, updated_at")
    .eq("key", "math_formula_sheet")
    .maybeSingle();
  return {
    url: (data?.value as { url?: string } | null)?.url ?? null,
    updatedAt: data?.updated_at ?? null,
  };
}

export default async function AdminSettingsPage() {
  const formula = await getFormulaSheet();
  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <PageIntro tKey="admin.settings" />
      <h1 className="text-2xl font-bold text-charcoal">Platform settings</h1>
      <FormulaSheetSetting initialUrl={formula.url} initialUpdatedAt={formula.updatedAt} />
    </div>
  );
}
