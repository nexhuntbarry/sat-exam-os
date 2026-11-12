"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Clock } from "lucide-react";

interface Props {
  testId: string;
  students: { id: string; name: string; email: string }[];
  /** student id → current multiplier (1.25 / 1.5 / 2). */
  initial: Record<string, number>;
  /** "section" on an ordinary section test (default: full-length wording). */
  kind?: "full_length" | "section";
  /** student id → profile testing time (1.5 / 2), used when there is no per-test row. */
  profile?: Record<string, number>;
}

const OPTIONS = [1.25, 1.5, 2] as const;

// Per-student extended time (test_time_accommodations) on a full-length SAT
// or a section test.
// Each change saves at once; it applies to attempts started afterwards.
export default function AccommodationsCard({ testId, students, initial, kind = "full_length", profile = {} }: Props) {
  const tf = useTranslations("fullLength");
  const [values, setValues] = useState<Record<string, number>>(initial);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(studentId: string, multiplier: number | null) {
    const before = values[studentId];
    setValues((v) => {
      const next = { ...v };
      if (multiplier === null) delete next[studentId];
      else next[studentId] = multiplier;
      return next;
    });
    setSaving(studentId);
    setError(null);
    const revert = () =>
      setValues((v) => {
        const next = { ...v };
        if (before === undefined) delete next[studentId];
        else next[studentId] = before;
        return next;
      });
    try {
      const res = await fetch(`/api/admin/tests/${testId}/accommodations`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId, multiplier }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? tf("saveFailed"));
        revert();
      }
    } catch {
      setError(tf("networkError"));
      revert();
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="bg-surface border border-divider rounded-2xl p-5 space-y-3">
      <div className="space-y-0.5">
        <h2 className="text-charcoal font-semibold flex items-center gap-2">
          <Clock size={15} className="text-warm-coral-text" />
          {tf("accommodationsTitle")}
        </h2>
        <p className="text-soft-mute text-xs">
          {tf(kind === "section" ? "accommodationsHintSection" : "accommodationsHint")}
        </p>
      </div>
      {students.length === 0 ? (
        <p className="text-soft-mute text-sm">{tf("noStudents")}</p>
      ) : (
        <ul className="divide-y divide-divider">
          {students.map((st) => (
            <li key={st.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="text-charcoal text-sm truncate">{st.name}</p>
                {st.email !== st.name && <p className="text-soft-mute text-xs truncate">{st.email}</p>}
              </div>
              <select
                aria-label={`${tf("accommodationsTitle")}: ${st.name}`}
                value={values[st.id] ? String(values[st.id]) : ""}
                disabled={saving === st.id}
                onChange={(e) => save(st.id, e.target.value ? Number(e.target.value) : null)}
                className="bg-surface border border-divider text-charcoal rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:border-warm-coral/50 disabled:opacity-50"
              >
                <option value="">
                  {profile[st.id] ? tf("profileTime", { m: profile[st.id] }) : tf("standardTime")}
                </option>
                {OPTIONS.map((m) => (
                  <option key={m} value={String(m)}>
                    ×{m}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}
      {saving && <p className="text-soft-mute text-xs">{tf("saving")}</p>}
      {error && <p className="text-status-error text-xs">{error}</p>}
    </div>
  );
}
