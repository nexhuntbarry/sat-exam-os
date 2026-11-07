import Link from "next/link";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { scanKeyTypeMismatch } from "@/lib/key-check";
import KeyCheckList from "./KeyCheckList";

export const dynamic = "force-dynamic";
// Scans the whole question bank (read-only).
export const maxDuration = 60;

export default async function KeyCheckPage() {
  const auth = await requireRole("admin");
  if (auth instanceof Response) redirect("/sign-in");
  const findings = await scanKeyTypeMismatch(getServiceClient());

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-soft-mute">
        <Link href="/admin/questions" className="hover:text-charcoal">Question Bank</Link>
        <span>/</span>
        <span className="text-charcoal">Answer key check</span>
      </div>
      <h1 className="text-2xl font-bold text-charcoal">Answer key check</h1>
      <p className="max-w-3xl text-sm text-mid-gray">
        Questions whose answer key doesn&rsquo;t fit the question type: a fill-in (SPR) question with a letter key or a
        value students can&rsquo;t enter, a fill-in key that ignores &ldquo;round to the nearest …&rdquo;, leftover choices on a
        fill-in question, a Multiple choice key that isn&rsquo;t A–D, and AI-solved keys whose own explanation ends on a
        different answer. <strong>Apply</strong> first shows every student attempt the change would regrade (old → new
        score); nothing is rescored until you confirm. Questions in a live test stay Approved and get a [live-fix] note.
      </p>
      <KeyCheckList findings={findings} canApply={!auth.isQa} />
    </div>
  );
}
