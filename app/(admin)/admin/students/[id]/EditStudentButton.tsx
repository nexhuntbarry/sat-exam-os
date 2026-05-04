"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, X, AlertTriangle } from "lucide-react";

interface StudentEditable {
  id: string;
  display_name: string | null;
  email: string;
  grade: string | null;
  school: string | null;
  campus: string | null;
  class_group: string | null;
  target_score: number | null;
  current_level: string | null;
  parent_name: string | null;
  parent_email: string | null;
  parent_phone: string | null;
  notes: string | null;
}

interface Props {
  student: StudentEditable;
}

export default function EditStudentButton({ student }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<StudentEditable>({ ...student });

  const inputCls =
    "w-full bg-light-bg border border-divider text-charcoal placeholder:text-soft-mute rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-warm-coral/50 transition-colors";

  // Track which fields actually changed so the confirm dialog can name them.
  const changes: Array<{ label: string; from: string; to: string }> = [];
  function diff(label: string, before: unknown, after: unknown) {
    const a = before == null || before === "" ? "—" : String(before);
    const b = after == null || after === "" ? "—" : String(after);
    if (a !== b) changes.push({ label, from: a, to: b });
  }
  diff("Name", student.display_name, form.display_name);
  diff("Email", student.email, form.email);
  diff("Grade", student.grade, form.grade);
  diff("School", student.school, form.school);
  diff("Campus", student.campus, form.campus);
  diff("Class group", student.class_group, form.class_group);
  diff("Target score", student.target_score, form.target_score);
  diff("Level", student.current_level, form.current_level);
  diff("Parent name", student.parent_name, form.parent_name);
  diff("Parent email", student.parent_email, form.parent_email);
  diff("Parent phone", student.parent_phone, form.parent_phone);
  diff("Notes", student.notes, form.notes);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/students/${student.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: form.display_name ?? "",
          email: form.email ?? "",
          grade: form.grade,
          school: form.school,
          campus: form.campus,
          class_group: form.class_group,
          target_score: form.target_score,
          current_level: form.current_level,
          parent_name: form.parent_name,
          parent_email: form.parent_email,
          parent_phone: form.parent_phone,
          notes: form.notes,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? "Failed to save");
        return;
      }
      setConfirming(false);
      setOpen(false);
      router.refresh();
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-4 py-2 rounded-xl bg-warm-coral/10 border border-warm-coral/20 text-warm-coral text-sm font-semibold hover:bg-warm-coral/20 transition-colors"
      >
        <Pencil size={14} />
        Edit profile
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-surface border border-divider rounded-2xl w-full max-w-2xl shadow-2xl max-h-[88vh] flex flex-col">
            <div className="flex items-center justify-between p-5 border-b border-divider">
              <h2 className="font-bold text-charcoal text-lg">Edit student profile</h2>
              <button
                onClick={() => {
                  setOpen(false);
                  setForm({ ...student });
                }}
                className="text-soft-mute hover:text-charcoal"
              >
                <X size={20} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-soft-mute mb-1">Display name</label>
                  <input
                    className={inputCls}
                    value={form.display_name ?? ""}
                    onChange={(e) => setForm({ ...form, display_name: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs text-soft-mute mb-1">Email</label>
                  <input
                    type="email"
                    className={inputCls}
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs text-soft-mute mb-1">Grade</label>
                  <input
                    className={inputCls}
                    value={form.grade ?? ""}
                    onChange={(e) => setForm({ ...form, grade: e.target.value })}
                    placeholder="e.g. 10"
                  />
                </div>
                <div>
                  <label className="block text-xs text-soft-mute mb-1">School</label>
                  <input
                    className={inputCls}
                    value={form.school ?? ""}
                    onChange={(e) => setForm({ ...form, school: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs text-soft-mute mb-1">Campus</label>
                  <input
                    className={inputCls}
                    value={form.campus ?? ""}
                    onChange={(e) => setForm({ ...form, campus: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs text-soft-mute mb-1">Class group</label>
                  <input
                    className={inputCls}
                    value={form.class_group ?? ""}
                    onChange={(e) => setForm({ ...form, class_group: e.target.value })}
                    placeholder="Class name (legacy free-text field)"
                  />
                </div>
                <div>
                  <label className="block text-xs text-soft-mute mb-1">Target score</label>
                  <input
                    type="number"
                    min={400}
                    max={1600}
                    className={inputCls}
                    value={form.target_score ?? ""}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        target_score: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                  />
                </div>
                <div>
                  <label className="block text-xs text-soft-mute mb-1">Level</label>
                  <select
                    className={inputCls}
                    value={form.current_level ?? ""}
                    onChange={(e) => setForm({ ...form, current_level: e.target.value || null })}
                  >
                    <option value="">—</option>
                    <option value="Beginner">Beginner</option>
                    <option value="Intermediate">Intermediate</option>
                    <option value="Advanced">Advanced</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-soft-mute mb-1">Parent name</label>
                  <input
                    className={inputCls}
                    value={form.parent_name ?? ""}
                    onChange={(e) => setForm({ ...form, parent_name: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs text-soft-mute mb-1">Parent email</label>
                  <input
                    type="email"
                    className={inputCls}
                    value={form.parent_email ?? ""}
                    onChange={(e) => setForm({ ...form, parent_email: e.target.value })}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs text-soft-mute mb-1">Parent phone</label>
                  <input
                    className={inputCls}
                    value={form.parent_phone ?? ""}
                    onChange={(e) => setForm({ ...form, parent_phone: e.target.value })}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs text-soft-mute mb-1">Notes (private to admin / teacher)</label>
                  <textarea
                    className={inputCls}
                    rows={3}
                    value={form.notes ?? ""}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  />
                </div>
              </div>
            </div>

            <div className="p-5 border-t border-divider flex items-center justify-between gap-3">
              <span className="text-xs text-soft-mute">
                {changes.length === 0
                  ? "No changes yet"
                  : `${changes.length} field${changes.length === 1 ? "" : "s"} changed`}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setOpen(false);
                    setForm({ ...student });
                  }}
                  className="px-4 py-2 rounded-xl border border-divider text-mid-gray hover:text-charcoal text-sm transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => setConfirming(true)}
                  disabled={changes.length === 0}
                  className="px-4 py-2 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm transition-colors disabled:opacity-50"
                >
                  Review &amp; save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Double-confirm modal */}
      {confirming && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
          <div className="bg-surface border border-divider rounded-2xl w-full max-w-md shadow-2xl">
            <div className="p-5 border-b border-divider flex items-start gap-3">
              <AlertTriangle size={20} className="text-status-warning shrink-0 mt-0.5" />
              <div>
                <h3 className="font-bold text-charcoal text-base">Confirm changes?</h3>
                <p className="text-mid-gray text-xs mt-0.5">
                  These changes will apply immediately. Email changes also update sign-in
                  identity — make sure it&rsquo;s correct.
                </p>
              </div>
            </div>
            <div className="px-5 py-4 max-h-64 overflow-y-auto">
              <ul className="space-y-2 text-sm">
                {changes.map((c, i) => (
                  <li key={i} className="flex flex-col gap-0.5 border-b border-divider pb-2 last:border-0">
                    <span className="text-xs text-soft-mute">{c.label}</span>
                    <span className="text-charcoal">
                      <span className="text-status-error line-through mr-2">{c.from}</span>
                      <span className="text-warm-coral font-semibold">→ {c.to}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            {error && (
              <p className="px-5 pb-2 text-status-error text-sm">{error}</p>
            )}
            <div className="p-5 border-t border-divider flex items-center justify-end gap-2">
              <button
                onClick={() => setConfirming(false)}
                className="px-4 py-2 rounded-xl border border-divider text-mid-gray hover:text-charcoal text-sm transition-colors"
              >
                Back
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="px-4 py-2 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm transition-colors disabled:opacity-50"
              >
                {saving ? "Saving…" : "Confirm save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
