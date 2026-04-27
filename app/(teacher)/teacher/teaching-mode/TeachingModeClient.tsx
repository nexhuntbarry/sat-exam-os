"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import {
  BarChart2,
  ChevronRight,
  Loader2,
  Sparkles,
  Target,
  X,
} from "lucide-react";
import MathMarkdown from "@/components/MathMarkdown";

interface TestSummary {
  id: string;
  test_name: string;
  status: string;
}

interface HardestQuestion {
  questionId: string;
  questionNumber: number | null;
  questionText: string;
  domain: string | null;
  skill: string | null;
  difficulty: string | null;
  totalAnswered: number;
  wrongCount: number;
  errorRate: number;
}

interface TestReviewResponse {
  tests: TestSummary[];
  selectedTest: TestSummary | null;
  hardestQuestions: HardestQuestion[];
  totalSubmissions: number;
}

interface SkillStat {
  skill: string;
  domain: string | null;
  total: number;
  wrong: number;
  errorRate: number;
}

interface SkillStatsResponse {
  domains: string[];
  skills: SkillStat[];
}

interface CandidateQuestion {
  questionId: string;
  questionNumber: number | null;
  questionText: string;
  domain: string | null;
  skill: string | null;
  difficulty: string | null;
  hasImage: boolean | null;
  classTotal: number;
  classWrong: number;
  classErrorRate: number | null;
}

interface Cohort {
  id: string;
  name: string;
  campus: string | null;
  grade: string | null;
}

const previewText = (text: string) =>
  text.replace(/\s+/g, " ").trim().slice(0, 140);

const errorBadge = (rate: number) =>
  clsx(
    "px-2 py-0.5 rounded-full text-xs font-semibold",
    rate >= 60
      ? "bg-status-error/15 text-status-error"
      : rate >= 35
      ? "bg-warm-amber/15 text-warm-amber"
      : "bg-status-success/15 text-status-success"
  );

const selectCls =
  "bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50";

export default function TeachingModeClient() {
  // Test Review state
  const [reviewLoading, setReviewLoading] = useState(true);
  const [review, setReview] = useState<TestReviewResponse | null>(null);
  const [reviewTestId, setReviewTestId] = useState<string>("");

  // Skill Drill state
  const [skillLoading, setSkillLoading] = useState(true);
  const [skillData, setSkillData] = useState<SkillStatsResponse | null>(null);
  const [activeDomain, setActiveDomain] = useState<string>("");

  // Modal state
  const [modalSkill, setModalSkill] = useState<string | null>(null);

  // Initial test review
  useEffect(() => {
    setReviewLoading(true);
    const url = reviewTestId
      ? `/api/teacher/teaching-mode/test-review?testId=${reviewTestId}`
      : "/api/teacher/teaching-mode/test-review";
    fetch(url)
      .then((r) => r.json())
      .then((d: TestReviewResponse) => {
        setReview(d);
        if (!reviewTestId && d.selectedTest) {
          setReviewTestId(d.selectedTest.id);
        }
      })
      .catch(console.error)
      .finally(() => setReviewLoading(false));
  }, [reviewTestId]);

  // Initial skill stats (no domain → fetches list of available domains)
  useEffect(() => {
    setSkillLoading(true);
    const url = activeDomain
      ? `/api/teacher/teaching-mode/skill-stats?domain=${encodeURIComponent(activeDomain)}`
      : "/api/teacher/teaching-mode/skill-stats";
    fetch(url)
      .then((r) => r.json())
      .then((d: SkillStatsResponse) => {
        setSkillData(d);
        if (!activeDomain && d.domains.length > 0) {
          setActiveDomain(d.domains[0]);
        }
      })
      .catch(console.error)
      .finally(() => setSkillLoading(false));
  }, [activeDomain]);

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <TestReviewCard
          loading={reviewLoading}
          review={review}
          selectedTestId={reviewTestId}
          onSelectTest={setReviewTestId}
        />
        <SkillDrillCard
          loading={skillLoading}
          data={skillData}
          activeDomain={activeDomain}
          onSelectDomain={setActiveDomain}
          onBuildPracticeSet={(skill) => setModalSkill(skill)}
        />
      </div>

      {modalSkill && (
        <PracticeSetModal
          skill={modalSkill}
          onClose={() => setModalSkill(null)}
        />
      )}
    </>
  );
}

