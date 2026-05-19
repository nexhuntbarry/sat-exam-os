"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { ShieldCheck, UserPlus, X, Mail, Lock, Check, Pause, Trash2, AlertTriangle } from "lucide-react";
import { formatDate, formatDateTime } from "@/lib/datetime";

interface Admin {
  id: string;
  email: string;
  display_name: string | null;
  account_status: string;
  created_at: string;
  clerk_user_id: string | null;
  is_super_admin: boolean;
  last_sign_in_at: number | null;
}

interface Props {
  admins: Admin[];
  currentUserId: string | null;
  canInvite: boolean;
}

function InviteModal({ onClose, onInvited }: { onClose: () => void; onInvited: () => void }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [emailWarning, setEmailWarning] = useState<string | null>(null);
  const [resentExisting, setResentExisting] = useState(false);
  const [duplicate, setDuplicate] = useState<{ display_name: string | null; account_status: string; role?: string } | null>(null);

  async function doInvite(resend = false) {
    if (!email) return;
    setLoading(true);
    setError(null);
    setEmailWarning(null);
    setDuplicate(null);
    try {
      const res = await fetch("/api/admin/admins/invite", {
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
        setError(data.error ?? "Failed to invite admin");
        return;
      }
      if (data.emailWarning) setEmailWarning(String(data.emailWarning));
      setResentExisting(!!data.resent);
      setSuccess(true);
      setTimeout(() => onInvited(), data.emailWarning ? 4000 : 1500);
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
      <div className="bg-surface border border-divider rounded-2xl p-6 w-full max-w-sm shadow-2xl space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-charcoal text-lg">Invite Admin</h2>
          <button onClick={onClose} className="text-soft-mute hover:text-charcoal">
            <X size={20} />
          </button>
        </div>

        <p className="text-mid-gray text-xs bg-warm-amber/10 border border-warm-amber/20 rounded-lg px-3 py-2 leading-relaxed">
          New admins get full admin permissions but cannot invite other admins.
          Only super admins can do that.
        </p>

        {success ? (
          <div className="text-center py-6 space-y-3">
            {emailWarning ? (
              <>
                <div className="text-4xl">⚠️</div>
                <p className="text-charcoal font-medium">Admin invited but email failed</p>
                <p className="text-status-warning text-sm bg-status-warning/10 border border-status-warning/20 rounded-xl px-3 py-2 text-left">
                  {emailWarning}
                </p>
                <p className="text-soft-mute text-xs">
                  The admin record was created. Share the sign-in link manually.
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
                {duplicate.role ? ` (${duplicate.role})` : ""}
                {` · status: ${duplicate.account_status}`}.
              </p>
            </div>
            <p className="text-mid-gray text-sm">Promote to admin and resend invite email?</p>
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
                <label className="block text-charcoal text-sm font-medium mb-1">Email *</label>
                <input
                  type="email"
                  className={inputCls}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@example.com"
                  required
                />
              </div>
              <div>
                <label className="block text-charcoal text-sm font-medium mb-1">Display Name</label>
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
                onClick={() => doInvite(false)}
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

export default function AdminsClient({ admins, currentUserId, canInvite }: Props) {
  const router = useRouter();
  const [showInvite, setShowInvite] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Admin | null>(null);
  const [deleteText, setDeleteText] = useState("");
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // canInvite is the super-admin gate from the page; reuse it for the
  // approve / suspend / delete buttons since the same permission applies.
  const isSuper = canInvite;

  async function callAction(adminId: string, action: "approve" | "suspend") {
    setActingId(`${adminId}:${action}`);
    try {
      const res = await fetch(`/api/admin/admins/${adminId}/${action}`, {
        method: "POST",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(j.error ?? "Action failed");
        return;
      }
      startTransition(() => router.refresh());
    } finally {
      setActingId(null);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleteError(null);
    setDeleteSubmitting(true);
    try {
      const res = await fetch(`/api/admin/admins/${deleteTarget.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setDeleteError(j.error ?? "Failed to delete");
        return;
      }
      setDeleteTarget(null);
      setDeleteText("");
      startTransition(() => router.refresh());
    } catch {
      setDeleteError("Network error");
    } finally {
      setDeleteSubmitting(false);
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
        <div>
          <h1 className="text-2xl font-bold text-charcoal">Admins</h1>
          <p className="text-soft-mute text-sm mt-1">
            {canInvite
              ? "You're a super admin. You can invite new admins."
              : "Only super admins can invite new admins."}
          </p>
        </div>
        {canInvite ? (
          <button
            onClick={() => setShowInvite(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm transition-colors"
          >
            <UserPlus size={16} />
            Invite Admin
          </button>
        ) : (
          <span
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-divider text-soft-mute text-sm"
            title="Ask a super admin to invite new admins"
          >
            <Lock size={14} />
            Invite restricted
          </span>
        )}
      </div>

      <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
        {admins.length === 0 ? (
          <div className="py-16 text-center text-soft-mute text-sm">
            No admins yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-divider text-soft-mute">
                <th className="text-left px-5 py-3 font-medium">Admin</th>
                <th className="text-left px-5 py-3 font-medium">Tier</th>
                <th className="text-left px-5 py-3 font-medium">Status</th>
                <th className="text-left px-5 py-3 font-medium">Created</th>
                <th className="text-left px-5 py-3 font-medium">Last sign-in</th>
                {isSuper && (
                  <th className="text-left px-5 py-3 font-medium">Actions</th>
                )}
              </tr>
            </thead>
            <tbody>
              {admins.map((a) => {
                const isMe = a.id === currentUserId;
                return (
                  <tr
                    key={a.id}
                    className="border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors"
                  >
                    <td className="px-5 py-3">
                      <div className="font-medium text-charcoal">
                        {a.display_name ?? "—"}
                        {isMe && (
                          <span className="ml-2 text-xs text-soft-mute font-normal">(you)</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 text-soft-mute text-xs mt-0.5">
                        <Mail size={11} />
                        {a.email}
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      {a.is_super_admin ? (
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-warm-coral/15 text-warm-coral">
                          <ShieldCheck size={11} />
                          Super
                        </span>
                      ) : (
                        <span className="px-2 py-1 rounded-full text-xs font-medium bg-light-bg text-mid-gray">
                          Admin
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={clsx(
                          "px-2 py-1 rounded-full text-xs font-medium",
                          a.account_status === "approved"
                            ? "bg-warm-amber/15 text-warm-amber"
                            : a.account_status === "pending"
                            ? "bg-status-warning/15 text-status-warning"
                            : "bg-status-error/15 text-status-error",
                        )}
                      >
                        {a.account_status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-soft-mute text-xs">
                      {formatDate(a.created_at)}
                    </td>
                    <td className="px-5 py-3 text-soft-mute text-xs">
                      {a.last_sign_in_at
                        ? formatDateTime(a.last_sign_in_at)
                        : a.clerk_user_id
                        ? "—"
                        : <span className="text-status-warning">never (pending)</span>}
                    </td>
                    {isSuper && (
                      <td className="px-5 py-3">
                        {isMe ? (
                          <span className="text-soft-mute text-xs italic">—</span>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            {a.account_status === "approved" ? (
                              <button
                                onClick={() => callAction(a.id, "suspend")}
                                disabled={actingId === `${a.id}:suspend`}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-status-warning/15 hover:bg-status-warning/25 text-status-warning text-xs font-medium transition-colors disabled:opacity-50"
                                title="Block this admin from signing in"
                              >
                                <Pause size={11} />
                                Suspend
                              </button>
                            ) : (
                              <button
                                onClick={() => callAction(a.id, "approve")}
                                disabled={actingId === `${a.id}:approve`}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-warm-amber/15 hover:bg-warm-amber/25 text-warm-amber text-xs font-medium transition-colors disabled:opacity-50"
                                title={
                                  a.account_status === "pending"
                                    ? "Mark this admin as approved"
                                    : "Reactivate this admin"
                                }
                              >
                                <Check size={11} />
                                {a.account_status === "pending" ? "Approve" : "Reactivate"}
                              </button>
                            )}
                            <button
                              onClick={() => {
                                setDeleteTarget(a);
                                setDeleteText("");
                                setDeleteError(null);
                              }}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-status-error/10 hover:bg-status-error/20 text-status-error text-xs font-medium transition-colors"
                              title="Permanently remove this admin"
                            >
                              <Trash2 size={11} />
                              Delete
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Delete-admin double-confirm */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
          <div className="bg-surface border border-divider rounded-2xl w-full max-w-md shadow-2xl">
            <div className="p-5 border-b border-divider flex items-start gap-3">
              <AlertTriangle size={20} className="text-status-error shrink-0 mt-0.5" />
              <div>
                <h3 className="font-bold text-charcoal text-base">
                  Delete this admin?
                </h3>
                <p className="text-mid-gray text-xs mt-0.5 leading-relaxed">
                  This permanently removes <strong>{deleteTarget.display_name ?? deleteTarget.email}</strong>
                  {" "}({deleteTarget.email}) from the platform along with their session.
                  This cannot be undone. If you only want to block sign-in temporarily, use
                  Suspend instead.
                </p>
              </div>
            </div>
            <div className="px-5 py-4 space-y-2">
              <label className="block text-charcoal text-sm font-medium">
                Type the admin&rsquo;s email to confirm:{" "}
                <span className="font-mono text-warm-coral">{deleteTarget.email}</span>
              </label>
              <input
                value={deleteText}
                onChange={(e) => setDeleteText(e.target.value)}
                className="w-full bg-light-bg border border-divider rounded-xl px-3 py-2 text-sm text-charcoal placeholder:text-soft-mute focus:outline-none focus:border-status-error/50"
                placeholder="email@example.com"
                autoFocus
              />
              {deleteError && (
                <p className="text-status-error text-sm">{deleteError}</p>
              )}
            </div>
            <div className="p-5 border-t border-divider flex items-center justify-end gap-2">
              <button
                onClick={() => {
                  setDeleteTarget(null);
                  setDeleteText("");
                }}
                className="px-4 py-2 rounded-xl border border-divider text-mid-gray hover:text-charcoal text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={
                  deleteText.trim() !== deleteTarget.email.trim() || deleteSubmitting
                }
                className="px-4 py-2 rounded-xl bg-status-error hover:bg-status-error/90 text-white font-semibold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {deleteSubmitting ? "Deleting…" : "Delete forever"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
