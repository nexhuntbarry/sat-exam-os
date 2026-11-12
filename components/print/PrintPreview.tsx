"use client";

import { useEffect, useRef, useState } from "react";
import { Printer, Download, Loader2 } from "lucide-react";
import { waitForImages } from "@/lib/print-images";
import { PrintPendingNotice } from "@/components/analytics/PrintButton";
import { studentPageLabels } from "@/lib/print-duplex";

// Pages as sheets on screen; on paper, no blank sheet after the last page.
const PREVIEW_CSS = `
/* Per-student page numbers (labelStudentPages), on screen and paper. */
.print-preview-pages .pagedjs_margin-content[data-label]::after { content: attr(data-label) !important; }
.print-preview-pages .print-blank-note { margin-top: 4.5in; text-align: center; font-size: 10pt; color: #555; }
@media screen {
  .print-preview-pages { background: #e7e5e4; padding: 24px 0 48px; min-height: 100vh; }
  .print-preview-pages .pagedjs_pages { display: flex; flex-direction: column; align-items: center; gap: 18px; }
  .print-preview-pages .pagedjs_page { background: #fff; box-shadow: 0 1px 6px rgba(0,0,0,.25); }
}
@media print {
  .print-preview-pages .pagedjs_page:last-child { break-after: auto !important; page-break-after: auto !important; }
  /* Ctrl/Cmd+P before the pages are laid out: print the plain document. */
  html:not([data-print-ready]) .print-source { display: block !important; }
}
`;

// Result printouts (sections with data-sub, one per student): "Page x of y"
// counts only that student's pages, and a blank page Paged.js added for
// double-sided printing (break-before: recto) belongs to the student before
// it, isn't numbered and says it's blank. Returns the number of blank pages.
function labelStudentPages(root: HTMLElement): number {
  const pages = Array.from(root.querySelectorAll<HTMLElement>(".pagedjs_page"));
  if (!root.querySelector(".pagedjs_page [data-sub]")) return 0;
  let last: string | null = null;
  const owners = pages.map((pg) => {
    if (pg.classList.contains("pagedjs_blank_page")) return null;
    last = pg.querySelector<HTMLElement>("[data-sub]")?.dataset.sub ?? last;
    return last;
  });
  const labels = studentPageLabels(owners);
  pages.forEach((pg, i) => {
    const l = labels[i];
    const foot = pg.querySelector<HTMLElement>(".pagedjs_margin-bottom-right .pagedjs_margin-content");
    if (foot) foot.dataset.label = l ? `Page ${l.n} of ${l.of}` : "";
    if (!l) {
      const note = document.createElement("div");
      note.className = "print-blank-note";
      note.textContent = "This page intentionally left blank";
      pg.querySelector(".pagedjs_page_content")?.appendChild(note);
    }
  });
  return labels.filter((l) => l === null).length;
}

export interface PreviewOption {
  /** URL search param this option sets. */
  param: string;
  label: string;
  value: string;
  choices: { value: string; label: string }[];
  /** Shown instead of the choices when the option isn't available. */
  disabledReason?: string;
}

export interface PreviewStudent {
  id: string;
  name: string;
  /** Every class the student is in; they're listed under each. */
  classNames: string[];
  checked: boolean;
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

// Paged.js lays out one page per tick of its task queue, and that tick is
// requestAnimationFrame — which a background tab never runs, so the preview
// sat on "Laying out pages…" until the tab was shown. This tick uses an
// animation frame while the tab is visible (progress paints) and a
// MessageChannel task while it's hidden (not throttled like timers); a
// frame still pending when the tab hides is handed over the same way.
// Kept for the page's lifetime: Paged.js re-queues work after layout too.
function backgroundSafeTick() {
  const pending = new Set<() => void>();
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    const due = Array.from(pending);
    pending.clear();
    due.forEach((run) => run());
  };
  const onVisibility = () => {
    if (document.hidden && pending.size) channel.port2.postMessage(0);
  };
  document.addEventListener("visibilitychange", onVisibility);
  return (cb: () => void) => {
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      pending.delete(run);
      cb();
    };
    pending.add(run);
    if (document.hidden) channel.port2.postMessage(0);
    else requestAnimationFrame(run);
  };
}