// --- Test Review --------------------------------------------------------

function TestReviewCard({
  loading,
  review,
  selectedTestId,
  onSelectTest,
}: {
  loading: boolean;
  review: TestReviewResponse | null;
  selectedTestId: string;
  onSelectTest: (id: string) => void;
}) {
  return (
    <section className="bg-surface border border-divider rounded-2xl overflow-hidden flex flex-col">
      <header className="px-5 py-4 border-b border-divider flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <BarChart2 size={18} className="text-warm-coral" />
          <h2 className="text-charcoal font-semibold">Test Review</h2>
        </div>
        {review && review.tests.length > 0 && (
          <select
            value={selectedTestId}
            onChange={(e) => onSelectTest(e.target.value)}
            className={selectCls}
          >
            {review.tests.map((t) => (
              <option key={t.id} value={t.id}>
                {t.test_name}
              </option>
            ))}
          </select>
        )}
      </header>

      {loading ? (
        <div className="flex-1 py-12 text-center text-soft-mute text-sm">
          <Loader2 size={20} className="inline animate-spin mr-2" />
          Loading test review...
        </div>
      ) : !review || review.tests.length === 0 ? (
        <EmptyState
          title="No tests yet"
          body="Ask an admin to assign you to a test, then come back here for the post-mortem."
          ctaHref="/teacher/tests"
          ctaLabel="Open Tests"
        />
      ) : review.totalSubmissions === 0 ? (
        <EmptyState
          title="No submissions yet"
          body={`"${review.selectedTest?.test_name}" has no completed submissions yet. Pick a different test or wait for students to finish.`}
          ctaHref={`/teacher/tests/${review.selectedTest?.id}/results`}
          ctaLabel="View test"
        />
      ) : (
        <>
          <div className="px-5 py-3 border-b border-divider text-soft-mute text-xs">
            <span className="text-charcoal font-medium">
              {review.totalSubmissions}
            </span>{" "}
            submissions • Top 5 hardest questions by error rate
          </div>
          <div className="divide-y divide-white/5 flex-1">
            {review.hardestQuestions.map((q) => (
              <div
                key={q.questionId}
                className="px-5 py-3 flex items-start gap-3 hover:bg-warm-coral/5 transition-colors"
              >
                <div className="w-8 text-soft-mute text-sm font-mono pt-0.5">
                  {q.questionNumber != null ? `Q${q.questionNumber}` : "—"}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-charcoal line-clamp-2">
                    <MathMarkdown>{previewText(q.questionText)}</MathMarkdown>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-soft-mute flex-wrap">
                    {q.skill && (
                      <span className="text-warm-amber-dark">{q.skill}</span>
                    )}
                    {q.difficulty && <span>• {q.difficulty}</span>}
                    <span>• {q.wrongCount}/{q.totalAnswered} wrong</span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                  <span className={errorBadge(q.errorRate)}>
                    {q.errorRate.toFixed(0)}%
                  </span>
                  {review.selectedTest && (
                    <Link
                      href={`/teacher/tests/${review.selectedTest.id}/analytics/${q.questionId}`}
                      className="text-warm-coral text-xs hover:underline flex items-center gap-0.5"
                    >
                      Detail <ChevronRight size={12} />
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
          {review.selectedTest && (
            <footer className="px-5 py-3 border-t border-divider text-right">
              <Link
                href={`/teacher/tests/${review.selectedTest.id}/analytics`}
                className="text-warm-coral text-sm font-medium hover:underline inline-flex items-center gap-1"
              >
                Open full analytics <ChevronRight size={14} />
              </Link>
            </footer>
          )}
        </>
      )}
    </section>
  );
}

// --- Skill Drill --------------------------------------------------------

function SkillDrillCard({
  loading,
  data,
  activeDomain,
  onSelectDomain,
  onBuildPracticeSet,
}: {
  loading: boolean;
  data: SkillStatsResponse | null;
  activeDomain: string;
  onSelectDomain: (d: string) => void;
  onBuildPracticeSet: (skill: string) => void;
}) {
  const domains = data?.domains ?? [];

  return (
    <section className="bg-surface border border-divider rounded-2xl overflow-hidden flex flex-col">
      <header className="px-5 py-4 border-b border-divider flex items-center gap-2">
        <Target size={18} className="text-warm-coral" />
        <h2 className="text-charcoal font-semibold">Skill Drill</h2>
      </header>

      {domains.length > 0 && (
        <div className="px-5 py-3 border-b border-divider flex flex-wrap gap-2">
          {domains.map((d) => (
            <button
              key={d}
              onClick={() => onSelectDomain(d)}
              className={clsx(
                "px-3 py-1 rounded-full text-xs font-medium transition-colors border",
                d === activeDomain
                  ? "bg-warm-coral text-white border-warm-coral"
                  : "bg-light-bg text-mid-gray border-divider hover:border-warm-coral/40"
              )}
            >
              {d}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="flex-1 py-12 text-center text-soft-mute text-sm">
          <Loader2 size={20} className="inline animate-spin mr-2" />
          Computing skill error rates...
        </div>
      ) : !data || domains.length === 0 ? (
        <EmptyState
          title="No data yet"
          body="Students need to take at least one test before skill drill stats are available."
          ctaHref="/teacher/tests"
          ctaLabel="Open Tests"
        />
      ) : data.skills.length === 0 ? (
        <EmptyState
          title="No data for this domain"
          body={`No answer records found for "${activeDomain}" yet. Try a different domain.`}
        />
      ) : (
        <div className="divide-y divide-white/5 flex-1">
          {data.skills.map((s) => (
            <div
              key={s.skill}
              className="px-5 py-3 flex items-center gap-3 hover:bg-warm-coral/5 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm text-charcoal font-medium truncate">
                  {s.skill}
                </div>
                <div className="text-xs text-soft-mute">
                  {s.wrong}/{s.total} wrong
                </div>
              </div>
              <span className={errorBadge(s.errorRate)}>
                {s.errorRate.toFixed(0)}%
              </span>
              <button
                onClick={() => onBuildPracticeSet(s.skill)}
                className="px-3 py-1.5 bg-warm-coral text-white rounded-lg text-xs font-medium hover:bg-warm-coral/90 transition-colors flex items-center gap-1 flex-shrink-0"
              >
                <Sparkles size={12} />
                Practice set
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// --- Empty state --------------------------------------------------------

function EmptyState({
  title,
  body,
  ctaHref,
  ctaLabel,
}: {
  title: string;
  body: string;
  ctaHref?: string;
  ctaLabel?: string;
}) {
  return (
    <div className="flex-1 py-12 px-6 text-center">
      <p className="text-charcoal font-medium text-sm">{title}</p>
      <p className="text-soft-mute text-xs mt-1.5 max-w-sm mx-auto">{body}</p>
      {ctaHref && ctaLabel && (
        <Link
          href={ctaHref}
          className="inline-block mt-4 px-3 py-1.5 bg-warm-coral text-white rounded-lg text-xs font-medium hover:bg-warm-coral/90 transition-colors"
        >
          {ctaLabel}
        </Link>
      )}
    </div>
  );
}

// --- Modal --------------------------------------------------------------

function PracticeSetModal({
  skill,
  onClose,
}: {
  skill: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [questions, setQuestions] = useState<CandidateQuestion[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [cohortId, setCohortId] = useState<string>("");
  const [name, setName] = useState(`${skill} – Practice ${todayStamp()}`);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(
        `/api/teacher/teaching-mode/skill-questions?skill=${encodeURIComponent(skill)}&limit=10`
      ).then((r) => r.json()),
      fetch("/api/teacher/teaching-mode/cohorts").then((r) => r.json()),
    ])
      .then(([qres, cres]) => {
        const qs: CandidateQuestion[] = qres.questions ?? [];
        setQuestions(qs);
        // Pre-select the top 5 hardest by class error rate
        setSelectedIds(new Set(qs.slice(0, 5).map((q) => q.questionId)));
        setCohorts(cres.cohorts ?? []);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [skill]);

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectedCount = selectedIds.size;

  const submit = useCallback(async () => {
    setError(null);
    if (!name.trim()) {
      setError("Name the practice set first.");
      return;
    }
    if (selectedCount === 0) {
      setError("Pick at least one question.");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/teacher/teaching-mode/quick-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          questionIds: Array.from(selectedIds),
          cohortId: cohortId || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Failed to create practice test");
        setCreating(false);
        return;
      }
      router.push(`/teacher/tests/${json.data.id}/results`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setCreating(false);
    }
  }, [name, selectedCount, selectedIds, cohortId, router]);

  return (
    <div
      className="fixed inset-0 bg-charcoal/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-cream border border-divider rounded-2xl w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-divider flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-charcoal font-semibold truncate">
              Build practice set: <span className="text-warm-coral">{skill}</span>
            </h3>
            <p className="text-soft-mute text-xs mt-0.5">
              Top {questions.length} candidates ranked by class error rate, then difficulty.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-lg text-mid-gray hover:bg-light-bg"
          >
            <X size={16} />
          </button>
        </header>

        <div className="px-5 py-3 border-b border-divider flex flex-wrap items-center gap-3">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="flex-1 min-w-[220px] bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50"
            placeholder="Practice set name"
          />
          <select
            value={cohortId}
            onChange={(e) => setCohortId(e.target.value)}
            className={selectCls}
          >
            <option value="">No cohort (assign later)</option>
            {cohorts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.grade ? ` · ${c.grade}` : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-white/5">
          {loading ? (
            <div className="py-12 text-center text-soft-mute text-sm">
              <Loader2 size={20} className="inline animate-spin mr-2" />
              Loading questions...
            </div>
          ) : questions.length === 0 ? (
            <div className="py-12 text-center text-soft-mute text-sm">
              No approved questions found for this skill.
            </div>
          ) : (
            questions.map((q) => {
              const checked = selectedIds.has(q.questionId);
              return (
                <label
                  key={q.questionId}
                  className={clsx(
                    "flex items-start gap-3 px-5 py-3 cursor-pointer transition-colors",
                    checked ? "bg-warm-coral/5" : "hover:bg-light-bg"
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(q.questionId)}
                    className="mt-1 accent-warm-coral"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-charcoal line-clamp-2">
                      <MathMarkdown>{previewText(q.questionText)}</MathMarkdown>
                    </div>
                    <div className="text-xs text-soft-mute mt-1 flex items-center gap-2 flex-wrap">
                      {q.questionNumber != null && <span>Q{q.questionNumber}</span>}
                      {q.difficulty && <span>• {q.difficulty}</span>}
                      {q.classErrorRate != null ? (
                        <span>
                          • Class:{" "}
                          <span className={errorBadge(q.classErrorRate)}>
                            {q.classErrorRate.toFixed(0)}%
                          </span>
                        </span>
                      ) : (
                        <span>• No class history</span>
                      )}
                    </div>
                  </div>
                </label>
              );
            })
          )}
        </div>

        <footer className="px-5 py-3 border-t border-divider flex items-center justify-between gap-3">
          <div className="text-soft-mute text-xs">
            {selectedCount} selected
            {error && (
              <span className="text-status-error ml-3 font-medium">{error}</span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-mid-gray hover:text-charcoal"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={creating || selectedCount === 0}
              className="px-4 py-1.5 bg-warm-coral text-white rounded-lg text-sm font-medium hover:bg-warm-coral/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {creating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              Create practice test
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function todayStamp() {
  const d = new Date();
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
