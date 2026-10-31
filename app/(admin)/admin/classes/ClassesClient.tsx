"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, X } from "lucide-react";
import { Portal } from "@/components/ui/Portal";
import { DataRow, DataTable, EmptyRow, HeadRow, Td, Th, TwoLineCell } from "@/components/ui/data-table";

interface ClassGroup {
  id: string;
  name: string;
  campus: string | null;
  grade: string | null;
  created_at: string;
  memberCount: number;
}

function CreateModal({ onClose, onCreate }: { onClose: () => void; onCreate: () => void }) {
  const [name, setName] = useState("");
  const [campus, setCampus] = useState("");
  const [grade, setGrade] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    if (!name.trim()) {
      setError("Group name is required");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/class-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), campus: campus.trim() || undefined, grade: grade.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to create class group");
        return;
      }
      onCreate();
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  const inputCls =
    "w-full bg-surface border border-divider text-charcoal placeholder:text-soft-mute rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-warm-coral/50 transition-colors";

  return (
    <Portal>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div className="bg-surface border border-divider rounded-2xl p-6 w-full max-w-sm shadow-2xl space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-charcoal text-lg">Create Class Group</h2>
          <button onClick={onClose} className="text-soft-mute hover:text-charcoal">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-mid-gray text-sm font-medium mb-1">Group Name *</label>
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. SAT Prep A"
              required
            />
          </div>
          <div>
            <label className="block text-mid-gray text-sm font-medium mb-1">Campus</label>
            <input
              className={inputCls}
              value={campus}
              onChange={(e) => setCampus(e.target.value)}
              placeholder="e.g. Main Campus"
            />
          </div>
          <div>
            <label className="block text-mid-gray text-sm font-medium mb-1">Grade</label>
            <select
              className={inputCls}
              value={grade}
              onChange={(e) => setGrade(e.target.value)}
            >
              <option value="">— Any —</option>
              {["9", "10", "11", "12"].map((g) => (
                <option key={g} value={g}>Grade {g}</option>
              ))}
            </select>
          </div>
        </div>

        {error && (
          <p className="text-status-error text-sm bg-status-error/10 border border-status-error/20 rounded-xl px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-divider text-mid-gray hover:text-charcoal text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={loading || !name.trim()}
            className="flex-1 py-2.5 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm disabled:opacity-60 transition-colors"
          >
            {loading ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </div>
    </Portal>
  );
}

export default function ClassesClient({ classGroups }: { classGroups: ClassGroup[] }) {
  const router = useRouter();
  const [showCreate, setShowCreate] = useState(false);
  const [, startTransition] = useTransition();

  return (
    <div className="space-y-6">
      {showCreate && (
        <CreateModal
          onClose={() => setShowCreate(false)}
          onCreate={() => {
            setShowCreate(false);
            startTransition(() => router.refresh());
          }}
        />
      )}

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-charcoal">Class Groups</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm transition-colors"
        >
          <Plus size={16} />
          New Group
        </button>
      </div>

      <DataTable>
        <thead>
          <HeadRow>
            <Th kind="main" sticky="left">Class</Th>
            <Th>Grade</Th>
            <Th>Students</Th>
          </HeadRow>
        </thead>
        <tbody>
          {classGroups.length === 0 && (
            <EmptyRow colSpan={3}>No class groups yet. Create one to organize students.</EmptyRow>
          )}
          {classGroups.map((cg) => (
            <DataRow key={cg.id} href={`/admin/classes/${cg.id}`}>
              <Td kind="main" sticky="left">
                <Link href={`/admin/classes/${cg.id}`} className="block text-charcoal hover:text-warm-coral-text transition-colors">
                  <TwoLineCell main={cg.name} detail={cg.campus ?? undefined} wrapMain mainClassName="font-medium text-inherit" />
                </Link>
              </Td>
              <Td className="text-mid-gray">{cg.grade ? `Grade ${cg.grade}` : "—"}</Td>
              <Td className="text-mid-gray">
                {cg.memberCount} student{cg.memberCount !== 1 ? "s" : ""}
              </Td>
            </DataRow>
          ))}
        </tbody>
      </DataTable>
    </div>
  );
}
