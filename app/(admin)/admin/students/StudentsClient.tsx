"use client";

import { useState, useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import { Check, X, Search, Ban, RotateCcw, Trash2, Plus, ClipboardList, UserMinus } from "lucide-react";
import { StatusBadge, studentStatusLabel } from "@/components/ui/StatusBadge";
import { formatDateTime, formatShortDate, formatShortDateTime } from "@/lib/datetime";
import { changeStudentStatus } from "./[id]/StudentStatusButton";
import DeleteStudentButton from "./[id]/DeleteStudentButton";
import {
  ColumnsPicker,
  DataRow,
  DataTable,
  ClampText,
  DetailItem,
  EmptyRow,
  ExpandToggle,
  HeadRow,
  RowActions,
  RowActionsMenu,
  RowButton,
  Td,
  Th,
  TruncatedText,
  TwoLineCell,
  useColumnPrefs,
  type ColumnDef,
  type RowAction,
} from "@/components/ui/data-table";
import { Portal } from "@/components/ui/Portal";

const COLUMNS: ColumnDef[] = [
  { key: "student", label: "Student", locked: true },
  { key: "status", label: "Status" },
  { key: "class", label: "Class" },
  { key: "gradeSchool", label: "Grade & school" },
  { key: "parent", label: "Parent" },
  { key: "activity", label: "Activity" },
  { key: "actions", label: "Actions", locked: true },
];

interface StudentProfile {
  grade: string | null;
  school: string | null;
  campus: string | null;
  class_group: string | null;
  parent_name: string | null;
  parent_email: string | null;
  parent_phone: string | null;
  target_score: number | null;
  current_level: string | null;
  status_reason: string | null;
}

interface CheckProfileFlag {
  reason: string;
  at: string;
}

interface Student {
  id: string;
  email: string;
  display_name: string | null;
  account_status: string;
  created_at: string;
  clerk_user_id: string | null;
  last_sign_in_at: number | null;
  metadata: Record<string, unknown> | null;
  student_profiles: StudentProfile | StudentProfile[] | null;
  classes: string[];
  classMemberships: { id: string; name: string }[];
}

interface ClassGroup {
  id: string;
  name: string;
  campus: string | null;
  grade: string | null;
}

interface Props {
  students: Student[];
  classGroups: ClassGroup[];
}

type Filter = "all" | "pending" | "approved" | "suspended" | "noClass" | "checkProfile";

function getCheckProfile(s: Student): CheckProfileFlag | null {
  const cp = s.metadata?.check_profile;
  if (!cp || typeof cp !== "object") return null;
  const { reason, at } = cp as Record<string, unknown>;
  if (typeof reason !== "string" || typeof at !== "string") return null;
  return { reason, at };
}

function getProfile(s: Student): StudentProfile | null {
  if (!s.student_profiles) return null;
  return Array.isArray(s.student_profiles) ? s.student_profiles[0] ?? null : s.student_profiles;
}

// ─── Modals ───────────────────────────────────────────────────────────────────

function ApproveModal({
  student,
  classGroups,
  onClose,
  onApproved,
}: {
  student: Student;
  classGroups: ClassGroup[];
  onClose: () => void;
  onApproved: () => void;
}) {
  const profile = getProfile(student);
  const [campus, setCampus] = useState(profile?.campus ?? "");
  const [classGroupId, setClassGroupId] = useState("");
  const [grade, setGrade] = useState(profile?.grade ?? "");
  const [targetScore, setTargetScore] = useState(
    profile?.target_score?.toString() ?? ""
  );
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleApprove() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/students/${student.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campus: campus || undefined,
          classGroupId: classGroupId || undefined,
          grade: grade || undefined,
          targetScore: targetScore ? parseInt(targetScore, 10) : undefined,
          notes: notes || undefined,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Failed to approve");
        return;
      }
      onApproved();
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  const inputCls =
    "w-full bg-surface border border-divider text-charcoal placeholder:text-soft-mute rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-warm-coral/50 transition-colors";

  return (
    <Portal>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div className="bg-surface border border-divider rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-charcoal text-lg">Approve Student</h2>
          <button onClick={onClose} className="text-soft-mute hover:text-charcoal">
            <X size={20} />
          </button>
        </div>

        <div className="bg-surface border border-divider rounded-xl p-4 text-sm space-y-1">
          <p className="text-charcoal font-medium">{student.display_name ?? student.email}</p>
          <p className="text-soft-mute">{student.email}</p>
          {getProfile(student)?.school && <p className="text-soft-mute">{getProfile(student)!.school}</p>}
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-mid-gray text-sm font-medium mb-1">Campus</label>
            <input
              className={inputCls}
              value={campus}
              onChange={(e) => setCampus(e.target.value)}
              placeholder="e.g. Main Campus"
            />
          </div>

          <div>
            <label className="block text-mid-gray text-sm font-medium mb-1">Class Group</label>
            <select
              className={inputCls}
              value={classGroupId}
              onChange={(e) => setClassGroupId(e.target.value)}
            >
              <option value="">— None —</option>
              {classGroups.map((cg) => (
                <option key={cg.id} value={cg.id}>
                  {cg.name}{cg.campus ? ` (${cg.campus})` : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-mid-gray text-sm font-medium mb-1">Grade</label>
              <select
                className={inputCls}
                value={grade}
                onChange={(e) => setGrade(e.target.value)}
              >
                <option value="">—</option>
                {["9", "10", "11", "12"].map((g) => (
                  <option key={g} value={g}>Grade {g}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-mid-gray text-sm font-medium mb-1">Target Score</label>
              <input
                type="number"
                min={400}
                max={1600}
                step={10}
                className={inputCls}
                value={targetScore}
                onChange={(e) => setTargetScore(e.target.value)}
                placeholder="400–1600"
              />
            </div>
          </div>

          <div>
            <label className="block text-mid-gray text-sm font-medium mb-1">Notes</label>
            <textarea
              className={`${inputCls} resize-none`}
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes for this student"
            />
          </div>
        </div>

        {error && (
          <p className="text-status-error text-sm bg-status-error/10 border border-status-error/20 rounded-xl px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex gap-3 pt-1">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-divider text-mid-gray hover:text-charcoal text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleApprove}
            disabled={loading}
            className="flex-1 py-2.5 rounded-xl bg-warm-amber hover:bg-warm-amber/90 text-charcoal font-semibold text-sm disabled:opacity-60 transition-colors"
          >
            {loading ? "Approving..." : "Approve"}
          </button>
        </div>
      </div>
    </div>
    </Portal>
  );
}

function AddToClassModal({
  studentIds,
  studentNames,
  classGroups,
  onClose,
  onDone,
  onSuccessful,
}: {
  studentIds: string[];
  studentNames: string[];
  classGroups: ClassGroup[];
  onClose: () => void;
  onDone: () => void;
  onSuccessful?: () => void;
}) {
  const [search, setSearch] = useState("");
  const [selectedClassId, setSelectedClassId] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const q = search.toLowerCase();
  const filtered = classGroups.filter(
    (cg) => !q || cg.name.toLowerCase().includes(q) || (cg.campus ?? "").toLowerCase().includes(q),
  );

  async function handleAdd() {
    if (!selectedClassId) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const results = await Promise.allSettled(
        studentIds.map((id) =>
          fetch(`/api/admin/class-groups/${selectedClassId}/members`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ studentId: id, action: "add" }),
          }),
        ),
      );
      const failedIdxs = results
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok))
        .map(({ i }) => i);
      const anyOk = failedIdxs.length < results.length;
      if (failedIdxs.length === 0) {
        setResult(`Added ${studentIds.length} student${studentIds.length !== 1 ? "s" : ""}`);
        setTimeout(onDone, 900);
      } else {
        const failedNames = failedIdxs.map((i) => studentNames[i] ?? studentIds[i]).join(", ");
        setError(`${failedIdxs.length} of ${studentIds.length} failed: ${failedNames}`);
        if (anyOk) onSuccessful?.();
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Portal>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div className="bg-surface border border-divider rounded-2xl w-full max-w-md shadow-2xl flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between p-5 border-b border-divider">
          <div>
            <h2 className="font-bold text-charcoal text-lg">Add to class</h2>
            <p className="text-soft-mute text-xs mt-0.5">
              {studentIds.length === 1 ? studentNames[0] : `${studentIds.length} students`}
            </p>
          </div>
          <button onClick={onClose} className="text-soft-mute hover:text-charcoal"><X size={20} /></button>
        </div>
        <div className="p-3 border-b border-divider">
          <div className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-soft-mute" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search classes…"
              autoFocus
              className="w-full pl-9 pr-3 py-2 bg-light-bg border border-divider rounded-xl text-sm text-charcoal placeholder:text-soft-mute focus:outline-none focus:border-warm-coral/50"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {filtered.map((cg) => (
            <button
              key={cg.id}
              onClick={() => setSelectedClassId(cg.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors ${
                selectedClassId === cg.id
                  ? "bg-warm-coral/15 text-charcoal"
                  : "hover:bg-light-bg text-charcoal"
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{cg.name}</div>
                {(cg.campus || cg.grade) && (
                  <div className="text-xs text-soft-mute">{[cg.campus, cg.grade && `Grade ${cg.grade}`].filter(Boolean).join(" · ")}</div>
                )}
              </div>
              {selectedClassId === cg.id && <Check size={14} className="text-warm-coral shrink-0" />}
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="text-center text-soft-mute text-sm py-6">No classes found.</p>
          )}
        </div>
        <div className="p-5 border-t border-divider flex items-center justify-between gap-3">
          <span className="text-xs text-soft-mute">
            {error && <span className="text-status-error">{error}</span>}
            {result && <span className="text-status-success">{result}</span>}
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-xl border border-divider text-mid-gray text-sm transition-colors hover:text-charcoal">Cancel</button>
            <button
              onClick={handleAdd}
              disabled={!selectedClassId || loading}
              className="px-4 py-2 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm disabled:opacity-50 transition-colors"
            >
              {loading ? "Adding…" : "Add"}
            </button>
          </div>
        </div>
      </div>
    </div>
    </Portal>
  );
}

function AssignTestModal({
  studentIds,
  studentNames,
  onClose,
  onDone,
}: {
  studentIds: string[];
  studentNames: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [search, setSearch] = useState("");
  const [tests, setTests] = useState<{ id: string; name: string; status: string | null; section: string | null }[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [selectedTestId, setSelectedTestId] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/tests?list=1")
      .then((r) => r.json())
      .then((j) => {
        const list = Array.isArray(j.data) ? j.data : [];
        setTests(
          list.map((t: { id: string; test_name: string; status: string | null; modules?: { section?: string } | { section?: string }[] | null }) => ({
            id: t.id,
            name: t.test_name,
            status: t.status,
            section: Array.isArray(t.modules) ? t.modules[0]?.section ?? null : (t.modules as { section?: string } | null)?.section ?? null,
          }))
        );
      })
      .catch(() => setFetchError("Failed to load tests"));
  }, []);

  const q = search.toLowerCase();
  const filtered = (tests ?? []).filter(
    (t) => !q || t.name.toLowerCase().includes(q),
  );

  async function handleAssign() {
    if (!selectedTestId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/tests/${selectedTestId}/add-students`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentIds }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        setResult(`Assigned to ${studentIds.length} student${studentIds.length !== 1 ? "s" : ""}`);
        setTimeout(onDone, 900);
      } else {
        setError((j as { error?: string }).error ?? "Failed");
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Portal>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div className="bg-surface border border-divider rounded-2xl w-full max-w-md shadow-2xl flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between p-5 border-b border-divider">
          <div>
            <h2 className="font-bold text-charcoal text-lg flex items-center gap-2">
              <ClipboardList size={16} />
              Assign test
            </h2>
            <p className="text-soft-mute text-xs mt-0.5">
              {studentIds.length === 1 ? studentNames[0] : `${studentIds.length} students`}
            </p>
          </div>
          <button onClick={onClose} className="text-soft-mute hover:text-charcoal"><X size={20} /></button>
        </div>
        <div className="p-3 border-b border-divider">
          <div className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-soft-mute" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tests…"
              autoFocus
              className="w-full pl-9 pr-3 py-2 bg-light-bg border border-divider rounded-xl text-sm text-charcoal placeholder:text-soft-mute focus:outline-none focus:border-warm-coral/50"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {tests === null && !fetchError && (
            <p className="text-center text-soft-mute text-sm py-6">Loading…</p>
          )}
          {fetchError && (
            <p className="text-center text-status-error text-sm py-6">{fetchError}</p>
          )}
          {tests !== null && filtered.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelectedTestId(t.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors ${
                selectedTestId === t.id ? "bg-warm-coral/15 text-charcoal" : "hover:bg-light-bg text-charcoal"
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{t.name}</div>
                {(t.status || t.section) && (
                  <div className="text-xs text-soft-mute">{[t.section, t.status].filter(Boolean).join(" · ")}</div>
                )}
              </div>
              {selectedTestId === t.id && <Check size={14} className="text-warm-coral shrink-0" />}
            </button>
          ))}
          {tests !== null && filtered.length === 0 && (
            <p className="text-center text-soft-mute text-sm py-6">{tests.length === 0 ? "No tests." : "No tests match."}</p>
          )}
        </div>
        <div className="p-5 border-t border-divider flex items-center justify-between gap-3">
          <span className="text-xs">
            {error && <span className="text-status-error">{error}</span>}
            {result && <span className="text-status-success">{result}</span>}
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-xl border border-divider text-mid-gray text-sm transition-colors hover:text-charcoal">Cancel</button>
            <button
              onClick={handleAssign}
              disabled={!selectedTestId || loading}
              className="px-4 py-2 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm disabled:opacity-50 transition-colors"
            >
              {loading ? "Assigning…" : "Assign"}
            </button>
          </div>
        </div>
      </div>
    </div>
    </Portal>
  );
}

interface InProgressTest {
  id: string;
  name: string;
  inProgressCount: number;
}

function RemoveFromClassModal({
  students,
  onClose,
  onDone,
  onSuccessful,
}: {
  students: Student[];
  onClose: () => void;
  onDone: () => void;
  onSuccessful?: () => void;
}) {
  // Intersection: classes where at least one selected student is a member
  const classMap = new Map<string, { id: string; name: string; count: number }>();
  for (const s of students) {
    for (const m of s.classMemberships) {
      const existing = classMap.get(m.id);
      classMap.set(m.id, { id: m.id, name: m.name, count: (existing?.count ?? 0) + 1 });
    }
  }
  const classes = Array.from(classMap.values()).sort((a, b) => a.name.localeCompare(b.name));

  const [selectedClassId, setSelectedClassId] = useState("");
  const [inProgressCheck, setInProgressCheck] = useState<
    null | "loading" | "check-failed" | InProgressTest[]
  >(null);
  const [confirmStep, setConfirmStep] = useState<"pick" | "warn-inprogress">("pick");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Track the latest check request to discard stale responses.
  const checkRequestIdRef = useRef(0);

  async function pickClass(cgId: string) {
    setSelectedClassId(cgId);
    setConfirmStep("pick");
    setInProgressCheck("loading");
    const requestId = ++checkRequestIdRef.current;
    const studentIds = students
      .filter((s) => s.classMemberships.some((m) => m.id === cgId))
      .map((s) => s.id);
    try {
      const res = await fetch(
        `/api/admin/class-groups/${cgId}/in-progress-check`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ studentIds }),
        },
      );
      if (checkRequestIdRef.current !== requestId) return; // stale — discard
      if (res.ok) {
        const j = (await res.json()) as { tests?: InProgressTest[] };
        setInProgressCheck(j.tests ?? []);
      } else {
        setInProgressCheck("check-failed");
      }
    } catch {
      if (checkRequestIdRef.current !== requestId) return;
      setInProgressCheck("check-failed");
    }
  }

  async function handleRemove() {
    if (!selectedClassId) return;
    const toRemove = students.filter((s) => s.classMemberships.some((m) => m.id === selectedClassId));
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.allSettled(
        toRemove.map((s) =>
          fetch(`/api/admin/class-groups/${selectedClassId}/members`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ studentId: s.id, action: "remove" }),
          }),
        ),
      );
      const failedIdxs = results
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok))
        .map(({ i }) => i);
      const anyOk = failedIdxs.length < results.length;
      if (failedIdxs.length === 0) {
        setResult(`Removed ${toRemove.length} student${toRemove.length !== 1 ? "s" : ""}`);
        setTimeout(onDone, 900);
      } else {
        const failedNames = failedIdxs
          .map((i) => toRemove[i]?.display_name ?? toRemove[i]?.email ?? toRemove[i]?.id)
          .join(", ");
        setError(`${failedIdxs.length} of ${toRemove.length} failed: ${failedNames}`);
        if (anyOk) onSuccessful?.();
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  function handleRemoveClick() {
    if (!selectedClassId) return;
    const testsWithInProgress = Array.isArray(inProgressCheck)
      ? inProgressCheck.filter((t) => t.inProgressCount > 0)
      : [];
    if (confirmStep === "pick" && (testsWithInProgress.length > 0 || inProgressCheck === "check-failed")) {
      setConfirmStep("warn-inprogress");
      return;
    }
    void handleRemove();
  }

  const testsWithInProgress = Array.isArray(inProgressCheck)
    ? inProgressCheck.filter((t) => t.inProgressCount > 0)
    : [];
  const checkingNow = inProgressCheck === "loading";
  const checkFailed = inProgressCheck === "check-failed";

  return (
    <Portal>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div className="bg-surface border border-divider rounded-2xl w-full max-w-md shadow-2xl flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between p-5 border-b border-divider">
          <div>
            <h2 className="font-bold text-charcoal text-lg flex items-center gap-2">
              <UserMinus size={16} />
              Remove from class
            </h2>
            <p className="text-soft-mute text-xs mt-0.5">
              {students.length === 1 ? (students[0].display_name ?? students[0].email) : `${students.length} students`}
            </p>
          </div>
          <button onClick={onClose} className="text-soft-mute hover:text-charcoal"><X size={20} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {classes.length === 0 ? (
            <p className="text-center text-soft-mute text-sm py-6">None of the selected students are in any class.</p>
          ) : (
            classes.map((cg) => (
              <button
                key={cg.id}
                onClick={() => void pickClass(cg.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors ${
                  selectedClassId === cg.id ? "bg-status-error/10 text-charcoal" : "hover:bg-light-bg text-charcoal"
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{cg.name}</div>
                  <div className="text-xs text-soft-mute">{cg.count} of {students.length} selected student{students.length !== 1 ? "s" : ""} in this class</div>
                </div>
                {selectedClassId === cg.id && <Check size={14} className="text-status-error shrink-0" />}
              </button>
            ))
          )}
        </div>

        {/* In-progress warning (shown after check completes with > 0 results) */}
        {confirmStep === "warn-inprogress" && (
          checkFailed ? (
            <div className="mx-5 mb-0 mt-0 rounded-xl bg-status-warning/10 border border-status-warning/30 px-4 py-3 text-sm space-y-1">
              <p className="font-semibold text-charcoal">Couldn&apos;t check who is mid-test — remove anyway?</p>
              <p className="text-xs text-soft-mute">The in-progress check failed. Students mid-exam can still finish their current attempt after removal.</p>
            </div>
          ) : testsWithInProgress.length > 0 ? (
            <div className="mx-5 mb-0 mt-0 rounded-xl bg-status-warning/10 border border-status-warning/30 px-4 py-3 text-sm space-y-1.5">
              <p className="font-semibold text-charcoal">
                {testsWithInProgress.reduce((s, t) => s + t.inProgressCount, 0)} student
                {testsWithInProgress.reduce((s, t) => s + t.inProgressCount, 0) !== 1 ? "s have" : " has"} an In Progress submission:
              </p>
              <ul className="text-soft-mute text-xs space-y-0.5 ml-2">
                {testsWithInProgress.map((t) => (
                  <li key={t.id}>· {t.name} ({t.inProgressCount} student{t.inProgressCount !== 1 ? "s" : ""})</li>
                ))}
              </ul>
              <p className="text-xs text-soft-mute">
                They can finish their current attempt but cannot start a new one after removal.
              </p>
            </div>
          ) : null
        )}

        <div className="p-5 border-t border-divider flex items-center justify-between gap-3">
          <span className="text-xs">
            {error && <span className="text-status-error">{error}</span>}
            {result && <span className="text-status-success">{result}</span>}
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-xl border border-divider text-mid-gray text-sm transition-colors hover:text-charcoal">Cancel</button>
            <button
              onClick={handleRemoveClick}
              disabled={!selectedClassId || loading || classes.length === 0 || checkingNow}
              className="px-4 py-2 rounded-xl bg-status-error hover:bg-status-error/90 text-white font-semibold text-sm disabled:opacity-50 transition-colors"
            >
              {loading ? "Removing…" : checkingNow ? "Checking…" : confirmStep === "warn-inprogress" ? (checkFailed ? "Remove anyway" : "Remove anyway") : "Remove"}
            </button>
          </div>
        </div>
      </div>
    </div>
    </Portal>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export default function StudentsClient({ students, classGroups }: Props) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [approveTarget, setApproveTarget] = useState<Student | null>(null);
  const [, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Student | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const [bulkModal, setBulkModal] = useState<"addToClass" | "assignTest" | "removeFromClass" | null>(null);
  const [singleTarget, setSingleTarget] = useState<Student | null>(null);
  const cols = useColumnPrefs("admin-students", COLUMNS);

  function refresh() {
    startTransition(() => router.refresh());
  }

  // Bulk approve (pending only, single-approve route in a loop)
  async function approveMany(ids: string[]) {
    if (ids.length === 0 || bulk) return;
    const noun = ids.length === 1 ? "student" : "students";
    if (!confirm(`Approve ${ids.length} ${noun}? They will get access and an approval email.`)) return;
    setActionError(null);
    setBulk({ done: 0, total: ids.length });
    const failed: string[] = [];
    for (const [i, id] of ids.entries()) {
      try {
        const res = await fetch(`/api/admin/students/${id}/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        if (!res.ok) failed.push(id);
      } catch {
        failed.push(id);
      }
      setBulk({ done: i + 1, total: ids.length });
    }
    setBulk(null);
    setSelected(new Set(failed));
    if (failed.length > 0) {
      const names = failed.map((id) => {
        const s = students.find((x) => x.id === id);
        return s?.display_name ?? s?.email ?? id;
      });
      setActionError(`Could not approve ${failed.length} of ${ids.length}: ${names.join(", ")}`);
    }
    refresh();
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleStatusChange(student: Student) {
    const result = await changeStudentStatus(
      {
        studentId: student.id,
        studentName: student.display_name ?? student.email,
        status: student.account_status,
      },
      () => {
        setBusyId(student.id);
        setActionError(null);
      },
    );
    setBusyId(null);
    if (!result) return;
    if (!result.ok) {
      setActionError(`${student.display_name ?? student.email}: ${result.error}`);
      return;
    }
    refresh();
  }

  async function handleSuspend(studentId: string) {
    const reason = prompt(
      "Reject this student? They won't get access.\n\n" +
        "Their email stays tied to this rejected account, so it can't register again. " +
        "If this is a teacher who signed up as a student, open the student and use Change role instead (this also approves them). " +
        "To free the email, use Delete student.\n\n" +
        "Reason (optional):",
    );
    if (reason === null) return;
    const res = await fetch(`/api/admin/students/${studentId}/suspend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    if (res.ok) refresh();
  }

  const noClassCount = students.filter((s) => s.classes.length === 0).length;
  const checkProfileCount = students.filter((s) => !!getCheckProfile(s)).length;

  const counts = {
    all: students.length,
    pending: students.filter((s) => s.account_status === "pending").length,
    approved: students.filter((s) => s.account_status === "approved").length,
    suspended: students.filter((s) => s.account_status === "suspended").length,
    noClass: noClassCount,
    checkProfile: checkProfileCount,
  };

  const q = search.trim().toLowerCase();
  const matches = students.filter((s) => {
    if (filter === "noClass") {
      if (s.classes.length !== 0) return false;
    } else if (filter === "checkProfile") {
      if (!getCheckProfile(s)) return false;
    } else if (filter !== "all" && s.account_status !== filter) {
      return false;
    }
    if (!q) return true;
    const profile = getProfile(s);
    return (
      (s.display_name ?? "").toLowerCase().includes(q) ||
      s.email.toLowerCase().includes(q) ||
      (profile?.grade ?? "").includes(q) ||
      (profile?.school ?? "").toLowerCase().includes(q) ||
      (profile?.campus ?? "").toLowerCase().includes(q)
    );
  });
  // Pending always first; otherwise keep the server order (newest first).
  const filtered = [
    ...matches.filter((s) => s.account_status === "pending"),
    ...matches.filter((s) => s.account_status !== "pending"),
  ];

  const pendingIds = students.filter((s) => s.account_status === "pending").map((s) => s.id);
  const selectedPending = pendingIds.filter((id) => selected.has(id));
  const visibleIds = filtered.map((s) => s.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  // Students currently selected (for bulk modals)
  const selectedStudents = filtered.filter((s) => selected.has(s.id));

  const chips: { key: Filter; label: string; count: number }[] = [
    { key: "all", label: "All", count: counts.all },
    { key: "pending", label: "Pending", count: counts.pending },
    { key: "approved", label: "Active", count: counts.approved },
    { key: "suspended", label: "Suspended", count: counts.suspended },
    { key: "noClass", label: "No class", count: counts.noClass },
    { key: "checkProfile", label: "Check profile", count: counts.checkProfile },
  ];

  // Determine which students to pass to single-action modals
  const modalStudentIds = singleTarget ? [singleTarget.id] : selectedStudents.map((s) => s.id);
  const modalStudentNames = singleTarget
    ? [singleTarget.display_name ?? singleTarget.email]
    : selectedStudents.map((s) => s.display_name ?? s.email);
  const modalStudents = singleTarget ? [singleTarget] : selectedStudents;

  function openBulkModal(mode: "addToClass" | "assignTest" | "removeFromClass", target?: Student) {
    setSingleTarget(target ?? null);
    setBulkModal(mode);
  }

  function closeBulkModal() {
    setBulkModal(null);
    setSingleTarget(null);
  }

  function handleModalDone() {
    closeBulkModal();
    if (!singleTarget) setSelected(new Set());
    refresh();
  }

  return (
    <div className="space-y-6">
      {approveTarget && (
        <ApproveModal
          student={approveTarget}
          classGroups={classGroups}
          onClose={() => setApproveTarget(null)}
          onApproved={() => {
            setApproveTarget(null);
            refresh();
          }}
        />
      )}

      {bulkModal === "addToClass" && (
        <AddToClassModal
          studentIds={modalStudentIds}
          studentNames={modalStudentNames}
          classGroups={classGroups}
          onClose={closeBulkModal}
          onDone={handleModalDone}
          onSuccessful={refresh}
        />
      )}

      {bulkModal === "assignTest" && (
        <AssignTestModal
          studentIds={modalStudentIds}
          studentNames={modalStudentNames}
          onClose={closeBulkModal}
          onDone={handleModalDone}
        />
      )}

      {bulkModal === "removeFromClass" && (
        <RemoveFromClassModal
          students={modalStudents}
          onClose={closeBulkModal}
          onDone={handleModalDone}
          onSuccessful={refresh}
        />
      )}

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-charcoal">Students</h1>
      </div>

      {deleteTarget && (
        <DeleteStudentButton
          studentId={deleteTarget.id}
          studentName={deleteTarget.display_name ?? deleteTarget.email}
          email={deleteTarget.email}
          open
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            setDeleteTarget(null);
            refresh();
          }}
        />
      )}

      {counts.pending > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-status-warning/10 border border-status-warning/20 rounded-xl px-4 py-3 text-sm text-charcoal">
          <span className="font-semibold">
            {counts.pending} {counts.pending === 1 ? "student" : "students"} waiting for approval
          </span>
          <span className="text-soft-mute" aria-hidden>·</span>
          <button
            type="button"
            disabled={bulk !== null}
            onClick={() => approveMany(pendingIds)}
            className="font-semibold text-warm-coral-text hover:underline disabled:opacity-50"
          >
            Approve all
          </button>
          {selectedPending.length > 0 && (
            <button
              type="button"
              disabled={bulk !== null}
              onClick={() => approveMany(selectedPending)}
              className="ml-auto inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg bg-warm-coral px-3 text-xs font-semibold text-white hover:bg-warm-coral-dark disabled:opacity-50"
            >
              <Check size={13} />
              Approve selected ({selectedPending.length})
            </button>
          )}
          {bulk && (
            <span role="status" className="text-xs text-soft-mute">
              Approving {bulk.done}/{bulk.total}…
            </span>
          )}
        </div>
      )}

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 bg-surface border border-warm-coral/30 rounded-xl px-4 py-3">
          <span className="text-sm font-semibold text-charcoal mr-1">
            {selected.size} selected
          </span>
          <button
            onClick={() => openBulkModal("addToClass")}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-divider text-mid-gray hover:text-charcoal text-xs font-medium transition-colors"
          >
            <Plus size={12} />
            Add to class
          </button>
          <button
            onClick={() => openBulkModal("assignTest")}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-divider text-mid-gray hover:text-charcoal text-xs font-medium transition-colors"
          >
            <ClipboardList size={12} />
            Assign test
          </button>
          <button
            onClick={() => openBulkModal("removeFromClass")}
            disabled={!selectedStudents.some((s) => s.classMemberships.length > 0)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-divider text-mid-gray hover:text-charcoal text-xs font-medium transition-colors disabled:opacity-40"
          >
            <UserMinus size={12} />
            Remove from class
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="ml-auto text-soft-mute hover:text-charcoal"
            aria-label="Clear selection"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Filter chips */}
      <div className="flex flex-wrap gap-2">
        {chips.map((t) => (
          <button
            key={t.key}
            onClick={() => { setFilter(t.key); setSelected(new Set()); }}
            className={clsx(
              "px-3.5 py-1.5 rounded-full text-sm font-medium border transition-colors",
              filter === t.key
                ? "bg-warm-coral text-white border-warm-coral"
                : "bg-surface border-divider text-mid-gray hover:text-charcoal"
            )}
          >
            {t.label} ({t.count})
          </button>
        ))}
      </div>

      {/* Search + column picker */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-soft-mute" />
          <input
            className="w-full bg-surface border border-divider text-charcoal placeholder:text-soft-mute rounded-xl pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:border-warm-coral/50 transition-colors"
            placeholder="Search by name, email, grade, school..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setSelected(new Set()); }}
          />
        </div>
        <ColumnsPicker prefs={cols} className="ml-auto" />
      </div>

      {actionError && (
        <p role="alert" className="text-status-error text-sm bg-status-error/10 border border-status-error/20 rounded-xl px-3 py-2">
          {actionError}
        </p>
      )}

      {/* Table */}
      <DataTable>
        <thead>
          <HeadRow>
            <Th kind="main" sticky="left">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-warm-coral"
                  checked={allVisibleSelected}
                  onChange={() =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      for (const id of visibleIds) {
                        if (allVisibleSelected) next.delete(id);
                        else next.add(id);
                      }
                      return next;
                    })
                  }
                  aria-label="Select all visible students"
                />
                Student
              </label>
            </Th>
            {cols.isVisible("status") && <Th>Status</Th>}
            {cols.isVisible("class") && <Th kind="long" priority="md" className="w-[16%]">Class</Th>}
            {cols.isVisible("gradeSchool") && <Th kind="long" priority="lg" className="w-[26%]">Grade &amp; school</Th>}
            {cols.isVisible("parent") && <Th kind="long" priority="xl" className="w-[18%]">Parent</Th>}
            {cols.isVisible("activity") && <Th priority="lg">Activity</Th>}
            <Th kind="actions" sticky="right"><span className="sr-only">Actions</span></Th>
          </HeadRow>
        </thead>
        <tbody>
          {filtered.length === 0 && (
            <EmptyRow colSpan={cols.visibleCount}>
              {filter === "noClass"
                ? "No students without a class found."
                : filter === "checkProfile"
                ? "No students flagged for profile check."
                : `No ${filter === "all" ? "" : `${filter} `}students found.`}
            </EmptyRow>
          )}
          {filtered.map((student) => {
            const profile = getProfile(student);
            const checkProfile = getCheckProfile(student);
            const name = student.display_name ?? student.email;
            const classes = student.classes.length > 0 ? student.classes.join(", ") : "—";
            const gradeSchool =
              [profile?.grade, profile?.school].filter(Boolean).join(" · ") || "—";
            const parentContact = profile?.parent_phone || profile?.parent_email || "";
            const parentAll = [profile?.parent_name, profile?.parent_phone, profile?.parent_email]
              .filter(Boolean)
              .join(" · ");
            const lastSignIn = student.last_sign_in_at
              ? formatShortDateTime(student.last_sign_in_at)
              : null;
            const activityMain = lastSignIn ?? (
              student.clerk_user_id ? "Never signed in" : <span className="text-soft-mute">Not signed up yet</span>
            );
            const registered = `Registered ${formatShortDate(student.created_at)}`;
            const activityTitle = `${lastSignIn ? `Last sign-in ${formatDateTime(student.last_sign_in_at)}` : "Never signed in"} · Registered ${formatDateTime(student.created_at)}`;

            const isPending = student.account_status === "pending";
            const busy = busyId === student.id || bulk !== null;
            const actions: (RowAction | false)[] = [
              {
                label: "Add to class…",
                icon: Plus,
                onSelect: () => openBulkModal("addToClass", student),
              },
              {
                label: "Assign test…",
                icon: ClipboardList,
                onSelect: () => openBulkModal("assignTest", student),
              },
              student.classMemberships.length > 0 && {
                label: "Remove from class…",
                icon: UserMinus,
                tone: "danger" as const,
                onSelect: () => openBulkModal("removeFromClass", student),
              },
              student.account_status === "approved" && {
                label: "Suspend…",
                icon: Ban,
                tone: "danger" as const,
                disabled: busy,
                onSelect: () => handleStatusChange(student),
              },
              student.account_status === "suspended" && {
                label: "Delete…",
                icon: Trash2,
                tone: "danger" as const,
                disabled: busy,
                onSelect: () => setDeleteTarget(student),
              },
            ];

            return (
              <DataRow
                key={student.id}
                href={`/admin/students/${student.id}`}
                tone={student.account_status === "pending" ? "warning" : "default"}
                expandBelow="xl"
                colSpan={cols.visibleCount}
                details={
                  <>
                    {cols.isVisible("class") && <DetailItem label="Class" priority="md">{classes}</DetailItem>}
                    {cols.isVisible("gradeSchool") && <DetailItem label="Grade & school" priority="lg">{gradeSchool}</DetailItem>}
                    {cols.isVisible("parent") && (
                      <DetailItem label="Parent" priority="xl">{parentAll || "—"}</DetailItem>
                    )}
                    {cols.isVisible("activity") && (
                      <DetailItem label="Activity" priority="lg">
                        {lastSignIn ? `Last sign-in ${lastSignIn}` : activityMain} · {registered}
                      </DetailItem>
                    )}
                  </>
                }
              >
                <Td kind="main" sticky="left">
                  <span className="flex min-w-0 items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 shrink-0 accent-warm-coral"
                      checked={selected.has(student.id)}
                      onChange={() => toggleSelected(student.id)}
                      aria-label={`Select ${name}`}
                    />
                    <Link
                      href={`/admin/students/${student.id}`}
                      className="block min-w-0 flex-1 hover:text-warm-coral-text transition-colors"
                    >
                      <TwoLineCell
                        main={student.display_name ?? "—"}
                        detail={student.email}
                        wrapMain
                        mainClassName="font-medium text-inherit"
                      />
                      {checkProfile && (
                        <span
                          className="mt-0.5 inline-block px-1.5 py-0.5 rounded-md bg-warm-amber/20 text-warm-amber text-[10px] font-semibold leading-tight"
                          title={checkProfile.reason}
                        >
                          Check profile
                        </span>
                      )}
                    </Link>
                  </span>
                </Td>
                {cols.isVisible("status") && (
                  <Td>
                    <StatusBadge kind="student" status={studentStatusLabel(student.account_status)} />
                  </Td>
                )}
                {cols.isVisible("class") && (
                  <Td kind="long" priority="md">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <TruncatedText className="text-mid-gray flex-1">{classes}</TruncatedText>
                      <button
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); openBulkModal("addToClass", student); }}
                        className="shrink-0 text-soft-mute hover:text-warm-coral-text transition-colors"
                        title="Add to class"
                        aria-label={`Add ${name} to a class`}
                      >
                        <Plus size={13} />
                      </button>
                    </span>
                  </Td>
                )}
                {cols.isVisible("gradeSchool") && (
                  <Td kind="long" priority="lg" className="text-mid-gray">
                    <ClampText>{gradeSchool}</ClampText>
                  </Td>
                )}
                {cols.isVisible("parent") && (
                  <Td kind="long" priority="xl">
                    <TwoLineCell
                      main={profile?.parent_name ?? "—"}
                      detail={parentContact}
                      mainTitle={parentAll || undefined}
                      detailTitle={parentAll || undefined}
                      mainClassName="text-mid-gray"
                    />
                  </Td>
                )}
                {cols.isVisible("activity") && (
                  <Td priority="lg">
                    <span className="block" title={activityTitle}>
                      <span className="block text-mid-gray">{activityMain}</span>
                      <span className="block text-xs text-soft-mute">{registered}</span>
                    </span>
                  </Td>
                )}
                <Td kind="actions" sticky="right">
                  <RowActions>
                    {busyId === student.id && <span className="text-xs text-soft-mute">Saving…</span>}
                    <ExpandToggle label={`More about ${name}`} />
                    {isPending && (
                      <>
                        <RowButton
                          label="Approve"
                          tone="primary"
                          icon={<Check size={13} />}
                          disabled={busy}
                          onClick={() => setApproveTarget(student)}
                        />
                        <RowButton
                          label="Reject"
                          tone="danger"
                          icon={<X size={13} />}
                          disabled={busy}
                          onClick={() => handleSuspend(student.id)}
                        />
                      </>
                    )}
                    {student.account_status === "suspended" && (
                      <RowButton
                        label="Reactivate"
                        icon={<RotateCcw size={13} />}
                        disabled={busy}
                        onClick={() => handleStatusChange(student)}
                      />
                    )}
                    <RowActionsMenu label={`Actions for ${name}`} items={actions} />
                  </RowActions>
                </Td>
              </DataRow>
            );
          })}
        </tbody>
      </DataTable>
    </div>
  );
}
