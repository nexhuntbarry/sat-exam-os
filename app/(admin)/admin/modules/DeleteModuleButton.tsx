"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";

export default function DeleteModuleButton({
  moduleId,
  moduleName,
  onDeleted,
}: {
  moduleId: string;
  moduleName: string;
  onDeleted?: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleDelete() {
    if (!confirm(`Delete "${moduleName}"? This will remove the module, its PDF, and all extracted questions. Cannot be undone.`)) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/modules/${moduleId}`, { method: "DELETE" });
      if (!res.ok) {
        const text = await res.text();
        alert(`Delete failed: ${text.slice(0, 200)}`);
        return;
      }
      if (onDeleted) onDeleted();
      else router.refresh();
    } catch (err) {
      alert(`Delete error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={handleDelete}
      disabled={busy}
      title="Delete module"
      className="p-2 rounded-lg text-status-error/70 hover:text-status-error hover:bg-status-error/10 disabled:opacity-40 transition-colors"
    >
      <Trash2 size={16} />
    </button>
  );
}
