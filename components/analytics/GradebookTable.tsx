import Link from "next/link";
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, Ban, Circle, Clock, XCircle } from "lucide-react";
import { formatShortDate } from "@/lib/datetime";
import {
  KIND_LABEL,
  TIER_LABEL,
  TIER_MARK,
  cellHint,
  cellLabel,
  formatChange,
  retakeLabel,
  scoreTier,
  tierLabel,
  type CellState,
  type Gradebook,
  type GradebookCell,
  type GradebookColumn,
  type GradebookRow,
  type ScorePoint,
  type SortDir,
  type SortKey,
} from "@/lib/class-gradebook-view";

// The class gradebook grid. No hooks: the screen (ClassGradebook, with
// sort buttons) and the printout (/print/classes/[id]/scores, compact)
// render the same table, so both show the same columns.

const TIER_BG = { high: "bg-emerald-50", mid: "bg-amber-50", low: "bg-rose-50" } as const;
// Weight steps with the tier too, so the scale survives grayscale.
const TIER_WEIGHT = { high: "font-bold", mid: "font-semibold", low: "font-normal" } as const;

const STATE_ICON: Record<Exclude<CellState, "scored">, typeof Clock> = {
  "in-progress": Clock,
  late: AlertTriangle,
  "not-started": Circle,
  missing: XCircle,
  closed: Ban,
};

const pointText = (p: ScorePoint | null) =>
  p ? `${p.score} · ${p.testName}${p.takenAt ? ` (${formatShortDate(p.takenAt)})` : ""}` : "No finished test";

