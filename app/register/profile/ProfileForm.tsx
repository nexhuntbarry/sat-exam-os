"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

function splitName(displayName: string): { first: string; last: string } {
  const parts = displayName.trim().split(/\s+/);
  if (parts.length <= 1) return { first: parts[0] ?? "", last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

export default function ProfileForm({ displayName }: { displayName: string }) {
  const router = useRouter();
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialName = splitName(displayName);
  const [form, setForm] = useState({
    firstName: initialName.first,
    lastName: initialName.last,
    grade: "",
    school: "",
    parentName: "",
    parentEmail: "",
    parentPhone: "",
    targetScore: "",
    currentLevel: "",
  });

  function set(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/student/complete-registration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          fullName: `${form.firstName.trim()} ${form.lastName.trim()}`.trim(),
          targetScore: form.targetScore ? parseInt(form.targetScore, 10) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong.");
        return;
      }
      setSubmitted(true);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <div className="bg-surface border border-divider shadow-xl shadow-black/40 rounded-2xl p-8 text-center space-y-4">
        <div className="text-5xl">✅</div>
        <h2 className="text-charcoal font-bold text-xl">Registration Submitted!</h2>
        <p className="text-slate-300 text-sm leading-relaxed">
          Your account is awaiting admin approval. You&apos;ll receive an email once
          approved.
        </p>
        <button
          onClick={() => router.push("/student")}
          className="mt-4 px-6 py-2.5 rounded-xl bg-warm-amber text-charcoal font-semibold text-sm hover:bg-warm-amber/90 transition-colors"
        >
          View Account Status
        </button>
      </div>
    );
  }

  const inputCls =
    "w-full bg-surface border border-divider text-charcoal placeholder:text-slate-500 rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-warm-amber/50 transition-colors";
  const labelCls = "block text-slate-200 font-medium text-sm mb-1";

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-surface border border-divider shadow-xl shadow-black/40 rounded-2xl p-6 space-y-4"
    >
      <div className="mb-2">
        <h2 className="text-charcoal font-bold text-lg">Complete Your Profile</h2>
        <p className="text-slate-400 text-xs mt-1">
          This information helps your teacher and admin set you up correctly.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>First Name *</label>
          <input
            className={inputCls}
            value={form.firstName}
            onChange={(e) => set("firstName", e.target.value)}
            placeholder="First"
            required
          />
        </div>
        <div>
          <label className={labelCls}>Last Name *</label>
          <input
            className={inputCls}
            value={form.lastName}
            onChange={(e) => set("lastName", e.target.value)}
            placeholder="Last"
            required
          />
        </div>
      </div>

      <div>
        <label className={labelCls}>Grade *</label>
        <select
          className={inputCls}
          value={form.grade}
          onChange={(e) => set("grade", e.target.value)}
          required
        >
          <option value="">Select grade</option>
          {["9", "10", "11", "12"].map((g) => (
            <option key={g} value={g}>
              Grade {g}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className={labelCls}>School *</label>
        <input
          className={inputCls}
          value={form.school}
          onChange={(e) => set("school", e.target.value)}
          placeholder="School name"
          required
        />
      </div>

      <div>
        <label className={labelCls}>Parent / Guardian Name *</label>
        <input
          className={inputCls}
          value={form.parentName}
          onChange={(e) => set("parentName", e.target.value)}
          placeholder="Parent name"
          required
        />
      </div>

      <details className="border border-divider rounded-xl px-3 py-2">
        <summary className="text-mid-gray text-sm cursor-pointer">
          Optional contact + target score
        </summary>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Parent Email</label>
            <input
              type="email"
              className={inputCls}
              value={form.parentEmail}
              onChange={(e) => set("parentEmail", e.target.value)}
              placeholder="parent@example.com"
            />
          </div>
          <div>
            <label className={labelCls}>Parent Phone</label>
            <input
              type="tel"
              className={inputCls}
              value={form.parentPhone}
              onChange={(e) => set("parentPhone", e.target.value)}
              placeholder="+1 (555) 000-0000"
            />
          </div>
        </div>
      </details>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Target SAT Score</label>
          <input
            type="number"
            min={400}
            max={1600}
            step={10}
            className={inputCls}
            value={form.targetScore}
            onChange={(e) => set("targetScore", e.target.value)}
            placeholder="400–1600"
          />
        </div>
        <div>
          <label className={labelCls}>Current Level</label>
          <select
            className={inputCls}
            value={form.currentLevel}
            onChange={(e) => set("currentLevel", e.target.value)}
          >
            <option value="">Select level</option>
            <option value="Beginner">Beginner</option>
            <option value="Intermediate">Intermediate</option>
            <option value="Advanced">Advanced</option>
          </select>
        </div>
      </div>

      {error && (
        <p className="text-status-error text-sm bg-status-error/10 border border-status-error/20 rounded-xl px-3 py-2">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full py-3 rounded-xl bg-warm-amber hover:bg-warm-amber/90 text-charcoal font-semibold text-sm disabled:opacity-60 transition-colors"
      >
        {loading ? "Submitting..." : "Submit Registration"}
      </button>
    </form>
  );
}