// What prints, page by page at Letter size. The printable content (server
// rendered into a hidden source) is paginated with Paged.js into real
// Letter pages — page breaks, page numbers and the running student name are
// exactly what the browser prints (and what the server's PDF download
// renders, since it opens this same page). Print stays disabled with
// "Loading images…" until every figure has loaded.
export default function PrintPreview({
  title,
  pageCss,
  options = [],
  students,
  pdfUrl,
  duplex = false,
  children,
}: {
  title: string;
  /** @page rules + running header/footer for this document. */
  pageCss: string;
  options?: PreviewOption[];
  /** Print all: which students are in the document. */
  students?: PreviewStudent[];
  /** Server PDF for "Save as PDF"; without it, Save opens the print dialog. */
  pdfUrl?: string;
  /** Double-sided printing is on: the status line says how many blank pages were added. */
  duplex?: boolean;
  children: React.ReactNode;
}) {
  const sourceRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const [phase, setPhase] = useState<"images" | "paging" | "ready" | "error">("images");
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const [failed, setFailed] = useState<string[]>([]);
  const [pages, setPages] = useState(0);
  const [blanks, setBlanks] = useState(0);
  const [saving, setSaving] = useState(false);
  // `rendered` = the students in the document on screen; `picked` = the
  // current choice. Whenever they differ the preview is out of date: it
  // re-renders after 600 ms of no changes, and Print/Save stay disabled
  // until it does, so a stale preview is never printed.
  const [rendered] = useState(() => new Set((students ?? []).filter((s) => s.checked).map((s) => s.id)));
  const [picked, setPicked] = useState(rendered);
  const [showList, setShowList] = useState(false);
  const [updating, setUpdating] = useState(false);
  const stale = !sameSet(picked, rendered);

  // Tab title = the browser's default file name for "Save as PDF".
  useEffect(() => {
    const set = () => {
      if (document.title !== title) document.title = title;
    };
    set();
    const head = document.querySelector("head");
    const mo = head ? new MutationObserver(set) : null;
    mo?.observe(head!, { subtree: true, childList: true, characterData: true });
    return () => mo?.disconnect();
  }, [title]);

  useEffect(() => {
    if (!stale || picked.size === 0 || !students) return;
    const t = setTimeout(() => applyStudents(picked), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked]);

  useEffect(() => {
    if (started.current || !sourceRef.current || !targetRef.current) return;
    started.current = true;
    (async () => {
      const src = sourceRef.current!;
      const res = await waitForImages(src, { onProgress: (loaded, total) => setProgress({ loaded, total }) });
      setFailed(res.failed);
      setPhase("paging");
      try {
        // The package's ESM source trips Turbopack's CJS interop (event-emitter →
        // es5-ext); its own pre-bundled ESM build doesn't.
        const { Previewer } = (await import("../../node_modules/pagedjs/dist/paged.esm.js")) as typeof import("pagedjs");
        const content = document.createDocumentFragment();
        for (const n of Array.from(src.childNodes)) content.appendChild(n.cloneNode(true));
        // Only our @page sheet goes through Paged.js: its CSS parser can't read
        // the app's Tailwind output, which keeps styling the pages as-is.
        const previewer = new Previewer();
        // Internal (pagedjs 0.4.x Chunker → Queue); without it, layout only
        // progresses in a visible tab.
        const q = (previewer as unknown as { chunker?: { q?: { tick?: unknown } } }).chunker?.q;
        if (q && typeof q.tick === "function") q.tick = backgroundSafeTick();
        const flow = await previewer.preview(content, [{ [window.location.href]: pageCss }], targetRef.current!);
        await waitForImages(targetRef.current!);
        setBlanks(labelStudentPages(targetRef.current!));
        setPages(flow.total);
        setPhase("ready");
        // Read by the server PDF renderer (headless Chromium) and the nightly check.
        document.documentElement.dataset.printReady = String(flow.total);
        if (res.failed.length) document.documentElement.dataset.printFailed = res.failed.join("|");
      } catch (e) {
        console.error("[print preview]", e);
        // Tell the server renderer right away instead of letting it wait out its timeout.
        document.documentElement.dataset.printFailed = "layout";
        // Fall back to the plain document so Print still prints everything.
        targetRef.current!.replaceChildren();
        src.hidden = false;
        setPhase("error");
      }
    })();
  }, [pageCss]);

  function setParam(param: string, value: string | null) {
    const url = new URL(window.location.href);
    if (value == null || value === "") url.searchParams.delete(param);
    else url.searchParams.set(param, value);
    setUpdating(true);
    // Full reload: Paged.js has already paginated this document.
    window.location.assign(url.toString());
  }

  function applyStudents(ids: Set<string>) {
    if (!students || ids.size === 0) return;
    setParam("subs", students.filter((s) => ids.has(s.id)).map((s) => s.id).join(","));
  }

  function setMany(ids: string[], on: boolean) {
    const next = new Set(picked);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    setPicked(next);
  }

  // Students grouped by class (a student in two classes is listed under both).
  const groups = (() => {
    if (!students) return [];
    const byClass = new Map<string, PreviewStudent[]>();
    for (const st of students) {
      for (const c of st.classNames.length ? st.classNames : ["No class"]) byClass.set(c, [...(byClass.get(c) ?? []), st]);
    }
    return Array.from(byClass).sort(([a], [b]) => (a === "No class" ? 1 : b === "No class" ? -1 : a.localeCompare(b)));
  })();

  async function saveAsPdf() {
    if (!pdfUrl) return window.print();
    setSaving(true);
    try {
      const r = await fetch(pdfUrl);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const name = /filename\*=UTF-8''([^;]+)/.exec(r.headers.get("content-disposition") ?? "")?.[1];
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name ? decodeURIComponent(name) : `${title}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch {
      // Server PDF unavailable → the browser's own Save as PDF.
      window.print();
    } finally {
      setSaving(false);
    }
  }

  const busy = phase === "images" || phase === "paging";
  const blocked = busy || stale || updating;
  const blockedLabel = updating ? "Updating preview…" : stale ? "Preview out of date" : null;
  return (
    <>
      <div className="no-print sticky top-0 z-30 bg-white border-b border-divider shadow-sm">
        <div className="max-w-5xl mx-auto px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="min-w-0 mr-auto">
            <div className="font-semibold text-charcoal truncate">{title}</div>
            <div className="text-xs text-mid-gray" aria-live="polite">
              {phase === "images" && `Loading images… ${progress.loaded}/${progress.total}`}
              {phase === "paging" && "Laying out pages…"}
              {phase === "ready" &&
                `${pages} page${pages === 1 ? "" : "s"}${duplex ? ` (${blanks} blank page${blanks === 1 ? "" : "s"} added for double-sided printing)` : ""} · US Letter`}
              {phase === "error" && "Preview failed — Print still prints the document."}
            </div>
          </div>
          {options.map((o) => (
            <label key={o.param} className="text-xs text-mid-gray flex items-center gap-1.5">
              {o.label}
              {o.disabledReason ? (
                <span className="text-soft-mute italic">{o.disabledReason}</span>
              ) : (
                <select
                  value={o.value}
                  onChange={(e) => setParam(o.param, e.target.value)}
                  className="text-sm text-charcoal border border-divider rounded-lg px-2 py-1 bg-white"
                >
                  {o.choices.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              )}
            </label>
          ))}
          <button
            onClick={() => window.print()}
            disabled={blocked}
            title={blockedLabel ?? undefined}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-warm-coral text-white text-sm font-semibold hover:bg-warm-coral-dark disabled:opacity-60 disabled:cursor-wait"
          >
            {busy || updating ? <Loader2 size={16} className="animate-spin" /> : <Printer size={16} />}
            {phase === "images" ? `Loading images… ${progress.loaded}/${progress.total}` : busy ? "Preparing…" : "Print"}
          </button>
          <button
            onClick={saveAsPdf}
            disabled={blocked || saving}
            title={pdfUrl ? "Download this exact document as a PDF file" : "Opens the print dialog — choose “Save as PDF”"}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-light-bg text-charcoal text-sm font-semibold hover:bg-divider disabled:opacity-60 disabled:cursor-wait"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
            {saving ? "Preparing PDF…" : "Save as PDF"}
          </button>
        </div>
        {failed.length > 0 && (
          <p role="alert" className="max-w-5xl mx-auto px-4 pb-2 text-xs text-status-error">
            {failed.length} image{failed.length === 1 ? "" : "s"} didn&apos;t load and will be missing on paper: {failed.join(", ")}. Reload to try again.
          </p>
        )}
        {students && students.length > 1 && (
          <div className="max-w-5xl mx-auto px-4 pb-3 text-sm">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <button type="button" onClick={() => setShowList((v) => !v)} className="text-mid-gray hover:text-charcoal" aria-expanded={showList}>
                {showList ? "▾" : "▸"} Students: {picked.size} of {students.length}
              </button>
              <button type="button" onClick={() => setMany(students.map((st) => st.id), true)} className="text-warm-coral-text hover:underline">
                Select all
              </button>
              <button type="button" onClick={() => setPicked(new Set())} className="text-warm-coral-text hover:underline">
                Clear
              </button>
              <button
                type="button"
                onClick={() => applyStudents(picked)}
                disabled={!stale || picked.size === 0 || updating}
                className={`px-3 py-1 rounded-lg text-xs font-semibold ${
                  stale || updating ? "bg-warm-amber text-charcoal ring-2 ring-warm-amber/50 animate-pulse" : "bg-light-bg text-soft-mute"
                }`}
              >
                {updating ? "Updating preview…" : "Update preview"}
              </button>
              {picked.size === 0 && <span className="text-xs text-status-error">Select at least one student.</span>}
              {stale && picked.size > 0 && !updating && <span className="text-xs text-mid-gray">The preview updates in a moment…</span>}
            </div>
            {showList && (
              <div className="mt-2 max-h-72 overflow-auto space-y-3 pr-1">
                {groups.map(([cls, list]) => {
                  const ids = list.map((st) => st.id);
                  const n = ids.filter((id) => picked.has(id)).length;
                  return (
                    <div key={cls}>
                      <label className="flex items-start gap-2 w-full border-b border-divider pb-1 mb-1 font-semibold text-charcoal">
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={n === ids.length}
                          ref={(el) => {
                            if (el) el.indeterminate = n > 0 && n < ids.length;
                          }}
                          onChange={(e) => setMany(ids, e.target.checked)}
                          aria-label={`Select class ${cls}`}
                        />
                        <span className="break-words">{cls}</span>
                        <span className="ml-auto shrink-0 text-xs font-normal text-soft-mute">{n} of {ids.length}</span>
                      </label>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1 pl-6">
                        {list.map((st) => (
                          <label key={st.id} className="flex items-start gap-2">
                            <input
                              type="checkbox"
                              className="mt-1"
                              checked={picked.has(st.id)}
                              onChange={(e) => setMany([st.id], e.target.checked)}
                            />
                            <span className="break-words">{st.name}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Preview chrome, not part of the paginated document. */}
      <style>{PREVIEW_CSS}</style>
      {/* Source: hidden; its figures load here first. */}
      <div ref={sourceRef} className="print-source" hidden>
        <PrintPendingNotice />
        {children}
      </div>
      <div ref={targetRef} className="print-preview-pages" />
    </>
  );
}
