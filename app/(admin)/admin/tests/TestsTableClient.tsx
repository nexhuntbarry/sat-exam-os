"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import { useTranslations } from "next-intl";
import type { ThHTMLAttributes } from "react";
import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
import { formatShortDate } from "@/lib/datetime";
import AssignDialog from "./[id]/AssignDialog";
import {
  DataTable,
  HeadRow,
  Th,
  Td,
  DataRow,
  DetailItem,
  EmptyRow,
  ExpandToggle,
  RowActions,
  TwoLineCell,
  type Priority,
  type Kind,
} from "@/components/ui/data-table";
import { SubjectTag, type TestStatus } from "@/components/ui/StatusBadge";
import { BulkStatusBar, TestStatusMenu } from "./TestStatusActions";

interface AssignOptions {
  allTeachers: { id: string; display_name: string | null; email: string }[];
  allClassGroups: { id: string; name: string; campus: string | null; grade: string | null }[];
}

// "13 students · 1 class · 1 teacher" (zeros left out), names for the hover.
function assignmentText(
  a: TestRow["assignment"],
  opts: AssignOptions,
): { assignments: string; assignmentNames: string | undefined } {
  const n = (count: number, one: string, many: string) => (count === 0 ? null : `${count} ${count === 1 ? one : many}`);
  const parts = [
    n(a.studentIds.length, "student", "students"),
    n(a.classGroupIds.length, "class", "classes"),
    n(a.teacherIds.length, "teacher", "teachers"),
  ].filter(Boolean);
  const classNames = a.classGroupIds.map((id) => opts.allClassGroups.find((g) => g.id === id)?.name ?? "Unknown class");
  const teacherNames = a.teacherIds.map((id) => {
    const t = opts.allTeachers.find((x) => x.id === id);
    return t ? t.display_name || t.email : "Unknown teacher";
  });
  const list = (label: string, names: string[]) =>
    names.length === 0 ? null : `${label}: ${names.slice(0, 30).join(", ")}${names.length > 30 ? `, +${names.length - 30} more` : ""}`;
  const hover = [list("Students", a.studentNames), list("Classes", classNames), list("Teachers", teacherNames)].filter(Boolean).join("\n");
  // Non-breaking inside each part, so a narrow column wraps between parts.
  return { assignments: parts.length ? parts.map((p) => p!.replace(/ /g, "\u00a0")).join("\u00a0· ") : "—", assignmentNames: hover || undefined };
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
  /** Linear two-module tests: the Module 2 (tests.module_2_id). */
  module_2?: unknown;
  assignment: { teacherIds: string[]; studentIds: string[]; classGroupIds: string[]; studentNames: string[] };
  submissions: { done: number; total: number };
  /** Full-length SAT parent: source test name per section (null = deleted). */
  fullLength?: { rw: string | null; math: string | null } | null;
}

type SortKey = "name" | "module" | "status" | "finished" | "due_date" | "created_at";
type SortDir = "asc" | "desc";

const STATUS_ORDER: Record<string, number> = { Draft: 0, Published: 1, Closed: 2 };

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

// ── sort header — wraps the kit Th with an inline sort button ─────────────────

type SortThProps = {
  label: string;
  sortKey: SortKey;
  active: boolean;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  kind?: Kind;
  priority?: Priority;
  sticky?: "left" | "right";
  className?: string;
  /** Rendered before the sort button (e.g. the select-all checkbox). */
  leading?: ReactNode;
} & Omit<ThHTMLAttributes<HTMLTableCellElement>, "onClick">;

