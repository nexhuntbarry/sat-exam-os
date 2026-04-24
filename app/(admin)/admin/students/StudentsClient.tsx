"use client";

import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { clsx } from "clsx";
import { Check, X, Search, ChevronDown } from "lucide-react";

interface StudentProfile {
  grade: string | null;
  school: string | null;
  campus: string | null;
  class_group: string | null;
  parent_name: string | null;
  parent_email: string | null;
  parent_phone: string | null;
  target_score: number | null;
  current_level: string | null;
  status_reason: string | null;
}

interface Student {
  id: string;
  email: string;
  display_name: string | null;
  account_status: string;
  created_at: string;
  student_profiles: StudentProfile | StudentProfile[] | null;
}

interface ClassGroup {
  id: string;
  name: string;
  campus: string | null;
  grade: string | null;
}

interface Props {
  students: Student[];
  classGroups: ClassGroup[];
  tab: string;
}

function getProfile(s: Student): StudentProfile | null {
  if (!s.student_profiles) return null;
  return Array.isArray(s.student_profiles) ? s.student_profiles[0] ?? null : s.student_profiles;
}

function ApproveModal({
  student,
  classGroups,
  onClose,
  onApproved,
}: {
  student: Student;
  classGroups: ClassGroup[];
  onClose: () => void;
  onApproved: () => void;
}) {
  const profile = getProfile(student);
  const [campus, setCampus] = useState(profile?.campus ?? "");
  const [classGroupId, setClassGroupId] = useState("");
  const [grade, setGrade] = useState(profile?.grade ?? "");
  const [targetScore, setTargetScore] = useState(
    profile?.target_score?.toString() ?? ""
  );
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleApprove() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/students/${student.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campus: campus || undefined,
          classGroupId: classGroupId || undefined,
          grade: grade || undefined,
          targetScore: targetScore ? parseInt(targetScore, 10) : undefined,
          notes: notes || undefined,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Failed to approve");
        return;
      }
      onApproved();
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
      <div className="bg-[#0F1A3A] border border-white/10 rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-white text-lg">Approve Student</h2>
          <button onClick={onClose} className="text-soft-gray/50 hover:text-soft-gray">
            <X size={20} />
          </button>
        </div>

        <div className="bg-white/3 border border-white/8 rounded-xl p-4 text-sm space-y-1">
          <p className="text-white font-medium">{student.display_name ?? student.email}</p>
          <p className="text-soft-gray/50">{student.email}</p>
          {profile?.school && <p className="text-soft-gray/50">{profile.school}</p>}
        </div>

        <div className="space-y-3">
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
            <label className="block text-slate-200 text-sm font-medium mb-1">Class Group</label>
            <select
              className={inputCls}
              value={classGroupId}
              onChange={(e) => setClassGroupId(e.target.value)}
            >
              <option value="">— None —</option>
              {classGroups.map((cg) => (
                <option key={cg.id} value={cg.id}>
                  {cg.name}{cg.campus ? ` (${cg.campus})` : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-200 text-sm font-medium mb-1">Grade</label>
              <select
                className={inputCls}
                value={grade}
                onChange={(e) => setGrade(e.target.value)}
              >
                <option value="">—</option>
                {["9", "10", "11", "12"].map((g) => (
                  <option key={g} value={g}>Grade {g}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-slate-200 text-sm font-medium mb-1">Target Score</label>
              <input
                type="number"
                min={400}
                max={1600}
                step={10}
                className={inputCls}
                value={targetScore}
                onChange={(e) => setTargetScore(e.target.value)}
                placeholder="400–1600"
              />
            </div>
          </div>

          <div>
            <label className="block text-slate-200 text-sm font-medium mb-1">Notes</label>
            <textarea
              className={`${inputCls} resize-none`}
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes for this student"
            />
          </div>
        </div>

        {error && (
          <p className="text-rose text-sm bg-rose/10 border border-rose/20 rounded-xl px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex gap-3 pt-1">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-white/15 text-soft-gray/70 hover:text-soft-gray text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleApprove}
            disabled={loading}
            className="flex-1 py-2.5 rounded-xl bg-lime-green hover:bg-lime-green/90 text-deep-navy font-semibold text-sm disabled:opacity-60 transition-colors"
          >
            {loading ? "Approving..." : "Approve"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function StudentsClient({ students, classGroups, tab }: Props) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [approveTarget, setApproveTarget] = useState<Student | null>(null);
  const [, startTransition] = useTransition();

  function switchTab(t: string) {
    router.push(`/admin/students?tab=${t}`);
  }

  async function handleSuspend(studentId: string) {
    const reason = prompt("Reason for suspension (optional):");
    const res = await fetch(`/api/admin/students/${studentId}/suspend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason ?? "" }),
    });
    if (res.ok) {
      startTransition(() => router.refresh());
    }
  }

  const filtered = students.filter((s) => {
    const q = search.toLowerCase();
    if (!q) return true;
    const profile = getProfile(s);
    return (
      (s.display_name ?? "").toLowerCase().includes(q) ||
      s.email.toLowerCase().includes(q) ||
      (profile?.grade ?? "").includes(q) ||
      (profile?.school ?? "").toLowerCase().includes(q) ||
      (profile?.campus ?? "").toLowerCase().includes(q)
    );
  });

  const tabs = [
    { key: "pending", label: "Pending" },
    { key: "approved", label: "Approved" },
    { key: "suspended", label: "Suspended" },
  ];

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {approveTarget && (
        <ApproveModal
          student={approveTarget}
          classGroups={classGroups}
          onClose={() => setApproveTarget(null)}
          onApproved={() => {
            setApproveTarget(null);
            startTransition(() => router.refresh());
          }}
        />
      )}

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Students</h1>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-white/3 rounded-xl w-fit border border-white/8">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => switchTab(t.key)}
            className={clsx(
              "px-4 py-2 rounded-lg text-sm font-medium transition-colors",
              tab === t.key
                ? "bg-electric-blue text-white"
                : "text-soft-gray/60 hover:text-soft-gray"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-soft-gray/40" />
        <input
          className="w-full max-w-sm bg-white/3 border border-white/8 text-soft-gray placeholder:text-soft-gray/30 rounded-xl pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:border-electric-blue/50 transition-colors"
          placeholder="Search by name, email, grade, school..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Table */}
      <div className="bg-white/3 border border-white/8 rounded-2xl overflow-hidden">
        {filtered.length === 0 ? (
          <div className="py-16 text-center text-soft-gray/40 text-sm">
            No {tab} students found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/8 text-soft-gray/50">
                  <th className="text-left px-5 py-3 font-medium">Name</th>
                  <th className="text-left px-5 py-3 font-medium">Grade</th>
                  <th className="text-left px-5 py-3 font-medium">School</th>
                  <th className="text-left px-5 py-3 font-medium">Parent</th>
                  <th className="text-left px-5 py-3 font-medium">Registered</th>
                  {tab === "pending" && (
                    <th className="text-left px-5 py-3 font-medium">Actions</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {filtered.map((student) => {
                  const profile = getProfile(student);
                  return (
                    <tr
                      key={student.id}
                      className="border-b border-white/5 last:border-0 hover:bg-white/2 transition-colors"
                    >
                      <td className="px-5 py-3">
                        <div className="font-medium text-white">
                          {student.display_name ?? "—"}
                        </div>
                        <div className="text-soft-gray/50 text-xs">{student.email}</div>
                      </td>
                      <td className="px-5 py-3 text-soft-gray/70">
                        {profile?.grade ? `Grade ${profile.grade}` : "—"}
                      </td>
                      <td className="px-5 py-3 text-soft-gray/70">
                        {profile?.school ?? "—"}
                      </td>
                      <td className="px-5 py-3">
                        <div className="text-soft-gray/70">{profile?.parent_name ?? "—"}</div>
                        <div className="text-soft-gray/40 text-xs">{profile?.parent_email ?? ""}</div>
                        <div className="text-soft-gray/40 text-xs">{profile?.parent_phone ?? ""}</div>
                      </td>
                      <td className="px-5 py-3 text-soft-gray/50 text-xs">
                        {new Date(student.created_at).toLocaleDateString()}
                      </td>
                      {tab === "pending" && (
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => setApproveTarget(student)}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-lime-green/15 hover:bg-lime-green/25 text-lime-green text-xs font-medium transition-colors"
                            >
                              <Check size={13} />
                              Approve
                            </button>
                            <button
                              onClick={() => handleSuspend(student.id)}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose/10 hover:bg-rose/20 text-rose text-xs font-medium transition-colors"
                            >
                              <X size={13} />
                              Reject
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
