"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Upload } from "lucide-react";
import { upload } from "@vercel/blob/client";

export default function NewModulePage() {
  const router = useRouter();
  const [form, setForm] = useState({
    moduleName: "",
    section: "Math" as "Math" | "Reading & Writing",
    moduleNumber: "1" as "1" | "2",
    difficulty: "" as "" | "Easy" | "Medium" | "Hard" | "Mixed",
    sourceName: "",
    version: "",
  });
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((p) => ({ ...p, [k]: v }));
  }

  async function handleSubmit(triggerParse: boolean) {
    if (!form.moduleName || !file) {
      setError("Module name and PDF file are required.");
      return;
    }
    setLoading(true);
    setError(null);
    setUploadPct(0);

    try {
      // 1. Client-direct upload to Vercel Blob (bypasses 4.5 MB function body limit).
      const pathname = `modules/${Date.now()}-${file.name}`;
      const blob = await upload(pathname, file, {
        access: "public",
        handleUploadUrl: "/api/upload/handle",
        onUploadProgress: ({ percentage }) => {
          setUploadPct(Math.round(percentage));
        },
      });
      const pdfUrl = blob.url;

      // 2. Create module record
      const res = await fetch("/api/admin/modules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          moduleName: form.moduleName,
          section: form.section,
          moduleNumber: parseInt(form.moduleNumber, 10),
          difficulty: form.difficulty || undefined,
          sourceName: form.sourceName || undefined,
          version: form.version || undefined,
          pdfUrl,
          pdfSizeBytes: file.size,
          triggerParse,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to create module.");
        return;
      }

      // 3. Kick off AI parse (fire-and-forget; the detail page polls status).
      if (triggerParse) {
        fetch(`/api/admin/modules/${data.id}/parse`, { method: "POST" }).catch(
          (err) => console.error("[new-module] parse trigger failed:", err),
        );
      }

      router.push(`/admin/modules/${data.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unexpected error. Please try again.";
      setError(msg);
    } finally {
      setLoading(false);
      setUploadPct(null);
    }
  }

  const inputCls =
    "w-full bg-deep-navy border border-white/15 text-white placeholder:text-soft-gray/30 rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-electric-blue/50 transition-colors";

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <button
          onClick={() => router.back()}
          className="text-soft-gray/50 hover:text-soft-gray transition-colors"
        >
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-2xl font-bold text-white">Upload Module</h1>
      </div>

      <div className="bg-white/3 border border-white/8 rounded-2xl p-6 space-y-5">
        <div>
          <label className="block text-slate-200 text-sm font-medium mb-1">Module Name *</label>
          <input
            className={inputCls}
            value={form.moduleName}
            onChange={(e) => set("moduleName", e.target.value)}
            placeholder="e.g. Official SAT Practice Test 1 – Math M1"
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-slate-200 text-sm font-medium mb-1">Section *</label>
            <select
              className={inputCls}
              value={form.section}
              onChange={(e) => set("section", e.target.value as typeof form.section)}
            >
              <option value="Math">Math</option>
              <option value="Reading & Writing">Reading &amp; Writing</option>
            </select>
          </div>
          <div>
            <label className="block text-slate-200 text-sm font-medium mb-1">Module Number *</label>
            <select
              className={inputCls}
              value={form.moduleNumber}
              onChange={(e) => set("moduleNumber", e.target.value as "1" | "2")}
            >
              <option value="1">Module 1</option>
              <option value="2">Module 2</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-slate-200 text-sm font-medium mb-1">Difficulty</label>
            <select
              className={inputCls}
              value={form.difficulty}
              onChange={(e) => set("difficulty", e.target.value as typeof form.difficulty)}
            >
              <option value="">— Select —</option>
              <option value="Easy">Easy</option>
              <option value="Medium">Medium</option>
              <option value="Hard">Hard</option>
              <option value="Mixed">Mixed</option>
            </select>
          </div>
          <div>
            <label className="block text-slate-200 text-sm font-medium mb-1">Source Name</label>
            <input
              className={inputCls}
              value={form.sourceName}
              onChange={(e) => set("sourceName", e.target.value)}
              placeholder="e.g. College Board"
            />
          </div>
        </div>

        <div>
          <label className="block text-slate-200 text-sm font-medium mb-1">Version / Date</label>
          <input
            className={inputCls}
            value={form.version}
            onChange={(e) => set("version", e.target.value)}
            placeholder="e.g. 2024-Q1"
          />
        </div>

        <div>
          <label className="block text-slate-200 text-sm font-medium mb-2">PDF File *</label>
          <label className="flex flex-col items-center justify-center gap-3 p-8 border-2 border-dashed border-white/15 rounded-2xl cursor-pointer hover:border-electric-blue/50 transition-colors">
            <Upload size={28} className="text-soft-gray/40" />
            {file ? (
              <div className="text-center">
                <p className="text-white text-sm font-medium">{file.name}</p>
                <p className="text-soft-gray/50 text-xs mt-1">
                  {(file.size / 1024 / 1024).toFixed(2)} MB
                </p>
              </div>
            ) : (
              <div className="text-center">
                <p className="text-soft-gray/60 text-sm">Click to select PDF</p>
                <p className="text-soft-gray/40 text-xs mt-1">PDF only</p>
              </div>
            )}
            <input
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>

        {error && (
          <p className="text-rose text-sm bg-rose/10 border border-rose/20 rounded-xl px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex gap-3 pt-1">
          <button
            onClick={() => handleSubmit(false)}
            disabled={loading}
            className="flex-1 py-3 rounded-xl border border-white/15 text-soft-gray hover:bg-white/5 font-medium text-sm disabled:opacity-60 transition-colors"
          >
            {loading
              ? uploadPct !== null && uploadPct < 100
                ? `Uploading ${uploadPct}%`
                : "Saving..."
              : "Save"}
          </button>
          <button
            onClick={() => handleSubmit(true)}
            disabled={loading}
            className="flex-1 py-3 rounded-xl bg-electric-blue hover:bg-electric-blue/90 text-white font-semibold text-sm disabled:opacity-60 transition-colors"
          >
            {loading
              ? uploadPct !== null && uploadPct < 100
                ? `Uploading ${uploadPct}%`
                : "Saving..."
              : "Save & Parse with AI"}
          </button>
        </div>
      </div>
    </div>
  );
}