function SortTh({ label, sortKey, active, dir, onSort, kind, priority, sticky, className, leading, ...thProps }: SortThProps) {
  const ariaSort: React.AriaAttributes["aria-sort"] = !active
    ? "none"
    : dir === "asc"
    ? "ascending"
    : "descending";

  return (
    <Th kind={kind} priority={priority} sticky={sticky} className={className} aria-sort={ariaSort} {...thProps}>
      {leading}
      <button
        onClick={() => onSort(sortKey)}
        className={clsx(
          "inline-flex items-center gap-1 hover:text-charcoal transition-colors",
          active ? "text-charcoal" : "",
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
    </Th>
  );
}

// ── table (shared for active + closed sections) ────────────────────────────────

function TestsTable({
  rows,
  sortKey,
  sortDir,
  onSort,
  assignOptions,
  selected,
  onSelect,
  onStatusChanged,
}: {
  rows: TestRow[];
  sortKey: SortKey | null;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  assignOptions: AssignOptions;
  selected: Set<string>;
  onSelect: (ids: string[], on: boolean) => void;
  onStatusChanged: (testId: string, status: TestStatus) => void;
}) {
  const tf = useTranslations("fullLength");
  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    return [...rows].sort((a, b) => compareTests(a, b, sortKey, sortDir));
  }, [rows, sortKey, sortDir]);

  // 8 columns total
  const COL_SPAN = 8;
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <DataTable>
      <thead>
        <HeadRow>
          <SortTh
            kind="main"
            sticky="left"
            className="w-[18%]"
            label="Test Name"
            sortKey="name"
            active={sortKey === "name"}
            dir={sortDir}
            onSort={onSort}
            leading={
              <input
                type="checkbox"
                className="mr-2 h-4 w-4 align-middle accent-warm-coral"
                checked={allSelected}
                onChange={() => onSelect(rows.map((r) => r.id), !allSelected)}
                aria-label="Select all tests in this table"
              />
            }
          />
          <SortTh kind="long" priority="md" className="w-[36%] xl:min-w-[19.5rem]" label="Module" sortKey="module" active={sortKey === "module"} dir={sortDir} onSort={onSort} />
          <SortTh label="Status" sortKey="status" active={sortKey === "status"} dir={sortDir} onSort={onSort} />
          <Th priority="lg" className="xl:min-w-[9.5rem]">Assignments</Th>
          <SortTh label="Finished" sortKey="finished" active={sortKey === "finished"} dir={sortDir} onSort={onSort} />
          <SortTh priority="xl" label="Due" sortKey="due_date" active={sortKey === "due_date"} dir={sortDir} onSort={onSort} />
          <SortTh priority="2xl" label="Created" sortKey="created_at" active={sortKey === "created_at"} dir={sortDir} onSort={onSort} />
          <Th kind="actions" sticky="right"><span className="sr-only">Actions</span></Th>
        </HeadRow>
      </thead>
      <tbody>
        {sorted.length === 0 && (
          <EmptyRow colSpan={COL_SPAN}>No tests found.</EmptyRow>
        )}
        {sorted.map((test) => {
          const mod = test.modules as TestMod | null;
          const mod2 = (test.module_2 ?? null) as Pick<TestMod, "module_name" | "module_number"> | null;

          // One line per module, like the student detail page:
          // "M1: [Test #19] … Module 1" / "M2: … Module 2".
          const moduleLines = mod && mod2
            ? [{ label: "M1", name: mod.module_name }, { label: "M2", name: mod2.module_name }]
            : mod
            ? [{ label: `M${mod.module_number ?? 1}`, name: mod.module_name }]
            : [];
          const moduleList = test.fullLength ? (
            ([["R&W", test.fullLength.rw], ["Math", test.fullLength.math]] as const).map(([label, name]) => (
              <div key={label} className="text-[11px] text-soft-mute leading-snug break-words">
                {label}: {name ?? <span className="italic">{tf("sourceDeleted")}</span>}
              </div>
            ))
          ) : moduleLines.length > 0 ? (
            moduleLines.map((m) => (
              <div key={m.label} className="text-[11px] text-soft-mute leading-snug break-words">
                {m.label}: {m.name}
              </div>
            ))
          ) : (
            <span className="text-[11px] text-soft-mute">Adaptive · multi-module</span>
          );

          const { assignments, assignmentNames } = assignmentText(test.assignment, assignOptions);
          const dueLabel = test.due_date ? formatShortDate(test.due_date) : "—";
          const createdLabel = formatShortDate(test.created_at);

          return (
            <DataRow
              key={test.id}
              href={`/admin/tests/${test.id}`}
              expandBelow="2xl"
              colSpan={COL_SPAN}
              details={
                <>
                  <DetailItem label="Module" priority="md">{moduleList}</DetailItem>
                  <DetailItem label="Assignments" priority="lg">{assignments}</DetailItem>
                  <DetailItem label="Due" priority="xl">{dueLabel}</DetailItem>
                  <DetailItem label="Created" priority="2xl">{createdLabel}</DetailItem>
                </>
              }
            >
              <Td kind="main" sticky="left">
                <span className="flex min-w-0 items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 shrink-0 accent-warm-coral"
                    checked={selected.has(test.id)}
                    onChange={() => onSelect([test.id], !selected.has(test.id))}
                    aria-label={`Select ${test.test_name}`}
                  />
                  <Link href={`/admin/tests/${test.id}`} className="block min-w-0 flex-1 text-charcoal hover:text-warm-coral-text transition-colors">
                    <TwoLineCell
                      main={test.test_name}
                      wrapMain
                      mainClassName="font-medium text-inherit"
                      detail={
                        test.fullLength ? (
                          <SubjectTag section={tf("tag")} />
                        ) : mod?.section || test.is_adaptive ? (
                          <span className="inline-flex items-center gap-1.5">
                            <SubjectTag section={mod?.section} />
                            {test.is_adaptive && <span>Adaptive</span>}
                          </span>
                        ) : undefined
                      }
                    />
                  </Link>
                </span>
              </Td>
              <Td priority="md" className="w-[36%] max-w-0 whitespace-normal">
                {moduleList}
              </Td>
              <Td>
                <TestStatusMenu
                  testId={test.id}
                  testName={test.test_name}
                  status={test.status as TestStatus}
                  onChanged={onStatusChanged}
                />
              </Td>
              <Td priority="lg" className="text-mid-gray whitespace-normal" title={assignmentNames}>
                {assignments}
              </Td>
              <Td className="text-mid-gray">
                {test.submissions.done} / {test.submissions.total}
              </Td>
              <Td priority="xl" className="text-soft-mute">
                {dueLabel}
              </Td>
              <Td priority="2xl" className="text-soft-mute">
                {createdLabel}
              </Td>
              <Td kind="actions" sticky="right">
                <RowActions>
                <ExpandToggle label={`More about ${test.test_name}`} />
                <AssignDialog
                  variant="menu"
                  testId={test.id}
                  studentIds={test.assignment.studentIds}
                  classGroupIds={test.assignment.classGroupIds}
                  teacherIds={test.assignment.teacherIds}
                  allClassGroups={assignOptions.allClassGroups}
                  allTeachers={assignOptions.allTeachers}
                />
                </RowActions>
              </Td>
            </DataRow>
          );
        })}
      </tbody>
    </DataTable>
  );
}

