"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Ban, ClipboardList, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { RowActionsMenu } from "@/components/ui/data-table";
import { Portal } from "@/components/ui/Portal";
import SearchablePicker, { type PickerItem } from "@/components/ui/SearchablePicker";
import DeleteStudentButton from "./DeleteStudentButton";
import { changeStudentStatus } from "./StudentStatusButton";

interface Props {
  studentId: string;
  studentName: string;
  email: string;
  status: string;
  /** Classes on the viewer's side; alreadyIn = current class_group_members. */
  classItems: PickerItem[];
  /** Tests on the viewer's side; alreadyIn = already assigned to the student. */
  testItems: PickerItem[];
}

// POSTs `ids` one by one; collects the names of the ones that failed.
async function postEach(
  ids: string[],
  items: PickerItem[],
  request: (id: string) => Promise<Response>,
): Promise<{ ok: boolean; error?: string }> {
  const failed: string[] = [];
  for (const id of ids) {
    const name = items.find((i) => i.id === id)?.label ?? id;
    try {
      const res = await request(id);
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        failed.push(j.error ? `${name} (${j.error})` : name);
      }
    } catch {
      failed.push(`${name} (network error)`);
    }
  }
  return failed.length === 0 ? { ok: true } : { ok: false, error: `Failed: ${failed.join(", ")}` };
}

// Header "⋯": Add to class / Assign test (same API routes as the Students
// page's row menu), then Suspend / Reactivate, Delete (type-the-email
// confirmation) last in red. Edit profile and the PDF report stay as visible
// buttons next to it.
export default function StudentActionsMenu({ studentId, studentName, email, status, classItems, testItems }: Props) {
  const t = useTranslations("studentDetail");
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [picker, setPicker] = useState<"class" | "test" | null>(null);
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

  async function addToClasses(ids: string[]) {
    const result = await postEach(ids, classItems, (classId) =>
      fetch(`/api/admin/class-groups/${classId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId, action: "add" }),
      }),
    );
    startTransition(() => router.refresh());
    if (result.ok) setPicker(null);
    return result;
  }

  async function assignTests(ids: string[]) {
    const result = await postEach(ids, testItems, (testId) =>
      fetch(`/api/admin/tests/${testId}/add-students`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentIds: [studentId] }),
      }),
    );
    startTransition(() => router.refresh());
    if (result.ok) setPicker(null);
    return result;
  }

  return (
    <span className="inline-flex items-center gap-1">
      {error && <span className="text-status-error text-xs">{error}</span>}
      <RowActionsMenu
        label={t("moreActions")}
        items={[
          {
            label: t("addToClass"),
            icon: Plus,
            // The members route rejects suspended students.
            disabled: status === "suspended",
            onSelect: () => setPicker("class"),
          },
          { label: t("assignTest"), icon: ClipboardList, onSelect: () => setPicker("test") },
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
      {picker && (
        <Portal>
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
            <div className="bg-surface border border-divider rounded-2xl w-full max-w-md shadow-2xl">
              <div className="flex items-center justify-between p-5 border-b border-divider">
                <div>
                  <h2 className="font-bold text-charcoal text-lg">
                    {(picker === "class" ? t("addToClass") : t("assignTest")).replace(/…$/, "")}
                  </h2>
                  <p className="text-soft-mute text-xs mt-0.5">{studentName}</p>
                </div>
                <button onClick={() => setPicker(null)} className="text-soft-mute hover:text-charcoal" aria-label="Close">
                  <X size={20} />
                </button>
              </div>
              <div className="p-5 min-h-[18rem]">
                {picker === "class" ? (
                  <SearchablePicker
                    items={classItems}
                    noun="class"
                    nounPlural="classes"
                    alreadyInLabel="already a member"
                    onAdd={addToClasses}
                  />
                ) : (
                  <SearchablePicker
                    items={testItems}
                    noun="test"
                    alreadyInLabel="already assigned"
                    onAdd={assignTests}
                  />
                )}
              </div>
            </div>
          </div>
        </Portal>
      )}
    </span>
  );
}