function cellTitle(row: GradebookRow, col: GradebookColumn, cell: GradebookCell): string {
  if (cell.state !== "scored") return `${row.name} · ${col.name}: ${cellHint(cell)}${cell.detail ? ` (${cell.detail})` : ""}`;
  return [
    `${row.name} · ${col.name}`,
    `${col.kind === "fl" ? "Total" : "SAT"} ${cell.sat ?? "—"}${cell.detail ? ` · ${cell.detail}` : ""}`,
    cell.late ? "Submitted late" : null,
    cell.retake
      ? `${retakeLabel(cell)}: showing attempt ${cell.attemptNumber ?? 1}, the latest finished one${cell.retake.attemptNumber ? ` (attempt ${cell.retake.attemptNumber} ${cell.retake.state === "closed" ? "was closed unfinished" : "isn't finished yet"})` : ""}`
      : cell.attemptNumber && cell.attemptNumber > 1
        ? `Attempt ${cell.attemptNumber} (latest)`
        : null,
    cell.takenAt ? `Submitted ${formatShortDate(cell.takenAt)}` : null,
    cell.pct != null ? `${cell.pct.toFixed(1)}% correct` : null,
    ...cell.notes,
    cell.href ? "Click to open the result" : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function CellBody({ col, cell, compact }: { col: GradebookColumn; cell: GradebookCell; compact: boolean }) {
  if (cell.state !== "scored") {
    const Icon = STATE_ICON[cell.state];
    const tone = cell.state === "missing" || cell.state === "late" ? "text-warm-coral-text" : "text-soft-mute";
    return (
      <div className={`inline-flex items-center gap-1 ${compact ? "text-[8pt]" : "text-xs"} ${tone} ${cell.state === "missing" ? "font-semibold" : ""}`}>
        <Icon size={compact ? 9 : 12} aria-hidden />
        {cellLabel(cell)}
      </div>
    );
  }
  if (cell.sat == null) return <span className="text-soft-mute">—</span>;
  const tier = scoreTier(cell.sat, col.kind);
  return (
    <div className="whitespace-nowrap">
      <div className={`${compact ? "text-[11pt]" : "text-lg"} leading-tight text-charcoal ${TIER_WEIGHT[tier]}`}>
        {cell.sat}
        <span aria-hidden className="ml-1 text-[0.6em] align-middle text-mid-gray">{TIER_MARK[tier]}</span>
        {cell.late && (
          <span className={`ml-1 rounded border border-current px-1 align-middle font-medium text-status-warning ${compact ? "text-[7pt]" : "text-[10px]"}`}>
            Late
          </span>
        )}
      </div>
      {cell.detail && <div className={`${compact ? "text-[7pt]" : "text-[11px]"} text-mid-gray`}>{cell.detail}</div>}
      {cell.retake && (
        <div className={`inline-flex items-center gap-1 ${compact ? "text-[7pt]" : "text-[10px]"} font-medium text-mid-gray`}>
          <Clock size={compact ? 8 : 10} aria-hidden />
          {retakeLabel(cell)}
        </div>
      )}
    </div>
  );
}

function SortButton({ k, label, sort, onSort }: { k: SortKey; label: string; sort?: { key: SortKey; dir: SortDir }; onSort?: (k: SortKey) => void }) {
  if (!onSort || !sort) return null;
  const active = sort.key === k;
  const Icon = !active ? ArrowUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      className={`print:hidden inline-flex items-center rounded p-0.5 hover:bg-divider ${active ? "text-charcoal" : "text-soft-mute"}`}
      aria-label={`Sort by ${label}`}
      title={`Sort by ${label}`}
    >
      <Icon size={12} aria-hidden />
    </button>
  );
}

const ariaSort = (sort: { key: SortKey; dir: SortDir } | undefined, k: SortKey) =>
  sort?.key === k ? (sort.dir === "asc" ? "ascending" : "descending") : undefined;

export default function GradebookTable({
  gradebook,
  columns,
  rows,
  sort,
  onSort,
  compact = false,
  summary = true,
}: {
  gradebook: Pick<Gradebook, "scope" | "averages">;
  /** Show the summary columns (a printed grid split into several tables shows them once). */
  summary?: boolean;
  /** Columns to show (already filtered), newest first. */
  columns: GradebookColumn[];
  /** Rows in display order. */
  rows: GradebookRow[];
  sort?: { key: SortKey; dir: SortDir };
  onSort?: (k: SortKey) => void;
  /** Printout: smaller type, no links. */
  compact?: boolean;
}) {
  const { scope, averages } = gradebook;
  const showMath = summary && scope.math;
  const showRw = summary && scope.rw;
  const showEst = summary && scope.rw && scope.math;
  const pad = compact ? "px-1.5 py-1" : "px-3 py-2";
  const th = `${pad} text-left align-bottom font-medium text-mid-gray ${compact ? "text-[7.5pt]" : "text-xs"}`;
  const sticky = compact ? "" : "sticky left-0 z-10 bg-surface";
  const sum = (k: SortKey, label: string, title: string) => (
    <th scope="col" className={`${th} border-l border-divider`} aria-sort={ariaSort(sort, k)} title={title}>
      <span className="inline-flex items-center gap-1 whitespace-nowrap">
        {label}
        <SortButton k={k} label={label} sort={sort} onSort={onSort} />
      </span>
    </th>
  );

  return (
    <table className={`w-full border-collapse ${compact ? "text-[8pt]" : "text-sm"}`}>
      <thead>
        <tr className="border-b border-divider bg-light-bg">
          <th scope="col" className={`${th} ${sticky} ${compact ? "" : "bg-light-bg"} min-w-[9rem]`} aria-sort={ariaSort(sort, "name")}>
            <span className="inline-flex items-center gap-1">
              Student
              <SortButton k="name" label="student name" sort={sort} onSort={onSort} />
            </span>
          </th>
          {columns.map((c) => (
            <th key={c.id} scope="col" className={`${th} ${compact ? "max-w-[1.1in]" : "min-w-[7.5rem] max-w-[11rem]"}`} aria-sort={ariaSort(sort, `test:${c.id}`)}>
              <div className="flex items-start gap-1">
                {compact ? (
                  <span className="font-semibold text-charcoal leading-tight">{c.name}</span>
                ) : (
                  <Link href={c.href} className="font-semibold text-charcoal leading-tight hover:text-warm-coral-text hover:underline" title={`Open the results of ${c.name}`}>
                    {c.name}
                  </Link>
                )}
                <SortButton k={`test:${c.id}`} label={c.name} sort={sort} onSort={onSort} />
              </div>
              <div className="font-normal text-soft-mute whitespace-nowrap">
                {KIND_LABEL[c.kind]}
                {c.dueDate ? ` · Due ${formatShortDate(c.dueDate)}` : ""}
              </div>
            </th>
          ))}
          {showMath && sum("latestMath", "Latest Math", "Latest finished Math score: a Math test or the Math section of a full-length SAT.")}
          {showRw && sum("latestRw", "Latest R&W", "Latest finished Reading and Writing score: an R&W test or the R&W section of a full-length SAT.")}
          {showEst &&
            sum(
              "estTotal",
              "Est. total",
              "Estimated SAT total = latest Math + latest R&W (400–1600). The two can come from different tests, so it's an estimate, not a real one-sitting score.",
            )}
          {summary &&
            sum(
              "change",
              "Change",
              "The student's most recent finished test compared with their previous finished test of the same subject (Math vs Math, R&W vs R&W, full-length total vs full-length total). A retake that isn't finished doesn't count yet.",
            )}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.studentId} className="border-b border-divider last:border-b-0 break-inside-avoid">
            <th scope="row" className={`${pad} ${sticky} text-left font-medium text-charcoal`}>
              <div className="leading-tight">{r.name}</div>
              {!compact && r.name !== r.email && <div className="text-[11px] font-normal text-soft-mute truncate max-w-[12rem]">{r.email}</div>}
            </th>
            {columns.map((c) => {
              const cell = r.cells[c.id];
              if (!cell) return <td key={c.id} className={pad} />;
              const tier = cell.state === "scored" && cell.sat != null ? scoreTier(cell.sat, c.kind) : null;
              const title = cellTitle(r, c, cell) + (tier ? `\nScore band: ${tierLabel(tier, c.kind)}` : "");
              const body = <CellBody col={c} cell={cell} compact={compact} />;
              return (
                <td key={c.id} className={`${pad} align-top ${tier ? TIER_BG[tier] : ""}`} title={title}>
                  {cell.href && !compact ? (
                    <Link href={cell.href} className="block rounded hover:ring-2 hover:ring-warm-coral/40 focus-visible:ring-2 focus-visible:ring-warm-coral" aria-label={title.split("\n").slice(0, 3).join(", ")}>
                      {body}
                    </Link>
                  ) : (
                    body
                  )}
                </td>
              );
            })}
            {showMath && (
              <td className={`${pad} border-l border-divider align-top font-semibold text-charcoal`} title={pointText(r.summary.latestMath)}>
                {r.summary.latestMath?.score ?? <span className="text-soft-mute font-normal">—</span>}
              </td>
            )}
            {showRw && (
              <td className={`${pad} border-l border-divider align-top font-semibold text-charcoal`} title={pointText(r.summary.latestRw)}>
                {r.summary.latestRw?.score ?? <span className="text-soft-mute font-normal">—</span>}
              </td>
            )}
            {showEst && (
              <td
                className={`${pad} border-l border-divider align-top font-bold text-charcoal`}
                title={
                  r.summary.estTotal != null
                    ? `Latest Math ${r.summary.latestMath!.score} + latest R&W ${r.summary.latestRw!.score} = ${r.summary.estTotal}`
                    : "Needs a finished Math score and a finished R&W score"
                }
              >
                {r.summary.estTotal ?? <span className="text-soft-mute font-normal">—</span>}
              </td>
            )}
            {summary && (
              <td
                className={`${pad} border-l border-divider align-top whitespace-nowrap`}
                title={
                  r.summary.change
                    ? `${KIND_LABEL[r.summary.change.kind]}: ${pointText(r.summary.change.latest)} vs ${pointText(r.summary.change.previous)}`
                    : "Needs two finished tests of the same subject"
                }
              >
                {r.summary.change ? (
                  <span className="font-semibold text-charcoal">
                    {formatChange(r.summary.change.delta)}
                    <span className="ml-1 text-[0.8em] font-normal text-soft-mute">{KIND_LABEL[r.summary.change.kind]}</span>
                  </span>
                ) : (
                  <span className="text-soft-mute">—</span>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-divider bg-light-bg">
          <th scope="row" className={`${pad} ${sticky} ${compact ? "" : "bg-light-bg"} text-left font-semibold text-charcoal`}>
            Class average
          </th>
          {columns.map((c) => (
            <td key={c.id} className={`${pad} align-top`} title={`${c.scored} finished score${c.scored === 1 ? "" : "s"}`}>
              <div className="font-semibold text-charcoal">{c.avg ?? "—"}</div>
              <div className={`${compact ? "text-[7pt]" : "text-[11px]"} text-soft-mute whitespace-nowrap`}>
                {c.kind === "fl" && (c.avgRw != null || c.avgMath != null)
                  ? [c.avgRw != null ? `R&W ${c.avgRw}` : null, c.avgMath != null ? `Math ${c.avgMath}` : null].filter(Boolean).join(" · ")
                  : `n = ${c.scored}`}
              </div>
            </td>
          ))}
          {showMath && <td className={`${pad} border-l border-divider align-top font-semibold`}>{averages.latestMath ?? "—"}</td>}
          {showRw && <td className={`${pad} border-l border-divider align-top font-semibold`}>{averages.latestRw ?? "—"}</td>}
          {showEst && <td className={`${pad} border-l border-divider align-top font-semibold`}>{averages.estTotal ?? "—"}</td>}
          {summary && <td className={`${pad} border-l border-divider`} />}
        </tr>
      </tfoot>
    </table>
  );
}

/** Legend for the score bands and status words. */
export function GradebookLegend({ compact = false }: { compact?: boolean }) {
  const size = compact ? "text-[7.5pt]" : "text-xs";
  return (
    <p className={`${size} text-soft-mute flex flex-wrap gap-x-3 gap-y-1`}>
      {(["high", "mid", "low"] as const).map((t) => (
        <span key={t} className="inline-flex items-center gap-1">
          <span className={`inline-block rounded px-1 ${TIER_BG[t]} ${TIER_WEIGHT[t]} text-charcoal`}>{TIER_MARK[t]}</span>
          {TIER_LABEL[t]}
        </span>
      ))}
      <span>(full-length total: 1300+ / 1000–1299 / under 1000)</span>
      <span>
        · Missing = not started after the due date · Late = started, not submitted, past due · Retake in progress = score from the
        latest finished attempt
      </span>
    </p>
  );
}
