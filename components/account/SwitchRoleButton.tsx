"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Self-service role switch for a PENDING account (POST /api/account/role).
 * → teacher lands on /dashboard (the teacher pending screen);
 * → student goes to /register/profile to fill in the student profile.
 */
export async function switchOwnRole(to: "student" | "teacher"): Promise<string | null> {
  try {
    const res = await fetch("/api/account/role", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: to }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      return j.error ?? "Failed to change role";
    }
    return null;
  } catch {
    return "Network error";
  }
}

export function nextPathAfterSwitch(to: "student" | "teacher") {
  return to === "teacher" ? "/dashboard" : "/register/profile";
}

export default function SwitchRoleButton({ to }: { to: "student" | "teacher" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    const label = to === "teacher" ? "a teacher" : "a student";
    if (!confirm(`Switch your sign-up to ${label}? An admin will still need to approve your account.`)) return;
    setBusy(true);
    setError(null);
    const err = await switchOwnRole(to);
    if (err) {
      setError(err);
      setBusy(false);
      return;
    }
    router.push(nextPathAfterSwitch(to));
    router.refresh();
  }

  return (
    <div className="flex flex-col items-center gap-2 text-sm">
      <p className="text-soft-mute">
        Signed up with the wrong role?{" "}
        <button
          onClick={run}
          disabled={busy}
          className="text-warm-coral-text hover:text-warm-coral-dark font-semibold underline disabled:opacity-50"
        >
          {busy ? "Switching…" : to === "teacher" ? "I'm a teacher" : "I'm a student"}
        </button>
      </p>
      {error && <p className="text-status-error text-xs">{error}</p>}
    </div>
  );
}
