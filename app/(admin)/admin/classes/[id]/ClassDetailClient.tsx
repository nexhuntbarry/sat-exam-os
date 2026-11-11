"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserMinus, GraduationCap, ShieldCheck, Trash2, AlertTriangle, Pencil, ClipboardList, Eye } from "lucide-react";
import { formatShortDate } from "@/lib/datetime";
import {
  DataRow,
  DataTable,
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
} from "@/components/ui/data-table";
import { Portal } from "@/components/ui/Portal";
import { DetailHeader, StatCards } from "@/components/ui/DetailHeader";
import { StatusBadge, SubjectTag, type TestStatus } from "@/components/ui/StatusBadge";
import SearchablePicker, { type PickerItem } from "@/components/ui/SearchablePicker";
import AssignTestButton, { type AvailableTest } from "./AssignTestButton";
import ClassGradebook from "@/components/analytics/ClassGradebook";
import type { Gradebook } from "@/lib/class-gradebook-view";

export interface AssignedTest {
  id: string;
  name: string;
  section: string | null;
  openDate: string | null;
  dueDate: string | null;
  status: string | null;
  /** From the Scores gradebook's column; null when it couldn't load. */
  progress: {
    /** Students with a finished attempt. */
    submitted: number;
    /** Students whose latest attempt isn't finished (a retake in progress counts). */
    inProgress: number;
    total: number;
    /** % correct, secondary to avgSat. */
    avgScore: number | null;
    avgSat: number | null;
  } | null;
}

interface ClassGroup {
  id: string;
  name: string;
  campus: string | null;
  grade: string | null;
}

interface Member {
  id: string;
  student_id: string;
  users: {
    id: string;
    email: string;
    display_name: string | null;
    student_profiles: { grade: string | null; school: string | null } | null;
  } | null;
}

interface Student {
  id: string;
  email: string;
  display_name: string | null;
  account_status: string;
  grade: string | null;
  school: string | null;
}

interface Teacher {
  id: string;
  email: string;
  display_name: string | null;
  can_review_questions: boolean;
}

interface AssignedTeacher extends Teacher {
  assigned_at: string;
  /** "Math" | "Reading & Writing" | null (both). Scopes which subject's
   *  tests this teacher sees for this class. */
  subject: string | null;
}

interface Props {
  classGroup: ClassGroup;
  members: Member[];
  allStudents: Student[];
  allTeachers: Teacher[];
  assignedTeachers: AssignedTeacher[];
  linkedTests: { id: string; name: string }[];
  assignedTests: AssignedTest[];
  availableTests: AvailableTest[];
  /** null = it couldn't load (the Scores section says so). */
  gradebook: Gradebook | null;
}

