"use client";

import { useState, useEffect } from "react";
import { User, Save } from "lucide-react";

interface Profile {
  grade: string | null;
  school: string | null;
  target_score: number | null;
  class_group: string | null;
}

const inputCls =
  "w-full bg-deep-navy border border-white/15 text-white placeholder:text-soft-gray/30 rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-electric-blue/50 transition-colors";

export default function StudentProfilePage() {
  const [profile, setProfile] = useState<Profile>({ grade: "", school: "", target_score: null, class_group: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/student/profile")
      .then((r) => r.json())
      .then((data) => {
        if (data && !data.error) setProfile(data);
      })
      .catch(() => {/* use empty defaults */})
      .finally(() => setLoading(false));
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/student/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Failed to save profile");
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      }
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-xl mx-auto py-16 text-center text-soft-gray/40 text-sm">
        Loading profile…
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-xl bg-electric-blue/10 border border-electric-blue/20">
          <User size={20} className="text-electric-blue" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white">My Profile</h1>
          <p className="text-soft-gray/50 text-sm">Help your teacher know more about you.</p>
        </div>
      </div>

      <form onSubmit={handleSave} className="bg-white/3 border border-white/8 rounded-2xl p-6 space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div>
            <label className="block text-soft-gray/70 text-sm font-medium mb-1.5">Grade</label>
            <input
              className={inputCls}
              placeholder="e.g. 11"
              value={profile.grade ?? ""}
              onChange={(e) => setProfile((p) => ({ ...p, grade: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-soft-gray/70 text-sm font-medium mb-1.5">School</label>
            <input
              className={inputCls}
              placeholder="e.g. Taipei High School"
              value={profile.school ?? ""}
              onChange={(e) => setProfile((p) => ({ ...p, school: e.target.value }))}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div>
            <label className="block text-soft-gray/70 text-sm font-medium mb-1.5">Target SAT Score</label>
            <input
              type="number"
              min={400}
              max={1600}
              step={10}
              className={inputCls}
              placeholder="e.g. 1400"
              value={profile.target_score ?? ""}
              onChange={(e) =>
                setProfile((p) => ({ ...p, target_score: e.target.value ? Number(e.target.value) : null }))
              }
            />
          </div>
          <div>
            <label className="block text-soft-gray/70 text-sm font-medium mb-1.5">Class Group</label>
            <input
              className={inputCls}
              placeholder="e.g. Class A"
              value={profile.class_group ?? ""}
              onChange={(e) => setProfile((p) => ({ ...p, class_group: e.target.value }))}
            />
          </div>
        </div>

        {error && (
          <p className="text-rose text-sm bg-rose/10 border border-rose/20 rounded-xl px-3 py-2">
            {error}
          </p>
        )}

        {saved && (
          <p className="text-lime-green text-sm bg-lime-green/10 border border-lime-green/20 rounded-xl px-3 py-2">
            Profile saved successfully.
          </p>
        )}

        <button
          type="submit"
          disabled={saving}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-electric-blue hover:bg-electric-blue/90 text-white font-semibold text-sm disabled:opacity-60 transition-colors"
        >
          <Save size={15} />
          {saving ? "Saving…" : "Save Profile"}
        </button>
      </form>
    </div>
  );
}
