"use client";

// My Tests table. Tests the teacher manages (on teacher_ids or created it;
// lib/test-manage) get the same status menu and bulk Publish / Close bar as
// Admin → Tests (TestStatusActions), through /api/teacher/tests/[id]/*.
// Other visible tests (class reach only) keep a plain badge, no checkbox.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { DataTable, HeadRow, Th, Td, DataRow, DetailItem, ExpandToggle, TwoLineCell } from "@/components/ui/data-table";
import { StatusBadge, SubjectTag, type TestStatus } from "@/components/ui/StatusBadge";
import { formatShortDate } from "@/lib/datetime";
import { BulkStatusBar, TestStatusMenu } from "@/app/(admin)/admin/tests/TestStatusActions";

const TEACHER_TESTS_API = "/api/teacher/tests";
const COL_SPAN = 8;

export interface TeacherTestRow {
  id: string;
  test_name: string;
  status: string;
  due_date: string | null;
  isFullLength: boolean;
  module: { section: string; module_number: number | null } | null;
  totalStudents: number;
  submittedCount: number;
  avgScore: number | null;
  /** May change the status (lib/test-manage). */
  manages: boolean;
}

function Table({
  rows,
  flTag,
  selected,
  onSelect,
  onChanged,
}: {
  rows: TeacherTestRow[];
  flTag: string;
  selected: Set<string>;
  onSelect: (id: string) => void;
  onChanged: (id: string, status: TestStatus) => void;
}) {
  return (
    <DataTable>
      <thead>
        <HeadRow>
          <Th kind="main" sticky="left">Test Name</Th>
          <Th priority="md">Section</Th>
          <Th>Status</Th>
          <Th priority="md">Students</Th>
          <Th>Submitted</Th>
          <Th priority="md">Avg Score</Th>
          <Th priority="lg">Due</Th>
          <Th kind="actions" sticky="right"><span className="sr-only">Actions</span></Th>
        </HeadRow>
      </thead>
      <tbody>
        {rows.map((test) => {
          const mod = test.module;
          const section = test.isFullLength ? (
            <SubjectTag fullLength label={flTag} />
          ) : mod ? (
            <span className="inline-flex items-center gap-1.5">
              <SubjectTag section={mod.section} />
              {mod.module_number ? <span>M{mod.module_number}</span> : null}
            </span>
          ) : (
            "Adaptive"
          );
          const dueLabel = test.due_date ? formatShortDate(test.due_date) : "—";

          return (
            <DataRow
              key={test.id}
              href={`/teacher/tests/${test.id}`}
              expandBelow="lg"
              colSpan={COL_SPAN}
              details={
                <>
                  <DetailItem label="Section" priority="md">{section}</DetailItem>
                  <DetailItem label="Students" priority="md">{String(test.totalStudents)}</DetailItem>
                  <DetailItem label="Avg Score" priority="md">{test.avgScore != null ? `${test.avgScore.toFixed(1)}%` : "—"}</DetailItem>
                  <DetailItem label="Due" priority="lg">{dueLabel}</DetailItem>
                </>
              }
            >
              <Td kind="main" sticky="left">
                <span className="flex min-w-0 items-start gap-2">
                  {test.manages && (
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 shrink-0 accent-warm-coral"
                      checked={selected.has(test.id)}
                      onChange={() => onSelect(test.id)}
                      aria-label={`Select ${test.test_name}`}
                    />
                  )}
                  <Link
                    href={`/teacher/tests/${test.id}`}
                    className="block min-w-0 flex-1 text-charcoal hover:text-warm-coral-text transition-colors"
                  >
                    <TwoLineCell main={test.test_name} wrapMain mainClassName="font-medium text-inherit" />
                  </Link>
                </span>
              </Td>
              <Td priority="md" className="text-mid-gray">
                {section}
              </Td>
              <Td>
                {test.manages ? (
                  <TestStatusMenu
                    testId={test.id}
                    testName={test.test_name}
                    status={test.status as TestStatus}
                    onChanged={onChanged}
                    apiBase={TEACHER_TESTS_API}
                    linkIssues={false}
                  />
                ) : (
                  <StatusBadge kind="test" status={test.status as TestStatus} />
                )}
              </Td>
              <Td priority="md" className="text-mid-gray">{test.totalStudents}</Td>
              <Td className="text-mid-gray">{test.submittedCount}</Td>
              <Td priority="md" className="text-mid-gray">
                {test.avgScore != null ? `${test.avgScore.toFixed(1)}%` : "—"}
              </Td>
              <Td priority="lg" className="text-soft-mute">
                {dueLabel}
              </Td>
              <Td kind="actions" sticky="right">
                <ExpandToggle label={`More about ${test.test_name}`} />
              </Td>
            </DataRow>
          );
        })}
      </tbody>
    </DataTable>
  );
}

export default function TeacherTestsTable({ tests: serverTests, flTag }: { tests: TeacherTestRow[]; flTag: string }) {
  const router = useRouter();
  // A status change shows at once; router.refresh() then brings the
  // server's rows, which replace these overrides.
  const [overrides, setOverrides] = useState<Record<string, TestStatus>>({});
  useEffect(() => setOverrides({}), [serverTests]);
  const tests = useMemo(
    () => serverTests.map((t) => (overrides[t.id] ? { ...t, status: overrides[t.id] } : t)),
    [serverTests, overrides],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const onSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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
    .filter((t) => t.manages && selected.has(t.id))
    .map((t) => ({ id: t.id, name: t.test_name, status: t.status as TestStatus }));

  // Closed tests sink into a collapsed section at the bottom so the
  // list shows what's live by default.
  const activeTests = tests.filter((t) => t.status !== "Closed");
  const closedTests = tests.filter((t) => t.status === "Closed");
  const tableProps = { flTag, selected, onSelect, onChanged: onOneChanged };

  return (
    <>
      {selectedRows.length > 0 && (
        <BulkStatusBar
          rows={selectedRows}
          onClear={() => setSelected(new Set())}
          onChanged={onStatusChanged}
          apiBase={TEACHER_TESTS_API}
        />
      )}
      {activeTests.length > 0 && <Table rows={activeTests} {...tableProps} />}
      {closedTests.length > 0 && (
        <details className="border-t border-divider">
          <summary className="px-3 py-3 text-sm text-soft-mute cursor-pointer hover:text-charcoal select-none">
            Closed tests ({closedTests.length})
          </summary>
          <Table rows={closedTests} {...tableProps} />
        </details>
      )}
    </>
  );
}
