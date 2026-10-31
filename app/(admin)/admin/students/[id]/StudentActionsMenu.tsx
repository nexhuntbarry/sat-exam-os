"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Ban, RotateCcw, Trash2 } from "lucide-react";
import { RowActionsMenu } from "@/components/ui/data-table";
import DeleteStudentButton from "./DeleteStudentButton";
import { changeStudentStatus } from "./StudentStatusButton";

interface Props {
  studentId: string;
  studentName: string;
  email: string;
  status: string;
}

// Header "⋯" for the rarer, risky actions: Suspend / Reactivate on top,
// Delete (type-the-email confirmation) last in red. Edit profile and the PDF
// report stay as visible buttons next to it.
export default function StudentActionsMenu({ studentId, studentName, email, status }: Props) {
  const t = useTranslations("studentDetail");
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function toggleStatus() {
    setError(null);
    const result = await changeStudentStatus({ studentId, studentName, status });
    if (!result) return;
    if (!result.ok) {
      setError(result.error);
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <span className="inline-flex items-center gap-1">
      {error && <span className="text-status-error text-xs">{error}</span>}
      <RowActionsMenu
        label={t("moreActions")}
        items={[
          status === "approved" && { label: t("suspend"), icon: Ban, onSelect: toggleStatus },
          status === "suspended" && { label: t("reactivate"), icon: RotateCcw, onSelect: toggleStatus },
          { label: t("deleteStudent"), icon: Trash2, tone: "danger", onSelect: () => setDeleting(true) },
        ]}
      />
      <DeleteStudentButton
        studentId={studentId}
        studentName={studentName}
        email={email}
        open={deleting}
        onClose={() => setDeleting(false)}
      />
    </span>
  );
}
