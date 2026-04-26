"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { UserPlus, X, Mail } from "lucide-react";

interface TeacherProfile {
  assigned_classes: unknown[];
  bio: string | null;
  specialty: string | null;
}

interface Teacher {
  id: string;
  email: string;
  display_name: string | null;
  account_status: string;
  created_at: string;
  teacher_profiles: TeacherProfile | TeacherProfile[] | null;
}

function getProfile(t: Teacher): TeacherProfile | null {
  if (!t.teacher_profiles) return null;
  return Array.isArray(t.teacher_profiles) ? t.teacher_profiles[0] ?? null : t.teacher_profiles;
}

function InviteModal({ onClose, onInvited }: { onClose: () => void; onInvited: () => void }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [emailWarning, setEmailWarning] = useState<string | null>(null);
  const [resentExisting, setResentExisting] = useState(false);
  const [duplicate, setDuplicate] = useState<{ display_name: string | null; account_status: string } | null>(null);

  async function doInvite(resend = false) {
    if (!email) return;
    setLoading(true);
    setError(null);
    setEmailWarning(null);
    setDuplicate(null);
    try {
      const res = await fetch("/api/admin/teachers/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, displayName: displayName || undefined, resend }),
      });
      const data = await res.json();
      if (res.status === 409 && data.error === "exists") {
        setDuplicate(data.existingUser ?? { display_name: null, account_status: "unknown" });
        return;
      }
      if (!res.ok) {
        setError(data.error ?? "Failed to invite teacher");
        return;
      }
      if (data.emailWarning) setEmailWarning(String(data.emailWarning));
      setResentExisting(!!data.resent);
      setSuccess(true);
      setTimeout(() => { onInvited(); }, data.emailWarning ? 4000 : 1500);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }
  const handleInvite = () => doInvite(false);

  const inputCls =
    "w-full bg-surface border border-divider text-charcoal placeholder:text-soft-mute rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-warm-coral/50 transition-colors";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div className="bg-surface border border-divider rounded-2xl p-6 w-full max-w-sm shadow-2xl space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-charcoal text-lg">Invite Teacher</h2>
          <button onClick={onClose} className="text-soft-mute hover:text-charcoal">
            <X size={20} />
          </button>
        </div>

        {success ? (
          <div className="text-center py-6 space-y-3">
            {emailWarning ? (
              <>
                <div className="text-4xl">⚠️</div>
                <p className="text-charcoal font-medium">User invited but email failed</p>
                <p className="text-status-warning text-sm bg-status-warning/10 border border-status-warning/20 rounded-xl px-3 py-2 text-left">
                  {emailWarning}
                </p>
                <p className="text-soft-mute text-xs">
                  The teacher record was created. Share the sign-in link manually.
                </p>
              </>
            ) : (
              <>
                <div className="text-4xl">✉️</div>
                <p className="text-charcoal font-medium">
                  {resentExisting ? "Invite resent!" : "Invitation sent!"}
                </p>
                <p className="text-soft-mute text-sm">An email has been sent to {email}</p>
              </>
            )}
          </div>
        ) : duplicate ? (
          <div className="space-y-4">
            <div className="bg-status-warning/10 border border-status-warning/20 rounded-xl px-4 py-3">
              <p className="text-charcoal font-medium text-sm mb-1">User already exists</p>
              <p className="text-mid-gray text-xs">
                {email} is already in the system
                {duplicate.display_name ? ` as ${duplicate.display_name}` : ""}
                {` (status: ${duplicate.account_status})`}.
              </p>
            </div>
            <p className="text-mid-gray text-sm">Send invite email again?</p>
            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 py-2.5 rounded-xl border border-divider text-mid-gray hover:text-charcoal text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => doInvite(true)}
                disabled={loading}
                className="flex-1 py-2.5 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm disabled:opacity-60 transition-colors"
              >
                {loading ? "Resending..." : "Resend invite"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              <div>
                <label className="block text-slate-200 text-sm font-medium mb-1">Email *</label>
                <input
                  type="email"
                  className={inputCls}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="teacher@school.com"
                  required
                />
              </div>
              <div>
                <label className="block text-slate-200 text-sm font-medium mb-1">Display Name</label>
                <input
                  className={inputCls}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Optional"
                />
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
                onClick={handleInvite}
                disabled={loading || !email}
                className="flex-1 py-2.5 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm disabled:opacity-60 transition-colors"
              >
                {loading ? "Inviting..." : "Send Invite"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function TeachersClient({ teachers }: { teachers: Teacher[] }) {
  const router = useRouter();
  const [showInvite, setShowInvite] = useState(false);
  const [, startTransition] = useTransition();

  async function handleRemove(teacherId: string, name: string) {
    if (!confirm(`Remove ${name}? They will lose access.`)) return;
    const res = await fetch(`/api/admin/teachers/${teacherId}/remove`, { method: "POST" });
    if (res.ok) {
      startTransition(() => router.refresh());
    }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {showInvite && (
        <InviteModal
          onClose={() => setShowInvite(false)}
          onInvited={() => {
            setShowInvite(false);
            startTransition(() => router.refresh());
          }}
        />
      )}

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-charcoal">Teachers</h1>
        <button
          onClick={() => setShowInvite(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm transition-colors"
        >
          <UserPlus size={16} />
          Invite Teacher
        </button>
      </div>

      <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
        {teachers.length === 0 ? (
          <div className="py-16 text-center text-soft-mute text-sm">
            No teachers yet. Invite one to get started.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-divider text-soft-mute">
                <th className="text-left px-5 py-3 font-medium">Teacher</th>
                <th className="text-left px-5 py-3 font-medium">Specialty</th>
                <th className="text-left px-5 py-3 font-medium">Status</th>
                <th className="text-left px-5 py-3 font-medium">Invited</th>
                <th className="text-left px-5 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {teachers.map((teacher) => {
                const profile = getProfile(teacher);
                return (
                  <tr
                    key={teacher.id}
                    className="border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors"
                  >
                    <td className="px-5 py-3">
                      <div className="font-medium text-charcoal">
                        {teacher.display_name ?? "—"}
                      </div>
                      <div className="flex items-center gap-1 text-soft-mute text-xs mt-0.5">
                        <Mail size={11} />
                        {teacher.email}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-mid-gray">
                      {profile?.specialty ?? "—"}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={clsx(
                          "px-2 py-1 rounded-full text-xs font-medium",
                          teacher.account_status === "approved"
                            ? "bg-warm-amber/15 text-warm-amber"
                            : teacher.account_status === "pending"
                            ? "bg-status-warning/15 text-status-warning"
                            : "bg-status-error/15 text-status-error"
                        )}
                      >
                        {teacher.account_status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-soft-mute text-xs">
                      {new Date(teacher.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-5 py-3">
                      {teacher.account_status !== "suspended" && (
                        <button
                          onClick={() =>
                            handleRemove(teacher.id, teacher.display_name ?? teacher.email)
                          }
                          className="px-3 py-1.5 rounded-lg bg-status-error/10 hover:bg-status-error/15 text-status-error text-xs font-medium transition-colors"
                        >
                          Remove
                        </button>
                      )}
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
