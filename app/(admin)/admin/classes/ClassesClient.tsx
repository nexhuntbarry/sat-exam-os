"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, X, Users } from "lucide-react";

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
    if (!name) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/class-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, campus: campus || undefined, grade: grade || undefined }),
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
    "w-full bg-deep-navy border border-white/15 text-white placeholder:text-soft-gray/30 rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-electric-blue/50 transition-colors";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div className="bg-[#0F1A3A] border border-white/10 rounded-2xl p-6 w-full max-w-sm shadow-2xl space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-white text-lg">Create Class Group</h2>
          <button onClick={onClose} className="text-soft-gray/50 hover:text-soft-gray">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-slate-200 text-sm font-medium mb-1">Group Name *</label>
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. SAT Prep A"
              required
            />
          </div>
          <div>
            <label className="block text-slate-200 text-sm font-medium mb-1">Campus</label>
            <input
              className={inputCls}
              value={campus}
              onChange={(e) => setCampus(e.target.value)}
              placeholder="e.g. Main Campus"
            />
          </div>
          <div>
            <label className="block text-slate-200 text-sm font-medium mb-1">Grade</label>
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
          <p className="text-rose text-sm bg-rose/10 border border-rose/20 rounded-xl px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-white/15 text-soft-gray/70 hover:text-soft-gray text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={loading || !name}
            className="flex-1 py-2.5 rounded-xl bg-electric-blue hover:bg-electric-blue/90 text-white font-semibold text-sm disabled:opacity-60 transition-colors"
          >
            {loading ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ClassesClient({ classGroups }: { classGroups: ClassGroup[] }) {
  const router = useRouter();
  const [showCreate, setShowCreate] = useState(false);
  const [, startTransition] = useTransition();

  return (
    <div className="max-w-5xl mx-auto space-y-6">
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
        <h1 className="text-2xl font-bold text-white">Class Groups</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-electric-blue hover:bg-electric-blue/90 text-white font-semibold text-sm transition-colors"
        >
          <Plus size={16} />
          New Group
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {classGroups.length === 0 ? (
          <div className="col-span-full py-16 text-center text-soft-gray/40 text-sm bg-white/3 border border-white/8 rounded-2xl">
            No class groups yet. Create one to organize students.
          </div>
        ) : (
          classGroups.map((cg) => (
            <a
              key={cg.id}
              href={`/admin/classes/${cg.id}`}
              className="block bg-white/3 border border-white/8 rounded-2xl p-5 hover:bg-white/5 hover:border-white/15 transition-all group"
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-white group-hover:text-electric-blue transition-colors">
                    {cg.name}
                  </h3>
                  {cg.campus && (
                    <p className="text-soft-gray/50 text-xs mt-0.5">{cg.campus}</p>
                  )}
                </div>
                {cg.grade && (
                  <span className="px-2 py-1 rounded-full bg-electric-blue/15 text-electric-blue text-xs font-medium">
                    Grade {cg.grade}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 text-soft-gray/60 text-sm">
                <Users size={14} />
                <span>{cg.memberCount} student{cg.memberCount !== 1 ? "s" : ""}</span>
              </div>
            </a>
          ))
        )}
      </div>
    </div>
  );
}