// ── main export ────────────────────────────────────────────────────────────────

const VALID_KEYS: SortKey[] = ["name", "module", "status", "finished", "due_date", "created_at"];
const LS_KEY = "admin_tests_sort";

export default function TestsTableClient({
  tests: serverTests,
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

  // A status change shows at once (no reload, scroll kept); router.refresh()
  // then brings the server's rows, which replace these overrides.
  const [overrides, setOverrides] = useState<Record<string, TestStatus>>({});
  useEffect(() => setOverrides({}), [serverTests]);
  const tests = useMemo(
    () => serverTests.map((t) => (overrides[t.id] ? { ...t, status: overrides[t.id] } : t)),
    [serverTests, overrides],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const onSelect = useCallback((ids: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);
  const onStatusChanged = useCallback(
    (changes: { id: string; status: TestStatus }[]) => {
      setOverrides((prev) => ({ ...prev, ...Object.fromEntries(changes.map((c) => [c.id, c.status])) }));
      router.refresh();
    },
    [router],
  );
  const onOneChanged = useCallback(
    (id: string, status: TestStatus) => onStatusChanged([{ id, status }]),
    [onStatusChanged],
  );
  const selectedRows = tests
    .filter((t) => selected.has(t.id))
    .map((t) => ({ id: t.id, name: t.test_name, status: t.status as TestStatus }));

  const activeTests = tests.filter((t) => t.status !== "Closed");
  const closedTests = tests.filter((t) => t.status === "Closed");

  if (tests.length === 0) return null;

  return (
    <>
      {selectedRows.length > 0 && (
        <BulkStatusBar rows={selectedRows} onClear={() => setSelected(new Set())} onChanged={onStatusChanged} />
      )}
      {activeTests.length > 0 && (
        <TestsTable
          rows={activeTests}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={handleSort}
          assignOptions={assignOptions}
          selected={selected}
          onSelect={onSelect}
          onStatusChanged={onOneChanged}
        />
      )}
      {closedTests.length > 0 && (
        <details className="border-t border-divider">
          <summary className="px-3 py-3 text-sm text-soft-mute cursor-pointer hover:text-charcoal select-none">
            Closed tests ({closedTests.length})
          </summary>
          <TestsTable
            rows={closedTests}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            assignOptions={assignOptions}
            selected={selected}
            onSelect={onSelect}
            onStatusChanged={onOneChanged}
          />
        </details>
      )}
    </>
  );
}
