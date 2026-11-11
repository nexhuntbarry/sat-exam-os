"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Check, X, Save, Printer } from "lucide-react";
import { SubmissionDetailPanel } from "@/components/analytics/SubmissionDetailPanel";
import type { AnswerDetail } from "@/components/analytics/SubmissionDetailPanel";
import { scoreDisplay, type ScoreModule } from "@/lib/score-display";
import { StatusBadge, attemptStatusLabel } from "@/components/ui/StatusBadge";
import { formatDate, formatDateTime } from "@/lib/datetime";
import { TabSwitchCount } from "@/components/analytics/TabSwitchCount";
import { TAB_SWITCH_HELP } from "@/lib/tab-switches";

interface StudentInfo {
  name: string;
  email: string;
  grade: string | null;
  classGroup: string | null;
}

interface SubmissionInfo {
  id: string;
  status: string;
  score: number | null;
  percentage: number | null;
  correctCount: number;
  totalQuestions: number;
  timeSpentSeconds: number | null;
  startedAt: string | null;
  submittedAt: string | null;
  tutorNotes: string;
  attemptNumber: number;
  scaledScore: number | null;
  scaledSection: string | null;
  isMultiModule: boolean;
  /** Times the student left the exam tab (this test / section). */
  tabSwitches: number | null;
}

interface ModuleBreakdown {
  submissionId: string;
  label: string;
  isCurrent: boolean;
  status: string;
  correctCount: number;
  totalQuestions: number;
  percentage: number | null;
  scaledScore: number | null;
  timeSpentSeconds: number;
  answers: AnswerDetail[];
}

interface FullLengthInfo {
  parentId: string;
  parentName: string;
  section: "rw" | "math";
  total: number | null;
  status: string;
  rwSat: number | null;
  mathSat: number | null;
  other: { label: string; href: string | null };
  /** Times the student left the exam tab across both sections. */
  tabSwitches: number | null;
}

interface DetailData {
  /** Set when this submission is a section of a full-length SAT. */
  fullLength?: FullLengthInfo | null;
  student: StudentInfo;
  submission: SubmissionInfo;
  answers: AnswerDetail[];
  modules?: ModuleBreakdown[];
}

