"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { nextPathAfterSwitch, switchOwnRole } from "@/components/account/SwitchRoleButton";

// Shown when someone came in through Teacher Sign In / Teacher Sign-up but
// their account is a pending STUDENT (e.g. created earlier via Student
// Register). Never convert silently — ask.
export default function RoleConfirmCard() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function chooseTeacher() {
    setBusy(true);
    setError(null);
    const err = await switchOwnRole("teacher");
    if (err) {
      setError(err);
      setBusy(false);
      return;
    }
    router.push(nextPathAfterSwitch("teacher"));
    router.refresh();
  }

  return (
    <div className="bg-surface border border-divider rounded-2xl p-6 w-full space-y-4 text-center shadow-lg shadow-black/5">
      <h2 className="font-bold text-charcoal text-lg">Sign up as a teacher?</h2>
      <p className="text-mid-gray text-sm leading-relaxed">
        This email is registered as a student account (awaiting approval). If you&rsquo;re a teacher,
        switch it to a teacher sign-up &mdash; an admin will approve it.
      </p>
      {error && (
        <p className="text-status-error text-sm bg-status-error/10 border border-status-error/20 rounded-xl px-3 py-2">
          {error}
        </p>
      )}
      <div className="flex flex-col sm:flex-row gap-3">
        <button
          onClick={() => router.push(nextPathAfterSwitch("student"))}
          disabled={busy}
          className="flex-1 py-2.5 rounded-xl border border-divider text-mid-gray hover:text-charcoal text-sm transition-colors disabled:opacity-60"
        >
          No, I&rsquo;m a student
        </button>
        <button
          onClick={chooseTeacher}
          disabled={busy}
          className="flex-1 py-2.5 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm disabled:opacity-60 transition-colors"
        >
          {busy ? "Switching…" : "Yes, I’m a teacher"}
        </button>
      </div>
    </div>
  );
}
