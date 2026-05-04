"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserMinus, UserPlus, ArrowLeft, GraduationCap, ShieldCheck, Trash2, AlertTriangle } from "lucide-react";

interface ClassGroup {
  id: string;
  name: string;
  campus: string | null;
  grade: string | null;
}

interface Member {
  id: string;
  student_id: string;
  users: {
    id: string;
    email: string;
    display_name: string | null;
    student_profiles: { grade: string | null; school: string | null } | null;
  } | null;
}

interface Student {
  id: string;
  email: string;
  display_name: string | null;
}

interface Teacher {
  id: string;
  email: string;
  display_name: string | null;
  can_review_questions: boolean;
}

interface AssignedTeacher extends Teacher {
  assigned_at: string;
}

interface Props {
  classGroup: ClassGroup;
  members: Member[];
  allStudents: Student[];
  allTeachers: Teacher[];
  assignedTeachers: AssignedTeacher[];
}

export default function ClassDetailClient({
  classGroup,
  members,
  allStudents,
  allTeachers,
  assignedTeachers,
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [addStudentId, setAddStudentId] = useState("");
  const [addTeacherId, setAddTeacherId] = useState("");
  const [loading, setLoading] = useState(false);
  const [teacherLoading, setTeacherLoading] = useState(false);

  const memberIds = new Set(members.map((m) => m.student_id));
  const nonMembers = allStudents.filter((s) => !memberIds.has(s.id));

  async function handleAction(studentId: string, action: "add" | "remove") {
    setLoading(true);
    try {
      await fetch(`/api/admin/class-groups/${classGroup.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId, action }),
      });
      startTransition(() => router.refresh());
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd() {
    if (!addStudentId) return;
    await handleAction(addStudentId, "add");
    setAddStudentId("");
  }

  const assignedTeacherIds = new Set(assignedTeachers.map((t) => t.id));
  const unassignedTeachers = allTeachers.filter((t) => !assignedTeacherIds.has(t.id));

  async function addTeacher(teacherId: string) {
    if (!teacherId) return;
    setTeacherLoading(true);
    try {
      await fetch(`/api/admin/class-groups/${classGroup.id}/teachers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teacherIds: [teacherId] }),
      });
      startTransition(() => router.refresh());
    } finally {
      setTeacherLoading(false);
    }
  }

  async function removeTeacher(teacherId: string) {
    setTeacherLoading(true);
    try {
      await fetch(`/api/admin/class-groups/${classGroup.id}/teachers`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teacherIds: [teacherId] }),
      });
      startTransition(() => router.refresh());
    } finally {
      setTeacherLoading(false);
    }
  }

  // Delete-class double-confirm flow: open a modal, require typing the
  // class name, then issue DELETE.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteText, setDeleteText] = useState("");
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteConfirmsMatch = deleteText.trim() === classGroup.name.trim();

  async function confirmDelete() {
    setDeleteError(null);
    setDeleteSubmitting(true);
    try {
      const res = await fetch(`/api/admin/class-groups/${classGroup.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setDeleteError(j.error ?? "Failed to delete");
        return;
      }
      router.push("/admin/classes");
    } catch {
      setDeleteError("Network error");
    } finally {
      setDeleteSubmitting(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <a
          href="/admin/classes"
          className="text-soft-mute hover:text-charcoal transition-colors"
        >
          <ArrowLeft size={20} />
        </a>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-charcoal">{classGroup.name}</h1>
          <p className="text-soft-mute text-sm">
            {classGroup.campus && `${classGroup.campus} · `}
            {classGroup.grade && `Grade ${classGroup.grade} · `}
            {members.length} member{members.length !== 1 ? "s" : ""}
          </p>
        </div>
        <button
          onClick={() => {
            setDeleteOpen(true);
            setDeleteText("");
            setDeleteError(null);
          }}
          className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-status-error/10 hover:bg-status-error/20 text-status-error text-sm font-medium transition-colors"
        >
          <Trash2 size={14} />
          Delete class
        </button>
      </div>

      {/* Delete-class double-confirm modal */}
      {deleteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
          <div className="bg-surface border border-divider rounded-2xl w-full max-w-md shadow-2xl">
            <div className="p-5 border-b border-divider flex items-start gap-3">
              <AlertTriangle size={20} className="text-status-error shrink-0 mt-0.5" />
              <div>
                <h3 className="font-bold text-charcoal text-base">Delete this class?</h3>
                <p className="text-mid-gray text-xs mt-0.5 leading-relaxed">
                  This permanently removes <strong>{classGroup.name}</strong> along with all
                  its student memberships ({members.length}) and teacher assignments
                  ({assignedTeachers.length}). Tests already assigned to this class are NOT
                  deleted, but their class link becomes orphan. This cannot be undone.
                </p>
              </div>
            </div>
            <div className="px-5 py-4 space-y-2">
              <label className="block text-charcoal text-sm font-medium">
                Type the class name to confirm:{" "}
                <span className="font-mono text-warm-coral">{classGroup.name}</span>
              </label>
              <input
                value={deleteText}
                onChange={(e) => setDeleteText(e.target.value)}
                className="w-full bg-light-bg border border-divider rounded-xl px-3 py-2 text-sm text-charcoal placeholder:text-soft-mute focus:outline-none focus:border-status-error/50"
                placeholder="Class name"
                autoFocus
              />
              {deleteError && (
                <p className="text-status-error text-sm">{deleteError}</p>
              )}
            </div>
            <div className="p-5 border-t border-divider flex items-center justify-end gap-2">
              <button
                onClick={() => setDeleteOpen(false)}
                className="px-4 py-2 rounded-xl border border-divider text-mid-gray hover:text-charcoal text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={!deleteConfirmsMatch || deleteSubmitting}
                className="px-4 py-2 rounded-xl bg-status-error hover:bg-status-error/90 text-white font-semibold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {deleteSubmitting ? "Deleting…" : "Delete forever"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Teachers */}
      <div className="bg-surface border border-divider rounded-2xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-charcoal font-medium text-sm flex items-center gap-2">
            <GraduationCap size={14} className="text-warm-coral" />
            Assigned Teachers
            <span className="text-soft-mute font-normal">
              ({assignedTeachers.length})
            </span>
          </h2>
          {unassignedTeachers.length > 0 && (
            <div className="flex items-center gap-2">
              <select
                className="bg-light-bg border border-divider text-charcoal rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:border-warm-coral/50"
                value={addTeacherId}
                onChange={(e) => setAddTeacherId(e.target.value)}
              >
                <option value="">Add teacher…</option>
                {unassignedTeachers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.display_name ?? t.email}
                    {t.can_review_questions ? " · Reviewer" : ""}
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  addTeacher(addTeacherId);
                  setAddTeacherId("");
                }}
                disabled={!addTeacherId || teacherLoading}
                className="px-3 py-1.5 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white text-sm font-semibold disabled:opacity-50 transition-colors"
              >
                Add
              </button>
            </div>
          )}
        </div>
        {assignedTeachers.length === 0 ? (
          <p className="text-soft-mute text-sm py-2">
            No teachers assigned yet. Add one above so they can see this class&rsquo;s students.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {assignedTeachers.map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-warm-coral/10 border border-warm-coral/20 text-sm"
              >
                {t.can_review_questions && (
                  <ShieldCheck size={11} className="text-warm-coral" />
                )}
                <span className="text-charcoal">{t.display_name ?? t.email}</span>
                <button
                  onClick={() => removeTeacher(t.id)}
                  disabled={teacherLoading}
                  className="text-soft-mute hover:text-status-error transition-colors disabled:opacity-50"
                  title="Remove from this class"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add student */}
      {nonMembers.length > 0 && (
        <div className="bg-surface border border-divider rounded-2xl p-5">
          <h2 className="text-charcoal font-medium text-sm mb-3">Add Student</h2>
          <div className="flex gap-3">
            <select
              className="flex-1 bg-surface border border-divider text-charcoal rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-warm-coral/50 transition-colors"
              value={addStudentId}
              onChange={(e) => setAddStudentId(e.target.value)}
            >
              <option value="">Select a student...</option>
              {nonMembers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.display_name ?? s.email} ({s.email})
                </option>
              ))}
            </select>
            <button
              onClick={handleAdd}
              disabled={!addStudentId || loading}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-medium text-sm disabled:opacity-60 transition-colors"
            >
              <UserPlus size={15} />
              Add
            </button>
          </div>
        </div>
      )}

      {/* Members list */}
      <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-divider">
          <h2 className="font-semibold text-charcoal">Members</h2>
        </div>
        {members.length === 0 ? (
          <div className="py-12 text-center text-soft-mute text-sm">
            No members yet. Add students above.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-soft-mute border-b border-divider">
                <th className="text-left px-5 py-3 font-medium">Student</th>
                <th className="text-left px-5 py-3 font-medium">Grade</th>
                <th className="text-left px-5 py-3 font-medium">School</th>
                <th className="text-right px-5 py-3 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const u = m.users;
                const profile = u?.student_profiles;
                return (
                  <tr
                    key={m.id}
                    className="border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors"
                  >
                    <td className="px-5 py-3">
                      <div className="font-medium text-charcoal">{u?.display_name ?? "—"}</div>
                      <div className="text-soft-mute text-xs">{u?.email}</div>
                    </td>
                    <td className="px-5 py-3 text-mid-gray">
                      {profile?.grade ? `Grade ${profile.grade}` : "—"}
                    </td>
                    <td className="px-5 py-3 text-mid-gray">{profile?.school ?? "—"}</td>
                    <td className="px-5 py-3 text-right">
                      <button
                        onClick={() => handleAction(m.student_id, "remove")}
                        disabled={loading}
                        className="flex items-center gap-1.5 ml-auto px-3 py-1.5 rounded-lg bg-status-error/10 hover:bg-status-error/15 text-status-error text-xs font-medium transition-colors disabled:opacity-50"
                      >
                        <UserMinus size={13} />
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