function fmtTime(s: number | null) {
  if (!s) return "—";
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export default function SubmissionDetailPage() {
  const params = useParams<{ id: string; submission_id: string }>();
  const testId = params.id;
  const submissionId = params.submission_id;

  const [data, setData] = useState<DetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/teacher/tests/${testId}/results/${submissionId}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.error) setError(json.error);
        else setData(json);
      })
      .catch(() => setError("Failed to load"))
      .finally(() => setLoading(false));
  }, [testId, submissionId]);

  const handleToggleClassReview = useCallback(
    async (questionId: string, current: boolean) => {
      const ok = await fetch(`/api/teacher/tests/${testId}/questions/${questionId}/flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note_type: "class_review", note_body: String(!current) }),
      }).then((r) => r.ok, () => false);
      if (!ok) {
        alert("Couldn't save the class-review mark. Check your connection and try again.");
        return;
      }
      const flip = (a: AnswerDetail) =>
        a.questionId === questionId ? { ...a, classReview: !current } : a;
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          answers: prev.answers.map(flip),
          modules: prev.modules?.map((m) => ({ ...m, answers: m.answers.map(flip) })),
        };
      });
    },
    [testId]
  );

  const handleSaveNote = useCallback(
    async (questionId: string, note: string) => {
      const ok = await fetch(`/api/teacher/tests/${testId}/questions/${questionId}/flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note_type: "private_note", note_body: note, submission_id: submissionId }),
      }).then((r) => r.ok, () => false);
      if (!ok) {
        alert("Couldn't save the private note. Check your connection, then click into the note and away again to retry.");
      }
    },
    [testId, submissionId]
  );

  // Tutor notes — debounced save so the teacher can type freely without
  // a "Save" click. Visible status: "Saving…" / "Saved".
  const [tutorNotes, setTutorNotes] = useState("");
  const [tutorStatus, setTutorStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const tutorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (data?.submission.tutorNotes !== undefined) {
      setTutorNotes(data.submission.tutorNotes);
    }
  }, [data?.submission.tutorNotes]);

  function handleTutorChange(v: string) {
    setTutorNotes(v);
    setTutorStatus("saving");
    if (tutorTimer.current) clearTimeout(tutorTimer.current);
    tutorTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/teacher/tests/${testId}/results/${submissionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tutorNotes: v }),
        });
        setTutorStatus(res.ok ? "saved" : "error");
      } catch {
        setTutorStatus("error");
      }
    }, 700);
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto py-16 text-center text-soft-mute">Loading...</div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-4xl mx-auto py-16 text-center text-status-error">{error ?? "Not found"}</div>
    );
  }

  const { student, submission, answers } = data;
  const correctCount = answers.filter((a) => a.isCorrect).length;
  // Same score display as everywhere else: SAT section score only once
  // every module is in; a Module 1 alone (Module 2 not created yet) is
  // unfinished.
  const scoreModules: ScoreModule[] = (data.modules ?? []).map((m, i) => ({
    number: i + 1,
    graded: m.status === "Submitted" || m.status === "Late",
    correct: m.correctCount,
    total: m.totalQuestions,
  }));
  if (scoreModules.length === 1 && data.modules?.[0].label === "Module 1") {
    scoreModules.push({ number: 2, graded: false, correct: null, total: null });
  }
  const score = scoreDisplay(scoreModules, submission.scaledSection);

  return (
    <div className="max-w-4xl mx-auto space-y-6 print:max-w-none">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-soft-mute text-sm flex-wrap print:hidden">
        <Link href="/teacher/tests" className="hover:text-charcoal transition-colors">Tests</Link>
        <span>/</span>
        <Link href={`/teacher/tests/${data.fullLength?.parentId ?? testId}/results`} className="hover:text-charcoal transition-colors">Results</Link>
        <span>/</span>
        <span className="text-charcoal">{student.name}</span>
        {/* The student's printed result: preview at Letter size, same
            visibility as the student's own result page. Ctrl/Cmd+P on this
            page still prints every question with its figures. */}
        <a
          href={`/print/results/${data.fullLength?.parentId ?? testId}?subs=${submissionId}`}
          target="_blank"
          rel="noopener"
          className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-warm-coral hover:bg-warm-coral-dark text-white text-xs font-semibold transition-colors"
          title="Preview and print this student's result (Save as PDF from there)"
        >
          <Printer size={13} />
          Print
        </a>
      </div>

      {data.fullLength && (
        // Full-length SAT: this page is one section; the total and the
        // other section sit on top.
        <div className="bg-surface border border-divider rounded-2xl p-5 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="text-soft-mute text-xs uppercase tracking-wider">
              Full-length SAT · {data.fullLength.parentName}
            </div>
            <div className="text-charcoal text-sm mt-1">
              Showing {data.fullLength.section === "rw" ? "Reading and Writing" : "Math"}
              {" · "}Total <span className="font-bold">{data.fullLength.total ?? "—"}</span>
              <span className="text-soft-mute">/1600</span>
              {data.fullLength.rwSat != null && <> · R&amp;W {data.fullLength.rwSat}</>}
              {data.fullLength.mathSat != null && <> · Math {data.fullLength.mathSat}</>}
              {data.fullLength.total == null && <span className="text-soft-mute"> ({data.fullLength.status})</span>}
            </div>
          </div>
          {data.fullLength.other.href && (
            <Link
              href={data.fullLength.other.href}
              className="px-3 py-1.5 rounded-lg border border-divider text-sm text-charcoal hover:border-warm-coral/40 transition-colors"
            >
              View {data.fullLength.other.label}
            </Link>
          )}
        </div>
      )}

      {/* Student header */}
      <div className="bg-surface border border-divider rounded-2xl p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-bold text-charcoal">{student.name}</h1>
            <div className="text-soft-mute text-sm mt-0.5">{student.email}</div>
            <div className="flex items-center gap-3 mt-1 text-sm text-soft-mute">
              {student.grade && <span>Grade {student.grade}</span>}
              {student.classGroup && <span>· {student.classGroup}</span>}
            </div>
          </div>
          <StatusBadge kind="attempt" status={attemptStatusLabel(submission.status)} />
        </div>
      </div>

      {/* Score summary */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
        <div
          className="bg-warm-coral/10 border border-warm-coral/20 rounded-xl p-4 col-span-2"
          title={[score?.pct != null ? `${score.pct.toFixed(1)}% correct` : null, ...(score?.notes ?? [])].filter(Boolean).join("\n") || undefined}
        >
          <div className="text-soft-mute text-xs mb-1">
            Est. SAT score
            {submission.scaledSection ? ` · ${submission.scaledSection}` : ""}
          </div>
          {score?.sat != null && (
            <div className="text-3xl font-bold text-warm-coral-text">
              {score.sat}
              <span className="text-sm text-soft-mute font-normal">/800</span>
            </div>
          )}
          <div className={score?.sat != null ? "text-xs text-mid-gray" : "text-xl font-semibold text-charcoal"}>
            {score ? score.modules : "—"}
            {score && score.notes.length > 0 && <span className="text-status-warning"> *</span>}
          </div>
          {score?.pct != null && <div className="text-xs text-soft-mute">{score.pct.toFixed(1)}% correct</div>}
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4">
          <div className="text-soft-mute text-xs mb-1">Correct</div>
          <div className="text-charcoal text-2xl font-bold flex items-center gap-1">
            <Check size={16} className="text-warm-amber" />
            {submission.correctCount}/{submission.totalQuestions}
          </div>
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4">
          <div className="text-soft-mute text-xs mb-1">Incorrect</div>
          <div className="text-charcoal text-2xl font-bold flex items-center gap-1">
            <X size={16} className="text-status-error" />
            {submission.totalQuestions - submission.correctCount}
          </div>
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4">
          <div className="text-soft-mute text-xs mb-1">Time Spent</div>
          <div className="text-charcoal font-semibold">{fmtTime(submission.timeSpentSeconds)}</div>
          {submission.submittedAt && (
            <div className="text-soft-mute text-xs mt-1">
              {formatDateTime(submission.submittedAt)}
            </div>
          )}
          <div className="text-xs mt-1 text-soft-mute" title={TAB_SWITCH_HELP}>
            Left tab: <TabSwitchCount count={submission.tabSwitches} />
            {data.fullLength && data.fullLength.tabSwitches != null && data.fullLength.tabSwitches !== submission.tabSwitches && (
              <> (<TabSwitchCount count={data.fullLength.tabSwitches} /> in the full test)</>
            )}
          </div>
        </div>
      </div>

      {/* Tutor notes — for 1-on-1 follow-up. Not visible to the
          student, and hidden in print so the printout stays condensed
          (teacher just wants questions + correct answers). */}
      <div className="bg-warm-amber/5 border border-warm-amber/20 rounded-2xl p-5 print:hidden">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-charcoal font-semibold flex items-center gap-2">
              Tutor notes
              {submission.attemptNumber > 1 && (
                <span className="text-xs font-normal text-soft-mute">
                  · attempt #{submission.attemptNumber}
                </span>
              )}
            </h2>
            <p className="text-soft-mute text-xs mt-0.5">
              Private to teachers and admins. Use for tutoring follow-ups, what was covered,
              what to revisit next time.
            </p>
          </div>
          <span className="text-xs text-soft-mute flex items-center gap-1">
            {tutorStatus === "saving" && "Saving…"}
            {tutorStatus === "saved" && (
              <>
                <Save size={11} className="text-warm-amber" /> Saved
              </>
            )}
            {tutorStatus === "error" && (
              <span role="alert" className="text-status-error">
                Save failed — keep typing to retry
              </span>
            )}
          </span>
        </div>
        <textarea
          value={tutorNotes}
          onChange={(e) => handleTutorChange(e.target.value)}
          rows={4}
          placeholder="What was covered in this 1-on-1? What does the student still need help with?"
          className="w-full bg-surface border border-divider rounded-xl px-3 py-2 text-sm text-charcoal placeholder:text-soft-mute focus:outline-none focus:border-warm-amber/50 transition-colors"
        />
      </div>

      {/* Per-module breakdown — one card per module with its own
          score pills, then its own per-question review panel below.
          Two-module sessions render Module 1 + Module 2 stacked;
          single-module submissions fall back to a single panel. */}
      {data.modules && data.modules.length > 1 ? (
        <div className="space-y-6">
          {data.modules.map((m) => {
            return (
              <div key={m.submissionId} className="space-y-3">
                <div className="flex items-center justify-between gap-3 bg-surface border border-divider rounded-2xl px-5 py-3">
                  <div>
                    <h2 className="text-charcoal font-semibold text-base">{m.label}</h2>
                    <p className="text-soft-mute text-xs mt-0.5">
                      {m.correctCount}/{m.totalQuestions} correct
                      {m.percentage != null && ` · ${m.percentage.toFixed(1)}%`}
                      {" · "}{fmtTime(m.timeSpentSeconds)}
                    </p>
                  </div>
                  {m.isCurrent && (
                    <span className="text-warm-coral-text text-[11px] font-semibold uppercase tracking-wider">
                      Current
                    </span>
                  )}
                </div>
                <SubmissionDetailPanel
                  answers={m.answers}
                  testId={testId}
                  onToggleClassReview={handleToggleClassReview}
                  onSaveNote={handleSaveNote}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <SubmissionDetailPanel
          answers={answers}
          testId={testId}
          onToggleClassReview={handleToggleClassReview}
          onSaveNote={handleSaveNote}
        />
      )}
    </div>
  );
}