export default function ClassDetailClient({
  classGroup,
  members,
  allStudents,
  allTeachers,
  assignedTeachers,
  linkedTests,
  assignedTests,
  availableTests,
  gradebook,
}: Props) {
  const router = useRouter();

  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(classGroup.name);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);

  async function saveName() {
    const name = newName.trim();
    if (!name) {
      setRenameError("Name cannot be empty");
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    try {
      const res = await fetch(`/api/admin/class-groups/${classGroup.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setRenameError(j.error ?? "Failed to rename");
        return;
      }
      setRenaming(false);
      router.refresh();
    } catch {
      setRenameError("Network error");
    } finally {
      setRenameBusy(false);
    }
  }
  const [, startTransition] = useTransition();
  const [loading, setLoading] = useState(false);
  const [teacherLoading, setTeacherLoading] = useState(false);

  const memberIds = new Set(members.map((m) => m.student_id));

  // Build picker items for students; alreadyIn marks existing members,
  // meta shows grade/school, accountStatus marks pending/suspended.
  const studentPickerItems: PickerItem[] = allStudents.map((s) => ({
    id: s.id,
    label: s.display_name ?? s.email,
    sublabel: s.display_name ? s.email : undefined,
    meta:
      [s.grade && `Grade ${s.grade}`, s.school].filter(Boolean).join(" · ") ||
      undefined,
    alreadyIn: memberIds.has(s.id),
    accountStatus: (s.account_status as PickerItem["accountStatus"]) ?? "approved",
  }));

  // Build picker items for teachers
  const assignedTeacherIds = new Set(assignedTeachers.map((t) => t.id));
  const teacherPickerItems: PickerItem[] = allTeachers.map((t) => ({
    id: t.id,
    label: t.display_name ?? t.email,
    sublabel: t.display_name ? t.email : undefined,
    meta: t.can_review_questions ? "Reviewer" : undefined,
    alreadyIn: assignedTeacherIds.has(t.id),
  }));

  async function handleAction(studentId: string, action: "add" | "remove") {
    setLoading(true);
    try {
      await fetch(`/api/admin/class-groups/${classGroup.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId, action }),
      });
      startTransition(() => router.refresh());
    } finally {
      setLoading(false);
    }
  }

  async function handleAddStudents(ids: string[]): Promise<{ ok: boolean; error?: string }> {
    setLoading(true);
    try {
      const results = await Promise.allSettled(
        ids.map((studentId) =>
          fetch(`/api/admin/class-groups/${classGroup.id}/members`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ studentId, action: "add" }),
          }).then(async (res) => {
            if (!res.ok) {
              const j = await res.json().catch(() => ({}));
              throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
            }
            return studentId;
          }),
        ),
      );
      const failed = results
        .map((r, i) => (r.status === "rejected" ? ids[i] : null))
        .filter((id): id is string => id !== null);
      const anySuccess = results.some((r) => r.status === "fulfilled");
      if (anySuccess) startTransition(() => router.refresh());
      if (failed.length > 0) {
        // Find display names for failed ids so the error message is readable.
        const failedLabels = failed.map((id) => {
          const s = allStudents.find((s) => s.id === id);
          return s ? (s.display_name ?? s.email) : id;
        });
        return {
          ok: false,
          error: `Failed to add: ${failedLabels.join(", ")}`,
        };
      }
      return { ok: true };
    } finally {
      setLoading(false);
    }
  }

  async function handleAddTeachers(ids: string[]): Promise<{ ok: boolean; error?: string }> {
    setTeacherLoading(true);
    try {
      const res = await fetch(`/api/admin/class-groups/${classGroup.id}/teachers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teacherIds: ids }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        return { ok: false, error: (j as { error?: string }).error ?? "Failed to add teachers" };
      }
      startTransition(() => router.refresh());
      return { ok: true };
    } catch {
      return { ok: false, error: "Network error" };
    } finally {
      setTeacherLoading(false);
    }
  }

  async function setTeacherSubject(teacherId: string, subject: string | null) {
    setTeacherLoading(true);
    try {
      await fetch(`/api/admin/class-groups/${classGroup.id}/teachers`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teacherId, subject }),
      });
      startTransition(() => router.refresh());
    } finally {
      setTeacherLoading(false);
    }
  }

  async function removeTeacher(teacherId: string) {
    setTeacherLoading(true);
    try {
      await fetch(`/api/admin/class-groups/${classGroup.id}/teachers`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teacherIds: [teacherId] }),
      });
      startTransition(() => router.refresh());
    } finally {
      setTeacherLoading(false);
    }
  }

  // Unassign-test confirm state.
  // `step`: "confirm" = first confirm; "confirm-inprogress" = extra step when students are mid-exam.
  const [unassignTarget, setUnassignTarget] = useState<{
    id: string;
    name: string;
    /** null = unknown (progress couldn't load). */
    submitted: number | null;
    inProgress: number | null;
  } | null>(null);
  const [unassignStep, setUnassignStep] = useState<"confirm" | "confirm-inprogress">("confirm");
  const [unassignBusy, setUnassignBusy] = useState(false);
  const [unassignError, setUnassignError] = useState<string | null>(null);

  async function confirmUnassign() {
    if (!unassignTarget) return;
    // If students are mid-exam, require an extra step before proceeding.
    // Unknown counts take the cautious path too.
    if (unassignStep === "confirm" && (unassignTarget.inProgress ?? 1) > 0) {
      setUnassignStep("confirm-inprogress");
      return;
    }
    setUnassignBusy(true);
    setUnassignError(null);
    try {
      // Atomic remove: server CAS ensures no concurrent assign is overwritten.
      const res = await fetch(`/api/admin/tests/${unassignTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ removeClassGroupIds: [classGroup.id] }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setUnassignError((j as { error?: string }).error ?? "Failed to unassign");
        return;
      }
      setUnassignTarget(null);
      setUnassignStep("confirm");
      startTransition(() => router.refresh());
    } catch {
      setUnassignError("Network error");
    } finally {
      setUnassignBusy(false);
    }
  }

  // Delete-class double-confirm flow: open a modal, require typing the
  // class name, then issue DELETE.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteText, setDeleteText] = useState("");
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteConfirmsMatch = deleteText.trim() === classGroup.name.trim();

  async function confirmDelete() {
    setDeleteError(null);
    setDeleteSubmitting(true);
    try {
      const res = await fetch(`/api/admin/class-groups/${classGroup.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setDeleteError(j.error ?? "Failed to delete");
        return;
      }
      router.push("/admin/classes");
    } catch {
      setDeleteError("Network error");
    } finally {
      setDeleteSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <DetailHeader
        back={{ href: "/admin/classes", label: "Classes" }}
        title={
          renaming ? (
            <span className="block space-y-1">
              <span className="flex items-center gap-2">
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && saveName()}
                  className="flex-1 min-w-0 bg-surface border border-divider rounded-xl px-3 py-1.5 text-lg font-bold text-charcoal focus:outline-none focus:border-warm-coral/50"
                  aria-label="Class name"
                  autoFocus
                />
                <button
                  onClick={saveName}
                  disabled={renameBusy || !newName.trim()}
                  className="px-3 py-1.5 rounded-xl bg-warm-coral text-white text-sm font-semibold disabled:opacity-40"
                >
                  {renameBusy ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={() => { setRenaming(false); setNewName(classGroup.name); setRenameError(null); }}
                  className="px-3 py-1.5 rounded-xl border border-divider text-mid-gray text-sm font-normal"
                >
                  Cancel
                </button>
              </span>
              {renameError && <span className="block text-status-error text-xs font-normal">{renameError}</span>}
            </span>
          ) : (
            classGroup.name
          )
        }
        summary={
          <>
            {classGroup.campus && `${classGroup.campus} · `}
            {classGroup.grade && `Grade ${classGroup.grade} · `}
            {members.length} member{members.length !== 1 ? "s" : ""}
          </>
        }
        actions={
          <>
            <button
              onClick={() => { setNewName(classGroup.name); setRenaming(true); }}
              disabled={renaming}
              className="flex items-center gap-2 px-3 py-2 rounded-xl bg-light-bg hover:bg-divider text-charcoal font-semibold text-sm transition-colors disabled:opacity-50"
              title="Rename class"
            >
              <Pencil size={14} />
              Rename
            </button>
            <RowActionsMenu
              label="More class actions"
              items={[
                {
                  label: "Delete class…",
                  icon: Trash2,
                  tone: "danger",
                  onSelect: () => {
                    setDeleteOpen(true);
                    setDeleteText("");
                    setDeleteError(null);
                  },
                },
              ]}
            />
          </>
        }
      />

      <StatCards
        items={[
          { label: "Students", value: members.length },
          { label: "Teachers", value: assignedTeachers.length },
          { label: "Assigned tests", value: assignedTests.length },
        ]}
      />

      {/* Delete-class double-confirm modal */}
      {deleteOpen && (
        <Portal>
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
          <div className="bg-surface border border-divider rounded-2xl w-full max-w-md shadow-2xl">
            <div className="p-5 border-b border-divider flex items-start gap-3">
              <AlertTriangle size={20} className="text-status-error shrink-0 mt-0.5" />
              <div>
                <h3 className="font-bold text-charcoal text-base">Delete this class?</h3>
                <p className="text-mid-gray text-xs mt-0.5 leading-relaxed">
                  This permanently removes <strong>{classGroup.name}</strong> along with all
                  its student memberships ({members.length}) and teacher assignments
                  ({assignedTeachers.length}). This cannot be undone.
                </p>
                {linkedTests.length > 0 ? (
                  <div className="text-mid-gray text-xs mt-2">
                    It will be removed from {linkedTests.length} test{linkedTests.length === 1 ? "" : "s"}
                    {" "}(the tests themselves are kept; students who only had them through this class
                    lose access):
                    <ul className="list-disc pl-4 mt-1 max-h-28 overflow-y-auto">
                      {linkedTests.map((t) => (
                        <li key={t.id} className="text-charcoal">{t.name}</li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-mid-gray text-xs mt-2">No tests are assigned to this class.</p>
                )}
              </div>
            </div>
            <div className="px-5 py-4 space-y-2">
              <label className="block text-charcoal text-sm font-medium">
                Type the class name to confirm:{" "}
                <span className="font-mono text-warm-coral-text">{classGroup.name}</span>
              </label>
              <input
                value={deleteText}
                onChange={(e) => setDeleteText(e.target.value)}
                className="w-full bg-light-bg border border-divider rounded-xl px-3 py-2 text-sm text-charcoal placeholder:text-soft-mute focus:outline-none focus:border-status-error/50"
                placeholder="Class name"
                autoFocus
              />
              {deleteError && (
                <p className="text-status-error text-sm">{deleteError}</p>
              )}
            </div>
            <div className="p-5 border-t border-divider flex items-center justify-end gap-2">
              <button
                onClick={() => setDeleteOpen(false)}
                className="px-4 py-2 rounded-xl border border-divider text-mid-gray hover:text-charcoal text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={!deleteConfirmsMatch || deleteSubmitting}
                className="px-4 py-2 rounded-xl bg-status-error hover:bg-status-error/90 text-white font-semibold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {deleteSubmitting ? "Deleting…" : "Delete forever"}
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* Teachers */}
      <div className="bg-surface border border-divider rounded-2xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-charcoal font-medium text-sm flex items-center gap-2">
            <GraduationCap size={14} className="text-warm-coral-text" />
            Assigned Teachers
            <span className="text-soft-mute font-normal">
              ({assignedTeachers.length})
            </span>
          </h2>
          {allTeachers.length > assignedTeacherIds.size && (
            <div className="w-full max-w-sm">
              <SearchablePicker
                items={teacherPickerItems}
                noun="teacher"
                onAdd={handleAddTeachers}
                loading={teacherLoading}
              />
            </div>
          )}
        </div>
        {assignedTeachers.length === 0 ? (
          <p className="text-soft-mute text-sm py-2">
            No teachers assigned yet. Add one above so they can see this class&rsquo;s students.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {assignedTeachers.map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-full bg-warm-coral/10 border border-warm-coral/20 text-sm"
              >
                {t.can_review_questions && (
                  <ShieldCheck size={11} className="text-warm-coral-text" />
                )}
                <span className="text-charcoal">{t.display_name ?? t.email}</span>
                <select
                  value={t.subject ?? ""}
                  onChange={(e) => setTeacherSubject(t.id, e.target.value || null)}
                  disabled={teacherLoading}
                  title="Which subject's tests this teacher can see for this class"
                  className="bg-surface border border-divider rounded-full text-xs text-mid-gray px-2 py-0.5 focus:outline-none focus:border-warm-coral/50 disabled:opacity-50"
                >
                  <option value="">Both subjects</option>
                  <option value="Math">Math only</option>
                  <option value="Reading & Writing">English only</option>
                </select>
                <button
                  onClick={() => removeTeacher(t.id)}
                  disabled={teacherLoading}
                  className="text-soft-mute hover:text-status-error transition-colors disabled:opacity-50"
                  title="Remove from this class"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add student */}
      {allStudents.length > 0 && (
        <div className="bg-surface border border-divider rounded-2xl p-5">
          <h2 className="text-charcoal font-medium text-sm mb-3">Add Student</h2>
          <SearchablePicker
            items={studentPickerItems}
            noun="student"
            onAdd={handleAddStudents}
            loading={loading}
          />
        </div>
      )}

      {/* Unassign-test confirm modal */}
      {unassignTarget && (
        <Portal>
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
            <div className="bg-surface border border-divider rounded-2xl w-full max-w-md shadow-2xl">
              <div className="p-5 border-b border-divider flex items-start gap-3">
                <AlertTriangle
                  size={20}
                  className={`shrink-0 mt-0.5 ${unassignStep === "confirm-inprogress" ? "text-status-error" : "text-status-warning"}`}
                />
                <div>
                  {unassignStep === "confirm-inprogress" ? (
                    <>
                      <h3 className="font-bold text-charcoal text-base">Students are mid-exam — are you sure?</h3>
                      <p className="text-status-error text-xs mt-1 font-medium leading-relaxed">
                        {unassignTarget.inProgress === null
                          ? "Progress couldn't load, so some students may be taking this test right now."
                          : `${unassignTarget.inProgress} student${unassignTarget.inProgress !== 1 ? "s are" : " is"} currently taking this test.`} Unassigning now will not interrupt their current session, but they will
                        not be able to start a new attempt afterwards.
                      </p>
                      <p className="text-mid-gray text-xs mt-1">Their submissions are always kept.</p>
                    </>
                  ) : (
                    <>
                      <h3 className="font-bold text-charcoal text-base">Remove test from this class?</h3>
                      <p className="text-mid-gray text-xs mt-0.5 leading-relaxed">
                        Students in <strong>{classGroup.name}</strong> who haven&apos;t started{" "}
                        <strong>{unassignTarget.name}</strong> will lose access. Students mid-exam can still finish
                        their current attempt. (Individual assignments are unaffected.)
                      </p>
                      {(unassignTarget.submitted ?? 0) > 0 && (
                        <p className="text-status-warning text-xs mt-2 font-medium">
                          {unassignTarget.submitted} student{unassignTarget.submitted !== 1 ? "s have" : " has"} already
                          submitted — their results are kept.
                        </p>
                      )}
                      {(unassignTarget.inProgress ?? 0) > 0 && (
                        <p className="text-status-warning text-xs mt-1 font-medium">
                          {unassignTarget.inProgress} student{unassignTarget.inProgress !== 1 ? "s are" : " is"} currently
                          mid-exam and can still finish.
                        </p>
                      )}
                    </>
                  )}
                  {unassignError && <p className="text-status-error text-xs mt-2">{unassignError}</p>}
                </div>
              </div>
              <div className="p-5 border-t border-divider flex items-center justify-end gap-2">
                <button
                  onClick={() => { setUnassignTarget(null); setUnassignStep("confirm"); setUnassignError(null); }}
                  className="px-4 py-2 rounded-xl border border-divider text-mid-gray hover:text-charcoal text-sm transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void confirmUnassign()}
                  disabled={unassignBusy}
                  className="px-4 py-2 rounded-xl bg-status-error hover:bg-status-error/90 text-white font-semibold text-sm transition-colors disabled:opacity-40"
                >
                  {unassignBusy
                    ? "Removing…"
                    : unassignStep === "confirm-inprogress"
                    ? "Yes, remove from class"
                    : "Remove from class"}
                </button>
              </div>
            </div>
          </div>
        </Portal>
      )}

      {/* Assigned Tests */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <ClipboardList size={14} className="text-warm-coral-text" />
            <h2 className="font-semibold text-charcoal">Assigned Tests</h2>
            <span className="text-soft-mute font-normal text-sm">({assignedTests.length})</span>
          </div>
          <AssignTestButton
            classGroupId={classGroup.id}
            availableTests={availableTests}
            memberCount={members.length}
          />
        </div>
        <DataTable>
          <thead>
            <HeadRow>
              <Th kind="main" sticky="left">Test</Th>
              <Th>Status</Th>
              <Th>Subject</Th>
              <Th priority="lg">Dates</Th>
              <Th>Progress</Th>
              <Th kind="actions" sticky="right"><span className="sr-only">Actions</span></Th>
            </HeadRow>
          </thead>
          <tbody>
            {assignedTests.length === 0 && (
              <EmptyRow colSpan={6}>No tests assigned yet. Use the &ldquo;Assign test&rdquo; button above, or assign from a test&rsquo;s page.</EmptyRow>
            )}
            {assignedTests.map((t) => {
              const openStr = t.openDate ? `Opens ${formatShortDate(t.openDate)}` : "Open now";
              const dueStr = t.dueDate ? `Due ${formatShortDate(t.dueDate)}` : null;
              const datesDetail = dueStr ? `${openStr} · ${dueStr}` : openStr;
              return (
                <DataRow
                  key={t.id}
                  href={`/admin/tests/${t.id}`}
                  expandBelow="lg"
                  colSpan={6}
                  details={
                    <DetailItem label="Dates" priority="lg">{datesDetail}</DetailItem>
                  }
                >
                  <Td kind="main" sticky="left">
                    <TwoLineCell main={t.name} wrapMain mainClassName="font-medium text-charcoal" />
                  </Td>
                  <Td>
                    {t.status ? <StatusBadge kind="test" status={t.status as TestStatus} /> : <span className="text-soft-mute">—</span>}
                  </Td>
                  <Td className="text-mid-gray">{t.section ? <SubjectTag section={t.section} /> : "—"}</Td>
                  <Td priority="lg">
                    <TwoLineCell
                      main={openStr}
                      detail={dueStr ?? undefined}
                      mainClassName="text-mid-gray"
                    />
                  </Td>
                  <Td>
                    {t.progress ? (
                      <TwoLineCell
                        main={`${t.progress.submitted}/${t.progress.total} submitted`}
                        detail={
                          t.progress.avgSat !== null ? (
                            <>
                              Avg SAT {t.progress.avgSat}
                              {t.progress.avgScore !== null && <span className="text-soft-mute"> · {t.progress.avgScore.toFixed(1)}% correct</span>}
                            </>
                          ) : undefined
                        }
                        mainClassName="text-charcoal"
                      />
                    ) : (
                      <span className="text-soft-mute text-xs">Couldn&rsquo;t load</span>
                    )}
                  </Td>
                  <Td kind="actions" sticky="right">
                    <RowActions>
                      <ExpandToggle label={`More about ${t.name}`} />
                      <RowButton
                        label="Results"
                        icon={<Eye size={13} />}
                        href={`/admin/tests/${t.id}/submissions?class=${classGroup.id}`}
                      />
                      <RowActionsMenu
                        label={`Actions for ${t.name}`}
                        items={[
                          {
                            label: "Unassign from this class…",
                            icon: UserMinus,
                            tone: "danger",
                            onSelect: () => {
                              setUnassignError(null);
                              setUnassignStep("confirm");
                              setUnassignTarget({ id: t.id, name: t.name, submitted: t.progress?.submitted ?? null, inProgress: t.progress?.inProgress ?? null });
                            },
                          },
                        ]}
                      />
                    </RowActions>
                  </Td>
                </DataRow>
              );
            })}
          </tbody>
        </DataTable>
      </section>

      <ClassGradebook classId={classGroup.id} className={classGroup.name} gradebook={gradebook} />

      {/* Members list */}
      <section>
        <h2 className="font-semibold text-charcoal mb-3">Members</h2>
        <DataTable>
          <thead>
            <HeadRow>
              <Th kind="main" sticky="left">Student</Th>
              <Th>Grade</Th>
              <Th kind="long" priority="md" className="w-[22%]">School</Th>
              <Th kind="actions" sticky="right"><span className="sr-only">Actions</span></Th>
            </HeadRow>
          </thead>
          <tbody>
            {members.length === 0 && (
              <EmptyRow colSpan={4}>No members yet. Add students above.</EmptyRow>
            )}
            {members.map((m) => {
              const u = m.users;
              const profile = u?.student_profiles;
              const name = u?.display_name ?? u?.email ?? "—";
              return (
                <DataRow
                  key={m.id}
                  href={`/admin/students/${m.student_id}`}
                  expandBelow="md"
                  colSpan={4}
                  details={
                    <DetailItem label="School" priority="md">
                      {profile?.school ?? "—"}
                    </DetailItem>
                  }
                >
                  <Td kind="main" sticky="left">
                    <TwoLineCell
                      main={u?.display_name ?? "—"}
                      detail={u?.email}
                      wrapMain
                      mainClassName="font-medium text-charcoal"
                    />
                  </Td>
                  <Td className="text-mid-gray">
                    {profile?.grade ? `Grade ${profile.grade}` : "—"}
                  </Td>
                  <Td kind="long" priority="md" className="text-mid-gray">
                    <TruncatedText>{profile?.school ?? "—"}</TruncatedText>
                  </Td>
                  <Td kind="actions" sticky="right">
                    <RowActions>
                      <ExpandToggle label={`More about ${name}`} />
                      <RowActionsMenu
                        label={`Actions for ${name}`}
                        items={[
                          {
                            label: "Remove from class…",
                            icon: UserMinus,
                            tone: "danger",
                            onSelect: () => {
                              if (confirm(`Remove ${name} from ${classGroup.name}?`)) handleAction(m.student_id, "remove");
                            },
                          },
                        ]}
                      />
                    </RowActions>
                  </Td>
                </DataRow>
              );
            })}
          </tbody>
        </DataTable>
      </section>
    </div>
  );
}
