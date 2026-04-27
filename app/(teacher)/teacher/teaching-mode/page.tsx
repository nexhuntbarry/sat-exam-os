import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import PageIntro from "@/components/shared/PageIntro";
import { Presentation } from "lucide-react";
import TeachingModeClient from "./TeachingModeClient";

export default async function TeachingModePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageIntro tKey="teacher.teachingMode" />

      <div className="flex items-center gap-3">
        <div className="p-2 rounded-xl bg-warm-coral/15">
          <Presentation size={20} className="text-warm-coral" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-charcoal">Teaching Mode</h1>
          <p className="text-soft-mute text-sm mt-0.5">
            Test review on the left, weakest skill drill on the right —
            everything you need to walk into class.
          </p>
        </div>
        <div className="ml-auto">
          <Link
            href="/teacher/tests"
            className="text-warm-coral text-sm hover:underline"
          >
            All tests
          </Link>
        </div>
      </div>

      <TeachingModeClient />
    </div>
  );
}
