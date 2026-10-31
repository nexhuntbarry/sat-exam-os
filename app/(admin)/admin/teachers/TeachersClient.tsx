"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import { UserPlus, X, ShieldCheck, UserX } from "lucide-react";
import { formatDateTime, formatShortDate, formatShortDateTime } from "@/lib/datetime";
import {
  DataRow,
  DataTable,
  DetailItem,
  EmptyRow,
  ExpandToggle,
  HeadRow,
  RowActions,
  RowActionsMenu,
  Td,
  Th,
  TruncatedText,
  TwoLineCell,
  type RowAction,
} from "@/components/ui/data-table";
import { Portal } from "@/components/ui/Portal";

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
  clerk_user_id: string | null;
  last_sign_in_at: number | null;
  can_review_questions: boolean;
  teacher_profiles: TeacherProfile | TeacherProfile[] | null;
}

function getProfile(t: Teacher): TeacherProfile | null {
  if (!t.teacher_profiles) return null;
  return Array.isArray(t.teacher_profiles) ? t.teacher_profiles[0] ?? null : t.teacher_profiles;
}

function InviteModal({ onClose, onInvited }: { onClose: () => void; onInvited: () => void }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [canReview, setCanReview] = useState(false);
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
        body: JSON.stringify({
          email,
          displayName: displayName || undefined,
          resend,
          canReviewQuestions: canReview,
        }),
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
    <Portal>
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
                <label className="block text-mid-gray text-sm font-medium mb-1">Email *</label>
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
                <label className="block text-mid-gray text-sm font-medium mb-1">Display Name</label>
                <input
                  className={inputCls}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Optional"
                />
              </div>
              <label className="flex items-start gap-2.5 cursor-pointer rounded-xl border border-divider bg-warm-coral/5 px-3 py-2.5 hover:border-warm-coral/40 transition-colors">
                <input
                  type="checkbox"
                  checked={canReview}
                  onChange={(e) => setCanReview(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-warm-coral"
                />
                <span className="text-xs leading-relaxed">
                  <span className="block font-semibold text-charcoal mb-0.5">
                    Allow this teacher to review &amp; edit answers
                  </span>
                  <span className="text-mid-gray">
                    Key teachers can approve, reject, and resolve mismatches in the question
                    bank. Leave off for regular teachers.
                  </span>
                </span>
              </label>
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
    </Portal>
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

  async function handleToggleReviewer(teacherId: string, current: boolean) {
    const res = await fetch(`/api/admin/teachers/${teacherId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ canReviewQuestions: !current }),
    });
    if (res.ok) {
      startTransition(() => router.refresh());
    }
  }

  return (
    <div className="space-y-6">
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

      <DataTable>
        <thead>
          <HeadRow>
            <Th kind="main" sticky="left">Teacher</Th>
            <Th>Status</Th>
            <Th priority="md">Reviewer</Th>
            <Th kind="long" priority="lg" className="w-[18%]">Specialty</Th>
            <Th priority="lg">Activity</Th>
            <Th kind="actions" sticky="right"><span className="sr-only">Actions</span></Th>
          </HeadRow>
        </thead>
        <tbody>
          {teachers.length === 0 && (
            <EmptyRow colSpan={6}>No teachers yet. Invite one to get started.</EmptyRow>
          )}
          {teachers.map((teacher) => {
            const profile = getProfile(teacher);
            const name = teacher.display_name ?? teacher.email;
            const lastSignIn = teacher.last_sign_in_at
              ? formatShortDateTime(teacher.last_sign_in_at)
              : null;
            const lastSignInFull = teacher.last_sign_in_at
              ? formatDateTime(teacher.last_sign_in_at)
              : null;
            const activityMain = lastSignIn ?? (
              teacher.clerk_user_id
                ? "Never signed in"
                : <span className="text-status-warning">never (pending)</span>
            );
            const activityDetail = `Invited ${formatShortDate(teacher.created_at)}`;
            const activityTitle = `${lastSignInFull ? `Last sign-in ${lastSignInFull}` : "Never signed in"} · Invited ${formatDateTime(teacher.created_at)}`;

            const actions: (RowAction | false)[] = [
              teacher.can_review_questions
                ? {
                    label: "Revoke reviewer",
                    icon: ShieldCheck,
                    onSelect: () => handleToggleReviewer(teacher.id, true),
                  }
                : {
                    label: "Grant reviewer",
                    icon: ShieldCheck,
                    onSelect: () => handleToggleReviewer(teacher.id, false),
                  },
              teacher.account_status !== "suspended" && {
                label: "Remove…",
                icon: UserX,
                tone: "danger",
                onSelect: () => handleRemove(teacher.id, name),
              },
            ];

            return (
              <DataRow
                key={teacher.id}
                href={`/admin/teachers/${teacher.id}`}
                expandBelow="xl"
                colSpan={6}
                details={
                  <>
                    <DetailItem label="Reviewer" priority="md">
                      {teacher.can_review_questions ? "Reviewer" : "Off"}
                    </DetailItem>
                    <DetailItem label="Specialty" priority="lg">
                      {profile?.specialty ?? "—"}
                    </DetailItem>
                    <DetailItem label="Activity" priority="lg">
                      <span title={activityTitle}>
                        {lastSignIn ?? (teacher.clerk_user_id ? "Never signed in" : "never (pending)")}
                        {" · "}
                        {activityDetail}
                      </span>
                    </DetailItem>
                  </>
                }
              >
                <Td kind="main" sticky="left">
                  <Link
                    href={`/admin/teachers/${teacher.id}`}
                    className="block hover:text-warm-coral-text transition-colors"
                  >
                    <TwoLineCell
                      main={teacher.display_name ?? "—"}
                      detail={teacher.email}
                      mainClassName="font-medium text-inherit"
                    />
                  </Link>
                </Td>
                <Td>
                  <span
                    className={clsx(
                      "px-2 py-0.5 rounded-full text-xs font-medium capitalize",
                      teacher.account_status === "approved"
                        ? "bg-warm-amber/15 text-warm-amber"
                        : teacher.account_status === "pending"
                        ? "bg-status-warning/15 text-status-warning"
                        : "bg-status-error/15 text-status-error",
                    )}
                  >
                    {teacher.account_status}
                  </span>
                </Td>
                <Td priority="md">
                  <span
                    className={clsx(
                      "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium",
                      teacher.can_review_questions
                        ? "bg-warm-coral/15 text-warm-coral-text"
                        : "bg-light-bg text-mid-gray",
                    )}
                  >
                    <ShieldCheck size={11} />
                    {teacher.can_review_questions ? "Reviewer" : "Off"}
                  </span>
                </Td>
                <Td kind="long" priority="lg" className="text-mid-gray">
                  <TruncatedText>{profile?.specialty ?? "—"}</TruncatedText>
                </Td>
                <Td priority="lg">
                  <span className="block" title={activityTitle}>
                    <span className="block text-mid-gray">{activityMain}</span>
                    <span className="block text-xs text-soft-mute">{activityDetail}</span>
                  </span>
                </Td>
                <Td kind="actions" sticky="right">
                  <RowActions>
                    <ExpandToggle label={`More about ${name}`} />
                    <RowActionsMenu label={`Actions for ${name}`} items={actions} />
                  </RowActions>
                </Td>
              </DataRow>
            );
          })}
        </tbody>
      </DataTable>
    </div>
  );
}
