"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { X } from "lucide-react";
import { Portal } from "@/components/ui/Portal";

type Role = "student" | "teacher" | "admin";

const DEST: Record<Role, (id: string) => string> = {
  student: (id) => `/admin/students/${id}`,
  teacher: (id) => `/admin/teachers/${id}`,
  admin: () => "/admin/admins",
};

function warning(from: Role, to: Role, attemptCount: number | undefined): string {
  if (from === "student") {
    const attempts =
      attemptCount === undefined
        ? "Their past test attempts"
        : `Their ${attemptCount} past test attempt${attemptCount === 1 ? "" : "s"}`;
    return `${attempts} stay saved but won't appear in student lists. They'll be removed from their classes.${
      to === "admin" ? " They'll get full admin access." : ""
    }`;
  }
  if (to === "admin") {
    return "They'll be removed from the classes they teach and get full admin access.";
  }
  return "They'll be removed from the classes they teach. Tests they created stay.";
}

/**
 * Admin "Change role…" dialog (POST /api/admin/users/[id]/role). Admin is
 * offered only to super admins (the API enforces it too). On success it
 * navigates to the user's page under the new role.
 */
export default function ChangeRoleDialog({
  userId,
  name,
  from,
  isSuperAdmin,
  attemptCount,
  onClose,
}: {
  userId: string;
  name: string;
  from: "student" | "teacher";
  isSuperAdmin: boolean;
  /** Student → other: number of past test attempts, shown in the warning. */
  attemptCount?: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const options: Role[] = [from === "student" ? "teacher" : "student", ...(isSuperAdmin ? (["admin"] as const) : [])];
  const [to, setTo] = useState<Role>(options[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${userId}/role`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: to }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(j.error ?? "Failed to change role");
        setBusy(false);
        return;
      }
      router.push(DEST[to](userId));
      router.refresh();
    } catch {
      setError("Network error");
      setBusy(false);
    }
  }

  const label = (r: Role) => r.charAt(0).toUpperCase() + r.slice(1);

  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
        <div className="bg-surface border border-divider rounded-2xl p-6 w-full max-w-sm shadow-2xl space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-bold text-charcoal text-lg">Change role</h2>
              <p className="text-soft-mute text-xs mt-0.5">
                {name} · currently {label(from)}
              </p>
            </div>
            <button onClick={onClose} className="text-soft-mute hover:text-charcoal" aria-label="Close">
              <X size={20} />
            </button>
          </div>

          <div className="flex gap-2">
            {options.map((r) => (
              <button
                key={r}
                onClick={() => setTo(r)}
                className={clsx(
                  "flex-1 px-3.5 py-2 rounded-xl text-sm font-medium border transition-colors",
                  to === r
                    ? "bg-warm-coral text-white border-warm-coral"
                    : "bg-surface border-divider text-mid-gray hover:text-charcoal",
                )}
              >
                {label(r)}
              </button>
            ))}
          </div>

          <p className="text-mid-gray text-sm bg-status-warning/10 border border-status-warning/20 rounded-xl px-3 py-2 leading-relaxed">
            {warning(from, to, attemptCount)} The account will be active (approved) as a {label(to).toLowerCase()}.
          </p>

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
              onClick={submit}
              disabled={busy}
              className="flex-1 py-2.5 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm disabled:opacity-60 transition-colors"
            >
              {busy ? "Changing…" : `Make ${label(to).toLowerCase()}`}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
