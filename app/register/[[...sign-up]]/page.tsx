"use client";

import { SignUp, useUser } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import Logo from "@/components/Logo";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

function ProfileForm({ displayName }: { displayName: string }) {
  const router = useRouter();
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    fullName: displayName,
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
      <div className="bg-[#0F1A3A] border border-white/10 shadow-xl shadow-black/40 rounded-2xl p-8 text-center space-y-4">
        <div className="text-5xl">✅</div>
        <h2 className="text-white font-bold text-xl">Registration Submitted!</h2>
        <p className="text-slate-300 text-sm leading-relaxed">
          Your account is awaiting admin approval. You&apos;ll receive an email once
          approved.
        </p>
        <button
          onClick={() => router.push("/student")}
          className="mt-4 px-6 py-2.5 rounded-xl bg-lime-green text-deep-navy font-semibold text-sm hover:bg-lime-green/90 transition-colors"
        >
          View Account Status
        </button>
      </div>
    );
  }

  const inputCls =
    "w-full bg-[#0A1330] border border-white/15 text-white placeholder:text-slate-500 rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-lime-green/50 transition-colors";
  const labelCls = "block text-slate-200 font-medium text-sm mb-1";

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-[#0F1A3A] border border-white/10 shadow-xl shadow-black/40 rounded-2xl p-6 space-y-4"
    >
      <div className="mb-2">
        <h2 className="text-white font-bold text-lg">Complete Your Profile</h2>
        <p className="text-slate-400 text-xs mt-1">
          This information helps your teacher and admin set you up correctly.
        </p>
      </div>

      <div>
        <label className={labelCls}>Full Name *</label>
        <input
          className={inputCls}
          value={form.fullName}
          onChange={(e) => set("fullName", e.target.value)}
          placeholder="Your full name"
          required
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
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

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Parent Email *</label>
          <input
            type="email"
            className={inputCls}
            value={form.parentEmail}
            onChange={(e) => set("parentEmail", e.target.value)}
            placeholder="parent@example.com"
            required
          />
        </div>
        <div>
          <label className={labelCls}>Parent Phone *</label>
          <input
            type="tel"
            className={inputCls}
            value={form.parentPhone}
            onChange={(e) => set("parentPhone", e.target.value)}
            placeholder="+1 (555) 000-0000"
            required
          />
        </div>
      </div>

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
        <p className="text-rose text-sm bg-rose/10 border border-rose/20 rounded-xl px-3 py-2">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full py-3 rounded-xl bg-lime-green hover:bg-lime-green/90 text-deep-navy font-semibold text-sm disabled:opacity-60 transition-colors"
      >
        {loading ? "Submitting..." : "Submit Registration"}
      </button>
    </form>
  );
}

export default function RegisterPage() {
  const { isLoaded, isSignedIn, user } = useUser();
  const [showProfile, setShowProfile] = useState(false);

  useEffect(() => {
    if (isLoaded && isSignedIn) {
      setShowProfile(true);
    }
  }, [isLoaded, isSignedIn]);

  const displayName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
    user?.username ||
    user?.emailAddresses?.[0]?.emailAddress?.split("@")[0] ||
    "";

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 py-24 bg-deep-navy">
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-96 h-96 rounded-full opacity-10 blur-3xl bg-lime-green pointer-events-none" />

      <div className="relative z-10 flex flex-col items-center gap-8 w-full max-w-md">
        <div className="flex flex-col items-center gap-3">
          <Logo size={48} />
          <h1 className="text-xl font-semibold text-white">SAT Exam OS</h1>
          <p className="text-soft-gray/60 text-sm">Student Self-Registration</p>
        </div>

        {showProfile ? (
          <div className="w-full">
            <ProfileForm displayName={displayName} />
          </div>
        ) : (
          <SignUp
            appearance={{
              baseTheme: dark,
              variables: {
                colorPrimary: "#84CC16",
                colorBackground: "#0F1A3A",
                colorText: "#F1F5F9",
                colorTextSecondary: "#CBD5E1",
                colorInputBackground: "#0A1330",
                colorInputText: "#F8FAFC",
                colorNeutral: "#F1F5F9",
                borderRadius: "0.75rem",
                fontFamily: "var(--font-plus-jakarta-sans), system-ui, sans-serif",
              },
              elements: {
                rootBox: "w-full",
                card: "bg-[#0F1A3A] border border-white/10 shadow-xl shadow-black/40 rounded-2xl",
                headerTitle: "text-white font-bold text-xl",
                headerSubtitle: "text-slate-300",
                socialButtonsBlockButton:
                  "bg-white/5 border border-white/15 text-white hover:bg-white/10",
                socialButtonsBlockButtonText: "text-white font-medium",
                dividerLine: "bg-white/15",
                dividerText: "text-slate-300",
                formFieldLabel: "text-slate-200 font-medium",
                formFieldInput:
                  "bg-[#0A1330] border border-white/15 text-white placeholder:text-slate-500",
                formButtonPrimary:
                  "bg-lime-green hover:bg-lime-green/90 text-deep-navy font-semibold",
                footer: "bg-transparent",
                footerActionText: "text-slate-300",
                footerActionLink: "text-lime-green hover:text-electric-blue font-semibold",
                footerPages: "text-slate-400",
                footerPagesLink: "text-slate-400 hover:text-slate-200",
                identityPreviewText: "text-white",
                identityPreviewEditButton: "text-lime-green",
                alertText: "text-slate-200",
                formResendCodeLink: "text-lime-green",
              },
            }}
          />
        )}
      </div>
    </main>
  );
}
