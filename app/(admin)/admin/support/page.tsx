import { redirect } from "next/navigation";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { listSupportRequests } from "@/lib/support";
import SupportClient from "./SupportClient";

export default async function SupportPage() {
  const auth = await requireRole("admin");
  if (auth instanceof Response) redirect("/sign-in");
  const requests = await listSupportRequests(getServiceClient(), auth.userId);

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-charcoal">Report a Problem</h1>
        <p className="text-sm text-mid-gray mt-1">
          Something not working for a student or teacher? Describe it here and attach screenshots.
          You&apos;ll get a reply on this page (and in the bell) when we start and when it&apos;s fixed.
          Requests to add or remove a feature need Barry&apos;s approval first.
        </p>
      </div>
      <SupportClient requests={requests} />
    </div>
  );
}
