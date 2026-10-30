"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
import { sectionTitleClass } from "@/lib/section-color";
import { formatDate } from "@/lib/datetime";
import AssignDialog from "./[id]/AssignDialog";

interface AssignOptions {
  allTeachers: { id: string; display_name: string | null; email: string }[];
  allClassGroups: { id: string; name: string; campus: string | null; grade: string | null }[];
}

// ── types ──────────────────────────────────────────────────────────────────────

interface TestMod {
  module_name: string;
  section: string;
  module_number: number | null;
}

export interface TestRow {
  id: string;
  test_name: string;
  status: string;
  due_date: string | null;
  created_at: string;
  is_adaptive: boolean;
  modules: unknown;
  assignment: { teacherIds: string[]; studentIds: string[]; classGroupIds: string[] };
  submissions: { done: number; total: number };
}

type SortKey = "name" | "module" | "status" | "finished" | "due_date" | "created_at";
type SortDir = "asc" | "desc";

const STATUS_ORDER: Record<string, number> = { Draft: 0, Published: 1, Closed: 2 };

const STATUS_STYLES: Record<string, string> = {
  Draft: "bg-light-bg text-mid-gray",
  Published: "bg-warm-amber/15 text-warm-amber",
  Closed: "bg-status-error/15 text-status-error",
};

// ── natural sort collator ──────────────────────────────────────────────────────
const naturalCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

// ── comparator ────────────────────────────────────────────────────────────────

export function compareTests(a: TestRow, b: TestRow, key: SortKey, dir: SortDir): number {
  let cmp = 0;

  switch (key) {
    case "name": {
      cmp = naturalCollator.compare(a.test_name, b.test_name);
      break;
    }
    case "module": {
      const ma = (a.modules as TestMod | null)?.module_name ?? "￿";
      const mb = (b.modules as TestMod | null)?.module_name ?? "￿";
      cmp = naturalCollator.compare(ma, mb);
      break;
    }
    case "status": {
      const sa = STATUS_ORDER[a.status] ?? 99;
      const sb = STATUS_ORDER[b.status] ?? 99;
      cmp = sa - sb;
      break;
    }
    case "finished": {
      // sort by ratio first (finished/total), then by absolute count
      const ra = a.submissions.total > 0 ? a.submissions.done / a.submissions.total : 0;
      const rb = b.submissions.total > 0 ? b.submissions.done / b.submissions.total : 0;
      cmp = ra - rb || a.submissions.done - b.submissions.done;
      break;
    }
    case "due_date": {
      // null dates always sort last, regardless of direction
      if (!a.due_date && !b.due_date) { cmp = 0; break; }
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      cmp = a.due_date.localeCompare(b.due_date);
      break;
    }
    case "created_at": {
      cmp = a.created_at.localeCompare(b.created_at);
      break;
    }
  }

  return dir === "asc" ? cmp : -cmp;
}

// ── sort header button ─────────────────────────────────────────────────────────

