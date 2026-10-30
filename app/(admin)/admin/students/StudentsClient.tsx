"use client";

import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import { Check, X, Search, Eye, Ban, RotateCcw } from "lucide-react";
import { formatDateTime, formatShortDate, formatShortDateTime } from "@/lib/datetime";
import { changeStudentStatus } from "./[id]/StudentStatusButton";
import {
  ColumnsPicker,
  DataRow,
  DataTable,
  DetailItem,
  EmptyRow,
  ExpandToggle,
  HeadRow,
  RowActionsMenu,
  Td,
  Th,
  TruncatedText,
  TwoLineCell,
  useColumnPrefs,
  type ColumnDef,
  type RowAction,
} from "@/components/ui/data-table";

const COLUMNS: ColumnDef[] = [
  { key: "student", label: "Student", locked: true },
  { key: "status", label: "Status", locked: true },
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

interface Student {
  id: string;
  email: string;
  display_name: string | null;
  account_status: string;
  created_at: string;
  clerk_user_id: string | null;
  last_sign_in_at: number | null;
  student_profiles: StudentProfile | StudentProfile[] | null;
  classes: string[];
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

type Filter = "all" | "pending" | "approved" | "suspended";

function getProfile(s: Student): StudentProfile | null {
  if (!s.student_profiles) return null;
  return Array.isArray(s.student_profiles) ? s.student_profiles[0] ?? null : s.student_profiles;
}

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
          {profile?.school && <p className="text-soft-mute">{profile.school}</p>}
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
  );
}

