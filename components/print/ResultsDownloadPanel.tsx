"use client";

import { useEffect, useMemo, useState } from "react";
import { Printer, Download, FileSpreadsheet, Loader2 } from "lucide-react";

interface Student {
  submissionId: string;
  studentId: string;
  studentName: string;
  className: string | null;
}

// "Print / download all students' results" for one test. Each student's PDF
// is its own request to /api/print/results/…/pdf (headless Chromium, one
// student per function call, 3 at a time) and the ZIP or combined PDF is
// assembled here in the browser — so a big class shows progress and never
// hits a single long-request timeout. Every PDF holds only what that
// student may see (enforced server-side).
export default function ResultsDownloadPanel({ testId }: { testId: string }) {
  const [testName, setTestName] = useState("results");
  const [students, setStudents] = useState<Student[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [cls, setCls] = useState("");
  const [mode, setMode] = useState<"full" | "short">("full");
  const [expl, setExpl] = useState(false);
  const [format, setFormat] = useState<"zip" | "combined">("zip");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failed, setFailed] = useState<string[]>([]);

  useEffect(() => {
    fetch(`/api/print/results/${testId}/students`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { testName: string; students: Student[] }) => {
        setTestName(d.testName);
        setStudents(d.students);
        setPicked(new Set(d.students.map((s) => s.submissionId)));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load students"));
  }, [testId]);

  const classes = useMemo(
    () => Array.from(new Set((students ?? []).flatMap((s) => (s.className ?? "").split(", ").filter(Boolean)))).sort(),
    [students],
  );
  const visible = (students ?? []).filter((s) => !cls || (s.className ?? "").split(", ").includes(cls));
  const chosen = visible.filter((s) => picked.has(s.submissionId));
  const query = (extra: Record<string, string>) =>
    new URLSearchParams({ mode, ...(expl ? { expl: "1" } : {}), ...extra }).toString();

  function toggleAll(on: boolean) {
    const next = new Set(picked);
    for (const s of visible) {
      if (on) next.add(s.submissionId);
      else next.delete(s.submissionId);
    }
    setPicked(next);
  }

  async function fetchPdf(s: Student): Promise<{ name: string; bytes: Uint8Array }> {
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(`/api/print/results/${testId}/pdf?${query({ sub: s.submissionId })}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const cd = r.headers.get("content-disposition") ?? "";
        const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(cd)?.[1] ?? `${s.studentName}.pdf`);
        return { name, bytes: new Uint8Array(await r.arrayBuffer()) };
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }

  async function download() {
    const list = chosen;
    setFailed([]);
    setProgress({ done: 0, total: list.length });
    const results: ({ name: string; bytes: Uint8Array } | null)[] = new Array(list.length).fill(null);
    const bad: string[] = [];
    let next = 0;
    let done = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, list.length) }, async () => {
        while (next < list.length) {
          const i = next++;
          try {
            results[i] = await fetchPdf(list[i]);
          } catch {
            bad.push(list[i].studentName);
          }
          setProgress({ done: ++done, total: list.length });
        }
      }),
    );
    const ok = results.filter((r): r is { name: string; bytes: Uint8Array } => r !== null);
    const date = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const base = `${testName} – results – ${date}`.replace(/[\\/:*?"<>|]+/g, " ");
    if (ok.length > 0) {
      let blob: Blob;
      let file: string;
      if (format === "zip") {
        const { zipSync } = await import("fflate");
        const files: Record<string, Uint8Array> = {};
        for (const r of ok) {
          let n = r.name;
          for (let k = 2; files[n]; k++) n = r.name.replace(/\.pdf$/, ` (${k}).pdf`);
          files[n] = r.bytes;
        }
        blob = new Blob([zipSync(files, { level: 0 }) as BlobPart], { type: "application/zip" });
        file = `${base}.zip`;
      } else {
        // One PDF, each student starting on a new page (every student's PDF starts on its own page).
        const { PDFDocument } = await import("pdf-lib");
        const out = await PDFDocument.create();
        for (const r of ok) {
          const doc = await PDFDocument.load(r.bytes);
          for (const p of await out.copyPages(doc, doc.getPageIndices())) out.addPage(p);
        }
        blob = new Blob([(await out.save()) as BlobPart], { type: "application/pdf" });
        file = `${base}.pdf`;
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = file;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
    }
    setFailed(bad);
    setProgress(null);
  }

  if (error) return <p className="text-sm text-status-error">Couldn&apos;t load the student list ({error}).</p>;
  if (!students) return <p className="text-sm text-soft-mute">Loading students…</p>;
  if (students.length === 0) return null;

  const busy = progress !== null;
  const subsParam = chosen.length === students.length ? "" : chosen.map((s) => s.submissionId).join(",");
  return (
    <details className="bg-surface border border-divider rounded-2xl print:hidden">
      <summary className="px-5 py-3 cursor-pointer text-sm font-semibold text-charcoal">
        Print or download all students&apos; results ({students.length})
      </summary>
      <div className="px-5 pb-5 space-y-4 text-sm">
        <div className="flex flex-wrap gap-x-6 gap-y-2 items-center">
          {classes.length > 1 && (
            <label className="flex items-center gap-2">
              Class
              <select value={cls} onChange={(e) => setCls(e.target.value)} className="border border-divider rounded-lg px-2 py-1 bg-white">
                <option value="">All classes</option>
                {classes.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
          )}
          <label className="flex items-center gap-2">
            Version
            <select value={mode} onChange={(e) => setMode(e.target.value as "full" | "short")} className="border border-divider rounded-lg px-2 py-1 bg-white">
              <option value="full">Full (every question)</option>
              <option value="short">Short (summary + missed)</option>
            </select>
          </label>
          <label className="flex items-center gap-2" title="Only for students allowed to see explanations">
            <input type="checkbox" checked={expl} onChange={(e) => setExpl(e.target.checked)} />
            Explanations (where allowed)
          </label>
          <label className="flex items-center gap-2">
            Download as
            <select value={format} onChange={(e) => setFormat(e.target.value as "zip" | "combined")} className="border border-divider rounded-lg px-2 py-1 bg-white">
              <option value="zip">ZIP — one PDF per student</option>
              <option value="combined">One combined PDF</option>
            </select>
          </label>
        </div>

        <div>
          <div className="flex items-center gap-3 mb-1 text-xs">
            <span className="text-mid-gray">{chosen.length} of {visible.length} selected</span>
            <button type="button" onClick={() => toggleAll(true)} className="text-warm-coral-text hover:underline">All</button>
            <button type="button" onClick={() => toggleAll(false)} className="text-warm-coral-text hover:underline">None</button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-1 max-h-56 overflow-auto border border-divider rounded-lg p-2 bg-white">
            {visible.map((s) => (
              <label key={s.submissionId} className="flex items-center gap-2 min-w-0">
                <input
                  type="checkbox"
                  checked={picked.has(s.submissionId)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(s.submissionId);
                    else next.delete(s.submissionId);
                    setPicked(next);
                  }}
                />
                <span className="truncate">
                  {s.studentName}
                  {s.className && <span className="text-soft-mute"> · {s.className}</span>}
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <a
            href={`/print/results/${testId}?${query(subsParam ? { subs: subsParam } : {})}`}
            target="_blank"
            rel="noopener"
            aria-disabled={chosen.length === 0}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-light-bg text-charcoal font-semibold hover:bg-divider ${chosen.length === 0 ? "pointer-events-none opacity-50" : ""}`}
          >
            <Printer size={15} /> Print preview
          </a>
          <button
            onClick={download}
            disabled={busy || chosen.length === 0}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-warm-coral text-white font-semibold hover:bg-warm-coral-dark disabled:opacity-60"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
            {busy ? `Preparing ${progress.done} of ${progress.total}…` : `Download ${chosen.length} result${chosen.length === 1 ? "" : "s"}`}
          </button>
          <a
            href={`/api/print/results/${testId}/summary${subsParam ? `?subs=${subsParam}` : ""}`}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-light-bg text-charcoal font-semibold hover:bg-divider"
          >
            <FileSpreadsheet size={15} /> Download score summary (CSV)
          </a>
        </div>
        {failed.length > 0 && (
          <p role="alert" className="text-xs text-status-error">
            Couldn&apos;t prepare {failed.length} result{failed.length === 1 ? "" : "s"}: {failed.join(", ")}. The rest were downloaded; try these again.
          </p>
        )}
      </div>
    </details>
  );
}