function SortTh({
  label,
  sortKey,
  active,
  dir,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  active: boolean;
  dir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const ariaSort: React.AriaAttributes["aria-sort"] = !active
    ? "none"
    : dir === "asc"
    ? "ascending"
    : "descending";

  return (
    <th className="text-left px-5 py-3 font-medium" aria-sort={ariaSort}>
      <button
        onClick={() => onSort(sortKey)}
        className={clsx(
          "inline-flex items-center gap-1 hover:text-charcoal transition-colors",
          active ? "text-charcoal" : "text-soft-mute",
        )}
      >
        {label}
        {active ? (
          dir === "asc" ? (
            <ChevronUp size={13} className="shrink-0" />
          ) : (
            <ChevronDown size={13} className="shrink-0" />
          )
        ) : (
          <ChevronsUpDown size={13} className="shrink-0 opacity-40" />
        )}
      </button>
    </th>
  );
}

// ── table (shared for active + closed sections) ────────────────────────────────

function TestsTable({
  rows,
  sortKey,
  sortDir,
  onSort,
  assignOptions,
}: {
  rows: TestRow[];
  sortKey: SortKey | null;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  assignOptions: AssignOptions;
}) {
  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    return [...rows].sort((a, b) => compareTests(a, b, sortKey, sortDir));
  }, [rows, sortKey, sortDir]);

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-divider text-soft-mute">
            <SortTh label="Test Name" sortKey="name" active={sortKey === "name"} dir={sortDir} onSort={onSort} />
            <SortTh label="Module" sortKey="module" active={sortKey === "module"} dir={sortDir} onSort={onSort} />
            <SortTh label="Status" sortKey="status" active={sortKey === "status"} dir={sortDir} onSort={onSort} />
            <th className="text-left px-5 py-3 font-medium text-soft-mute">Assignments</th>
            <SortTh label="Finished" sortKey="finished" active={sortKey === "finished"} dir={sortDir} onSort={onSort} />
            <SortTh label="Due Date" sortKey="due_date" active={sortKey === "due_date"} dir={sortDir} onSort={onSort} />
            <SortTh label="Created" sortKey="created_at" active={sortKey === "created_at"} dir={sortDir} onSort={onSort} />
            <th className="text-left px-5 py-3 font-medium text-soft-mute">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((test) => {
            const mod = test.modules as TestMod | null;
            return (
              <tr
                key={test.id}
                className="border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors"
              >
                <td className="px-5 py-3 max-w-xs [overflow-wrap:anywhere]">
                  <Link href={`/admin/tests/${test.id}`} className="hover:text-warm-coral-text transition-colors">
                    <div className={clsx("font-medium", sectionTitleClass(mod?.section))}>{test.test_name}</div>
                    {test.is_adaptive && (
                      <span className="text-[10px] uppercase tracking-wider text-warm-coral-text font-semibold">Adaptive</span>
                    )}
                  </Link>
                </td>
                <td className="px-5 py-3 text-mid-gray">
                  {mod ? (
                    <>
                      {mod.module_name}
                      <div className="text-xs text-soft-mute">
                        {mod.section}{mod.module_number ? ` · M${mod.module_number}` : ""}
                      </div>
                    </>
                  ) : (
                    <span className="text-soft-mute italic text-xs">Adaptive · multi-module</span>
                  )}
                </td>
                <td className="px-5 py-3">
                  <span className={clsx("px-2 py-1 rounded-full text-xs font-medium", STATUS_STYLES[test.status] ?? "bg-light-bg text-mid-gray")}>
                    {test.status}
                  </span>
                </td>
                <td className="px-5 py-3 text-mid-gray whitespace-nowrap" title="Teachers · Students · Class groups">
                  {test.assignment.teacherIds.length}T · {test.assignment.studentIds.length}S · {test.assignment.classGroupIds.length}C
                </td>
                <td className="px-5 py-3 text-mid-gray">
                  {test.submissions.done} / {test.submissions.total}
                </td>
                <td className="px-5 py-3 text-soft-mute text-xs">
                  {test.due_date ? formatDate(test.due_date) : "—"}
                </td>
                <td className="px-5 py-3 text-soft-mute text-xs">
                  {formatDate(test.created_at)}
                </td>
                <td className="px-5 py-3">
                  <AssignDialog
                    variant="menu"
                    testId={test.id}
                    studentIds={test.assignment.studentIds}
                    classGroupIds={test.assignment.classGroupIds}
                    teacherIds={test.assignment.teacherIds}
                    allClassGroups={assignOptions.allClassGroups}
                    allTeachers={assignOptions.allTeachers}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── main export ────────────────────────────────────────────────────────────────

const VALID_KEYS: SortKey[] = ["name", "module", "status", "finished", "due_date", "created_at"];
const LS_KEY = "admin_tests_sort";

export default function TestsTableClient({
  tests,
  assignOptions,
}: {
  tests: TestRow[];
  assignOptions: AssignOptions;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const rawKey = searchParams.get("sort") as SortKey | null;
  const rawDir = searchParams.get("dir") as SortDir | null;

  const sortKey: SortKey | null = rawKey && VALID_KEYS.includes(rawKey) ? rawKey : null;
  const sortDir: SortDir = rawDir === "asc" || rawDir === "desc" ? rawDir : "asc";

  // On initial mount: if no ?sort in URL but localStorage has a saved preference,
  // push it to the URL so the URL reflects the active sort.
  useEffect(() => {
    if (rawKey) return; // URL already has a sort — nothing to do
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (!saved) return;
      const { sort, dir } = JSON.parse(saved) as { sort: unknown; dir: unknown };
      if (typeof sort === "string" && VALID_KEYS.includes(sort as SortKey)) {
        const params = new URLSearchParams(searchParams.toString());
        params.set("sort", sort);
        if (dir === "asc" || dir === "desc") params.set("dir", dir);
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      }
    } catch {
      // ignore corrupted storage
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally runs once on mount only

  const handleSort = useCallback(
    (key: SortKey) => {
      const nextDir: SortDir =
        sortKey === key ? (sortDir === "asc" ? "desc" : "asc") : "asc";

      const params = new URLSearchParams(searchParams.toString());
      params.set("sort", key);
      params.set("dir", nextDir);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });

      try {
        localStorage.setItem(LS_KEY, JSON.stringify({ sort: key, dir: nextDir }));
      } catch {
        // ignore
      }
    },
    [sortKey, sortDir, searchParams, router, pathname],
  );

  const activeTests = tests.filter((t) => t.status !== "Closed");
  const closedTests = tests.filter((t) => t.status === "Closed");

  if (tests.length === 0) return null;

  return (
    <>
      {activeTests.length > 0 && (
        <TestsTable
          rows={activeTests}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={handleSort}
          assignOptions={assignOptions}
        />
      )}
      {closedTests.length > 0 && (
        <details className="border-t border-divider">
          <summary className="px-5 py-3 text-sm text-soft-mute cursor-pointer hover:text-charcoal select-none">
            Closed tests ({closedTests.length})
          </summary>
          <TestsTable
            rows={closedTests}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            assignOptions={assignOptions}
          />
        </details>
      )}
    </>
  );
}
