"use client";

import { useMemo, useState } from "react";
import { Download, Printer, Table2 } from "lucide-react";
import GradebookTable, { GradebookLegend } from "@/components/analytics/GradebookTable";
import {
  NO_FILTER,
  effectiveSort,
  filterColumns,
  gradebookCsv,
  sortRows,
  viewQuery,
  type Gradebook,
  type GradebookFilter,
  type SortDir,
  type SortKey,
  type SubjectFilter,
} from "@/lib/class-gradebook-view";

const SUBJECTS: { value: SubjectFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "math", label: "Math" },
  { value: "rw", label: "R&W" },
  { value: "fl", label: "Full-length" },
];

// "Scores" on a class page (admin and teacher): one row per student, one
// column per assigned test, sortable and filterable on the client. Data
// comes from lib/class-gradebook (server); CSV and Print use the view
// on screen. `gradebook` null = the load failed (the rest of the page
// still works).
export default function ClassGradebook(props: { classId: string; className: string; gradebook: Gradebook | null }) {
  if (!props.gradebook) {
    return (
      <section aria-labelledby="class-scores-heading">
        <div className="flex items-center gap-2 mb-3">
          <Table2 size={14} className="text-warm-coral-text" aria-hidden />
          <h2 id="class-scores-heading" className="font-semibold text-charcoal">Scores</h2>
        </div>
        <p role="alert" className="rounded-2xl border border-dashed border-divider px-5 py-6 text-center text-mid-gray text-sm">
          Scores couldn&rsquo;t load. Refresh to try again.
        </p>
      </section>
    );
  }
  return <GradebookView {...props} gradebook={props.gradebook} />;
}

function GradebookView({
  classId,
  className,
  gradebook,
}: {
  classId: string;
  className: string;
  gradebook: Gradebook;
}) {
  const [filter, setFilter] = useState<GradebookFilter>(NO_FILTER);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "name", dir: "asc" });

  const columns = useMemo(() => filterColumns(gradebook.columns, filter), [gradebook.columns, filter]);
  const rows = useMemo(() => {
    // Sorting by a column the filter hid falls back to name.
    const s = effectiveSort(columns, sort.key, sort.dir);
    return sortRows(gradebook.rows, s.key, s.dir);
  }, [gradebook.rows, columns, sort]);

  // Only the subjects this class has (a single-subject teacher sees theirs).
  const kinds = new Set(gradebook.columns.map((c) => c.kind));
  const subjects = SUBJECTS.filter((s) => s.value === "all" || kinds.has(s.value));

  const onSort = (k: SortKey) =>
    setSort((cur) =>
      // Scores start high → low; names A → Z.
      cur.key === k ? { key: k, dir: cur.dir === "asc" ? "desc" : "asc" } : { key: k, dir: k === "name" ? "asc" : "desc" },
    );

  function downloadCsv() {
    const blob = new Blob([gradebookCsv(gradebook, columns, rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${className.replace(/[^a-z0-9]+/gi, "_")}-scores.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const qs = viewQuery(filter, sort.key, sort.dir);
  const filtered = filter.subject !== "all" || filter.from || filter.to;
  const input = "rounded-lg border border-divider bg-surface px-2 py-1 text-xs text-charcoal";

  return (
    <section aria-labelledby="class-scores-heading">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Table2 size={14} className="text-warm-coral-text" aria-hidden />
          <h2 id="class-scores-heading" className="font-semibold text-charcoal">Scores</h2>
          <span className="text-soft-mute font-normal text-sm">
            ({gradebook.rows.length} {gradebook.rows.length === 1 ? "student" : "students"} · {columns.length}
            {columns.length !== gradebook.columns.length ? ` of ${gradebook.columns.length}` : ""} tests)
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={downloadCsv}
            disabled={gradebook.rows.length === 0 || columns.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-light-bg text-charcoal text-sm font-medium hover:bg-divider disabled:opacity-50"
          >
            <Download size={14} aria-hidden /> Download CSV
          </button>
          <a
            href={`/print/classes/${classId}/scores${qs ? `?${qs}` : ""}`}
            target="_blank"
            rel="noopener"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-light-bg text-charcoal text-sm font-medium hover:bg-divider"
          >
            <Printer size={14} aria-hidden /> Print
          </a>
        </div>
      </div>

      {!(gradebook.scope.rw && gradebook.scope.math) && (
        <p className="text-soft-mute text-xs mb-2">
          You see {gradebook.scope.math ? "Math" : "Reading and Writing"} tests, plus the total and your section of full-length SATs.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 mb-2">
        {subjects.length > 2 && (
          <div role="group" aria-label="Subject" className="inline-flex rounded-lg border border-divider bg-surface p-0.5">
            {subjects.map((s) => (
              <button
                key={s.value}
                type="button"
                aria-pressed={filter.subject === s.value}
                onClick={() => setFilter((f) => ({ ...f, subject: s.value }))}
                className={`px-2.5 py-1 rounded-md text-xs font-medium ${filter.subject === s.value ? "bg-charcoal text-white" : "text-mid-gray hover:text-charcoal"}`}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
        <label className="inline-flex items-center gap-1.5 text-xs text-mid-gray">
          From
          <input type="date" className={input} value={filter.from} max={filter.to || undefined} onChange={(e) => setFilter((f) => ({ ...f, from: e.target.value }))} />
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-mid-gray">
          To
          <input type="date" className={input} value={filter.to} min={filter.from || undefined} onChange={(e) => setFilter((f) => ({ ...f, to: e.target.value }))} />
        </label>
        {filtered && (
          <button type="button" onClick={() => setFilter(NO_FILTER)} className="text-xs text-warm-coral-text hover:underline">
            Clear filters
          </button>
        )}
        <span className="text-[11px] text-soft-mute">Dates use each test&rsquo;s due date (or open date).</span>
      </div>

      {gradebook.rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-divider px-5 py-8 text-center text-soft-mute text-sm">No students in this class yet.</p>
      ) : gradebook.columns.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-divider px-5 py-8 text-center text-soft-mute text-sm">No tests assigned to this class yet.</p>
      ) : columns.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-divider px-5 py-8 text-center text-soft-mute text-sm">No tests match these filters.</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-2xl border border-divider bg-surface">
            <GradebookTable gradebook={gradebook} columns={columns} rows={rows} sort={sort} onSort={onSort} />
          </div>
          <div className="mt-2">
            <GradebookLegend />
          </div>
          <p className="mt-1 text-[11px] text-soft-mute">
            Each cell is the student&rsquo;s latest finished attempt (scored as on the test&rsquo;s Results page), or where their latest attempt stands. Click a score to open the result, or a test name for the test&rsquo;s results. Summary columns use every assigned test, whatever the filters.
          </p>
        </>
      )}
    </section>
  );
}
