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

  async function handleSubmit() {
    if (!form.moduleName || !file) {
      setError("Module name and PDF file are required.");
      return;
    }
    setLoading(true);
    setError(null);
    setUploadPct(0);

    let stage = "init";
    let lastPct = 0;
    try {
      stage = "upload-start";
      const pathname = `modules/${Date.now()}-${file.name}`;
      // The blob store `sat-exam-pdfs` is configured with private access. Asking
      // for `access: "public"` here was rejected by vercel.com/api/blob with
      // "Cannot use public access on a private store", causing the PUT to fail
      // silently and `onUploadCompleted` to never fire (no rows in DB, no blobs
      // in storage). Must match the store's access mode.
      const uploadPromise = upload(pathname, file, {
        access: "private" as "public",
        handleUploadUrl: "/api/upload/handle",
        multipart: false,
        onUploadProgress: ({ percentage }) => {
          lastPct = Math.round(percentage);
          setUploadPct(lastPct);
        },
      });
      const TIMEOUT_MS = 4 * 60 * 1000;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Upload hung at ${lastPct}% after ${TIMEOUT_MS / 1000}s`)),
          TIMEOUT_MS,
        ),
      );
      const blob = await Promise.race([uploadPromise, timeoutPromise]);
      stage = "upload-done";
      const pdfUrl = blob.url;

      stage = "modules-post";
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
        }),
      });
      stage = `modules-post-status-${res.status}`;
      const text = await res.text();
      if (!res.ok) {
        setError(`[stage=${stage}] HTTP ${res.status}: ${text.slice(0, 300)}`);
        return;
      }
      const data = JSON.parse(text);

      // Two-step UX: redirect to the detail page where the admin clicks
      // "Parse & Add to Question Bank" to trigger AI extraction.
      stage = "redirect";
      router.push(`/admin/modules/${data.id}`);
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      setError(`[stage=${stage}] ${msg}`);
    } finally {
      setLoading(false);
      setUploadPct(null);
    }
  }

  const inputCls =
    "w-full bg-surface border border-divider text-charcoal placeholder:text-soft-mute rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-warm-coral/50 transition-colors";

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <button
          onClick={() => router.back()}
          className="text-soft-mute hover:text-charcoal transition-colors"
        >
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-2xl font-bold text-charcoal">Upload Module</h1>
      </div>

      <div className="bg-surface border border-divider rounded-2xl p-6 space-y-5">
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
          <label className="flex flex-col items-center justify-center gap-3 p-8 border-2 border-dashed border-divider rounded-2xl cursor-pointer hover:border-warm-coral/50 transition-colors">
            <Upload size={28} className="text-soft-mute" />
            {file ? (
              <div className="text-center">
                <p className="text-charcoal text-sm font-medium">{file.name}</p>
                <p className="text-soft-mute text-xs mt-1">
                  {(file.size / 1024 / 1024).toFixed(2)} MB
                </p>
              </div>
            ) : (
              <div className="text-center">
                <p className="text-mid-gray text-sm">Click to select PDF</p>
                <p className="text-soft-mute text-xs mt-1">PDF only</p>
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
          <p className="text-status-error text-sm bg-status-error/10 border border-status-error/20 rounded-xl px-3 py-2">
            {error}
          </p>
        )}

        <div className="pt-1">
          <button
            onClick={handleSubmit}
            disabled={loading}
            className="w-full py-3 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm disabled:opacity-60 transition-colors"
          >
            {loading
              ? uploadPct !== null && uploadPct < 100
                ? `Uploading ${uploadPct}%`
                : "Saving..."
              : "Upload Module"}
          </button>
          <p className="text-soft-mute text-xs text-center mt-2">
            After upload, you&apos;ll be able to trigger AI parsing from the module page.
          </p>
        </div>
      </div>
    </div>
  );
}