export default function StudentsClient({ students, classGroups }: Props) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [approveTarget, setApproveTarget] = useState<Student | null>(null);
  const [, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const cols = useColumnPrefs("admin-students", COLUMNS);

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
    startTransition(() => router.refresh());
  }

  async function handleSuspend(studentId: string) {
    const reason = prompt("Reject this student? They will not get access.\n\nReason (optional):");
    if (reason === null) return;
    const res = await fetch(`/api/admin/students/${studentId}/suspend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    if (res.ok) {
      startTransition(() => router.refresh());
    }
  }

  const counts = {
    all: students.length,
    pending: students.filter((s) => s.account_status === "pending").length,
    approved: students.filter((s) => s.account_status === "approved").length,
    suspended: students.filter((s) => s.account_status === "suspended").length,
  };

  const q = search.trim().toLowerCase();
  const matches = students.filter((s) => {
    if (filter !== "all" && s.account_status !== filter) return false;
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

  const chips: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "pending", label: "Pending" },
    { key: "approved", label: "Approved" },
    { key: "suspended", label: "Suspended" },
  ];

  return (
    <div className="space-y-6">
      {approveTarget && (
        <ApproveModal
          student={approveTarget}
          classGroups={classGroups}
          onClose={() => setApproveTarget(null)}
          onApproved={() => {
            setApproveTarget(null);
            startTransition(() => router.refresh());
          }}
        />
      )}

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-charcoal">Students</h1>
      </div>

      {counts.pending > 0 && (
        <div className="bg-status-warning/10 border border-status-warning/20 rounded-xl px-4 py-3 text-sm text-charcoal">
          <span className="font-semibold">
            {counts.pending} {counts.pending === 1 ? "student" : "students"} waiting for approval
          </span>
        </div>
      )}

      {/* Filter chips */}
      <div className="flex flex-wrap gap-2">
        {chips.map((t) => (
          <button
            key={t.key}
            onClick={() => setFilter(t.key)}
            className={clsx(
              "px-3.5 py-1.5 rounded-full text-sm font-medium border transition-colors",
              filter === t.key
                ? "bg-warm-coral text-white border-warm-coral"
                : "bg-surface border-divider text-mid-gray hover:text-charcoal"
            )}
          >
            {t.label} ({counts[t.key]})
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
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <ColumnsPicker prefs={cols} className="ml-auto" />
      </div>

      {actionError && (
        <p role="alert" className="text-status-error text-sm bg-status-error/10 border border-status-error/20 rounded-xl px-3 py-2">
          {actionError}
        </p>
      )}

      {/* Table — kit reference implementation, see docs/table-standard.md */}
      <DataTable>
        <thead>
          <HeadRow>
            <Th kind="main" sticky="left">Student</Th>
            <Th>Status</Th>
            {cols.isVisible("class") && <Th kind="long" priority="md" className="w-[16%]">Class</Th>}
            {cols.isVisible("gradeSchool") && <Th kind="long" priority="lg" className="w-[22%]">Grade &amp; school</Th>}
            {cols.isVisible("parent") && <Th kind="long" priority="xl" className="w-[18%]">Parent</Th>}
            {cols.isVisible("activity") && <Th priority="lg">Activity</Th>}
            <Th kind="actions" sticky="right"><span className="sr-only">Actions</span></Th>
          </HeadRow>
        </thead>
        <tbody>
          {filtered.length === 0 && (
            <EmptyRow colSpan={cols.visibleCount}>
              No {filter === "all" ? "" : `${filter} `}students found.
            </EmptyRow>
          )}
          {filtered.map((student) => {
            const profile = getProfile(student);
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
              student.clerk_user_id ? "Never signed in" : <span className="text-status-warning">never (pending)</span>
            );
            const registered = `Registered ${formatShortDate(student.created_at)}`;
            const activityTitle = `${lastSignIn ? `Last sign-in ${formatDateTime(student.last_sign_in_at)}` : "Never signed in"} · Registered ${formatDateTime(student.created_at)}`;

            const actions: (RowAction | false)[] = [
              { label: "View details", icon: Eye, href: `/admin/students/${student.id}` },
              student.account_status === "pending" && {
                label: "Approve…",
                icon: Check,
                onSelect: () => setApproveTarget(student),
              },
              student.account_status === "pending" && {
                label: "Reject…",
                icon: X,
                tone: "danger",
                onSelect: () => handleSuspend(student.id),
              },
              student.account_status === "approved" && {
                label: "Suspend…",
                icon: Ban,
                tone: "danger",
                disabled: busyId === student.id,
                onSelect: () => handleStatusChange(student),
              },
              student.account_status === "suspended" && {
                label: "Reactivate…",
                icon: RotateCcw,
                disabled: busyId === student.id,
                onSelect: () => handleStatusChange(student),
              },
            ];

            return (
              <DataRow
                key={student.id}
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
                  <Link
                    href={`/admin/students/${student.id}`}
                    className="block hover:text-warm-coral-text transition-colors"
                  >
                    <TwoLineCell
                      main={student.display_name ?? "—"}
                      detail={student.email}
                      mainClassName="font-medium text-inherit"
                    />
                  </Link>
                </Td>
                <Td>
                  <span
                    className={clsx(
                      "px-2 py-0.5 rounded-full text-xs font-medium capitalize",
                      student.account_status === "approved"
                        ? "bg-warm-amber/15 text-warm-amber"
                        : student.account_status === "pending"
                        ? "bg-status-warning/15 text-status-warning"
                        : "bg-status-error/15 text-status-error"
                    )}
                  >
                    {student.account_status}
                  </span>
                </Td>
                {cols.isVisible("class") && (
                  <Td kind="long" priority="md" className="text-mid-gray">
                    <TruncatedText>{classes}</TruncatedText>
                  </Td>
                )}
                {cols.isVisible("gradeSchool") && (
                  <Td kind="long" priority="lg" className="text-mid-gray">
                    <TruncatedText>{gradeSchool}</TruncatedText>
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
                  {busyId === student.id && <span className="mr-1 text-xs text-soft-mute">Saving…</span>}
                  <ExpandToggle label={`More about ${name}`} />
                  <RowActionsMenu label={`Actions for ${name}`} items={actions} />
                </Td>
              </DataRow>
            );
          })}
        </tbody>
      </DataTable>
    </div>
  );
}
