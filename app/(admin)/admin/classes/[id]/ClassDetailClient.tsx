"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserMinus, UserPlus, ArrowLeft } from "lucide-react";

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

interface Props {
  classGroup: ClassGroup;
  members: Member[];
  allStudents: Student[];
}

export default function ClassDetailClient({ classGroup, members, allStudents }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [addStudentId, setAddStudentId] = useState("");
  const [loading, setLoading] = useState(false);

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

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <a
          href="/admin/classes"
          className="text-soft-mute hover:text-charcoal transition-colors"
        >
          <ArrowLeft size={20} />
        </a>
        <div>
          <h1 className="text-2xl font-bold text-charcoal">{classGroup.name}</h1>
          <p className="text-soft-mute text-sm">
            {classGroup.campus && `${classGroup.campus} · `}
            {classGroup.grade && `Grade ${classGroup.grade} · `}
            {members.length} member{members.length !== 1 ? "s" : ""}
          </p>
        </div>
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
