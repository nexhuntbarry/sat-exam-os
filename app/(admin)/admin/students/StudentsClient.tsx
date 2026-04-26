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
  clerk_user_id: string | null;
  last_sign_in_at: number | null;
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
    "w-full bg-surface border border-divider text-charcoal placeholder:text-soft-mute rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-warm-coral/50 transition-colors";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div className="bg-surface border border-divider rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-charcoal text-lg">Approve Student</h2>
          <button onClick={onClose} className="text-soft-mute hover:text-charcoal">
            <X size={20} />
          </button>
        </div>

        <div className="bg-surface border border-divider rounded-xl p-4 text-sm space-y-1">
          <p className="text-charcoal font-medium">{student.display_name ?? student.email}</p>
          <p className="text-soft-mute">{student.email}</p>
          {profile?.school && <p className="text-soft-mute">{profile.school}</p>}
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
          <p className="text-status-error text-sm bg-status-error/10 border border-status-error/20 rounded-xl px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex gap-3 pt-1">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-divider text-mid-gray hover:text-charcoal text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleApprove}
            disabled={loading}
            className="flex-1 py-2.5 rounded-xl bg-warm-amber hover:bg-warm-amber/90 text-charcoal font-semibold text-sm disabled:opacity-60 transition-colors"
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
        <h1 className="text-2xl font-bold text-charcoal">Students</h1>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-surface rounded-xl w-fit border border-divider">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => switchTab(t.key)}
            className={clsx(
              "px-4 py-2 rounded-lg text-sm font-medium transition-colors",
              tab === t.key
                ? "bg-warm-coral text-white"
                : "text-mid-gray hover:text-charcoal"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-soft-mute" />
        <input
          className="w-full max-w-sm bg-surface border border-divider text-charcoal placeholder:text-soft-mute rounded-xl pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:border-warm-coral/50 transition-colors"
          placeholder="Search by name, email, grade, school..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Table */}
      <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
        {filtered.length === 0 ? (
          <div className="py-16 text-center text-soft-mute text-sm">
            No {tab} students found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-divider text-soft-mute">
                  <th className="text-left px-5 py-3 font-medium">Name</th>
                  <th className="text-left px-5 py-3 font-medium">Grade</th>
                  <th className="text-left px-5 py-3 font-medium">School</th>
                  <th className="text-left px-5 py-3 font-medium">Parent</th>
                  <th className="text-left px-5 py-3 font-medium">Registered</th>
                  <th className="text-left px-5 py-3 font-medium">Last sign-in</th>
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
                      className="border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors"
                    >
                      <td className="px-5 py-3">
                        <div className="font-medium text-charcoal">
                          {student.display_name ?? "—"}
                        </div>
                        <div className="text-soft-mute text-xs">{student.email}</div>
                      </td>
                      <td className="px-5 py-3 text-mid-gray">
                        {profile?.grade ? `Grade ${profile.grade}` : "—"}
                      </td>
                      <td className="px-5 py-3 text-mid-gray">
                        {profile?.school ?? "—"}
                      </td>
                      <td className="px-5 py-3">
                        <div className="text-mid-gray">{profile?.parent_name ?? "—"}</div>
                        <div className="text-soft-mute text-xs">{profile?.parent_email ?? ""}</div>
                        <div className="text-soft-mute text-xs">{profile?.parent_phone ?? ""}</div>
                      </td>
                      <td className="px-5 py-3 text-soft-mute text-xs">
                        {new Date(student.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-5 py-3 text-soft-mute text-xs">
                        {student.last_sign_in_at
                          ? new Date(student.last_sign_in_at).toLocaleString()
                          : student.clerk_user_id
                            ? "—"
                            : <span className="text-status-warning">never (pending)</span>}
                      </td>
                      {tab === "pending" && (
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => setApproveTarget(student)}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-warm-amber/15 hover:bg-warm-amber/25 text-warm-amber text-xs font-medium transition-colors"
                            >
                              <Check size={13} />
                              Approve
                            </button>
                            <button
                              onClick={() => handleSuspend(student.id)}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-status-error/10 hover:bg-status-error/15 text-status-error text-xs font-medium transition-colors"
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
