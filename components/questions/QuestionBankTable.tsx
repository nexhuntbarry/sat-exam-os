"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { clsx } from "clsx";
import { ChevronLeft, ChevronRight, CheckCircle2, XCircle, Eye, Filter, X } from "lucide-react";
import ConfidenceBadge from "./ConfidenceBadge";
import BulkActions from "./BulkActions";
import MathMarkdown from "@/components/MathMarkdown";

// ────────────────────────────────────────────
// Types
// ────────────────────────────────────────────

interface Question {
  id: string;
  module_id: string;
  section: string;
  original_question_number: number | null;
  question_text: string;
  difficulty: string | null;
  domain: string | null;
  skill: string | null;
  question_type: string | null;
  parsing_status: string;
  parsing_notes: string | null;
  official_answer: string | null;
  ai_confidence_score: number | null;
  created_at: string;
  modules: { module_name: string; source_name: string | null } | null;
}

// Condense the (often long, multi-clause) parsing_notes into a short reason a
// reviewer can scan without opening the question. Order matters — the most
// actionable / blocking issue wins.
function issueSummary(
  note: string | null,
  choices?: unknown,
  questionType?: string | null,
  imageUrls?: unknown,
  officialAnswer?: string | null,
): { label: string; tone: "warn" | "info" | "muted"; noKey?: boolean } | null {
  const n = note ?? "";
  const urls = Array.isArray(imageUrls) ? imageUrls.length : 0;
  const ch = Array.isArray(choices) ? choices : [];
  const noKey = !officialAnswer;
  const brokenChoice = ch.some((c) => {
    const t = (typeof c === "string" ? c : (c as { text?: string })?.text) || "";
    return !t.trim() || /partially|no text|placeholder|not visible|garbled|table partially/i.test(t);
  });

  if (questionType === "Multiple Choice" && ch.length > 0 && ch.length < 4) return { label: "Missing answer choices", tone: "warn" };
  if (brokenChoice) return { label: "Broken / unreadable choice", tone: "warn" };
  if (/self-contradictory|not a choice|cos R|mis-parsed|bad question/i.test(n)) return { label: "Question looks mis-parsed", tone: "warn" };
  if (/Needs figure but none|figure but none|cannot auto-solve/i.test(n)) return { label: "Needs a figure — none attached", tone: "warn" };
  if (urls === 0 && /figure|graph|diagram|based on the (graph|table|figure)/i.test(n)) return { label: "Figure missing", tone: "info" };
  // No answer key in the source module → AI had no ground truth. Surface that as
  // the primary reason for the solve-disagreement / verify-fail cases so the
  // reviewer knows to trust their own judgement, not the AI.
  if (/NOT unanimous/i.test(n)) return { label: noKey ? "No answer key — AI solves disagreed" : "Math — AI solves disagreed", tone: noKey ? "warn" : "info", noKey };
  if (/verifier disagreed/i.test(n)) return { label: noKey ? "No answer key — AI can't confirm" : "Math — verify failed", tone: noKey ? "warn" : "info", noKey };
  if (/self-contradict/i.test(n)) return { label: "Answer vs explanation mismatch", tone: "warn" };
  if (/official key=/i.test(n)) return { label: "Answer differs from official key", tone: "warn" };
  const audit = n.match(/Semantic audit:\s*([^;]+)/i);
  if (audit) {
    const t = audit[1].toLowerCase();
    if (/choice/.test(t)) return { label: "Choice looks off", tone: "warn" };
    if (/latex|math|symbol|garbled/.test(t)) return { label: "Math / symbol rendering", tone: "warn" };
    if (/figure|graph/.test(t)) return { label: "Figure missing", tone: "info" };
    if (/explanation|answer/.test(t)) return { label: "Answer / explanation issue", tone: "warn" };
    return { label: audit[1].trim().slice(0, 48), tone: "info" };
  }
  if (/truncat|cut off|mid-sentence|empty|blank/i.test(n)) return { label: "Text truncated / empty", tone: "warn" };
  if (/answer changed|Tier1/i.test(n)) return { label: "Answer changed — verify", tone: "info" };
  if (/Low AI confidence/i.test(n)) return { label: "Low AI confidence", tone: "muted" };
  if (/Pending AI answer/i.test(n)) return { label: "Awaiting AI answer", tone: "muted" };
  return null;
}

const issueToneStyles: Record<string, string> = {
  warn: "bg-status-warning/12 text-status-warning",
  info: "bg-status-info/12 text-status-info",
  muted: "bg-light-bg text-soft-mute",
};

interface ApiResponse {
  data: Question[];
  total: number;
  page: number;
  pages: number;
  limit: number;
}

// ────────────────────────────────────────────
// Status pill colors
// ────────────────────────────────────────────

const statusStyles: Record<string, string> = {
  Draft: "bg-light-bg text-mid-gray",
  Approved: "bg-warm-amber/15 text-warm-amber",
  "Needs Review": "bg-status-warning/15 text-status-warning",
  Rejected: "bg-status-error/15 text-status-error",
};

const SAT_DOMAINS = [
  "Information and Ideas",
  "Craft and Structure",
  "Expression of Ideas",
  "Standard English Conventions",
  "Algebra",
  "Advanced Math",
  "Problem Solving and Data Analysis",
  "Geometry and Trigonometry",
];

// ────────────────────────────────────────────
// Filter panel
// ────────────────────────────────────────────

interface Filters {
  keyword: string;
  section: string;
  status: string;
  domain: string;
  skill: string;
  difficulty: string;
  moduleId: string;
  questionType: string;
  hasImage: boolean | null;
  hasTable: boolean | null;
  hasFormula: boolean | null;
}

const DEFAULT_FILTERS: Filters = {
  keyword: "",
  section: "",
  status: "",
  domain: "",
  skill: "",
  difficulty: "",
  moduleId: "",
  questionType: "",
  hasImage: null,
  hasTable: null,
  hasFormula: null,
};

function buildQueryString(filters: Filters, page: number): string {
  const params = new URLSearchParams();
  if (filters.keyword) params.set("keyword", filters.keyword);
  if (filters.section) params.set("section", filters.section);
  if (filters.status) params.set("status", filters.status);
  if (filters.domain) params.set("domain", filters.domain);
  if (filters.skill) params.set("skill", filters.skill);
  if (filters.difficulty) params.set("difficulty", filters.difficulty);
  if (filters.moduleId) params.set("moduleId", filters.moduleId);
  if (filters.questionType) params.set("questionType", filters.questionType);
  if (filters.hasImage !== null) params.set("hasImage", String(filters.hasImage));
  if (filters.hasTable !== null) params.set("hasTable", String(filters.hasTable));
  if (filters.hasFormula !== null) params.set("hasFormula", String(filters.hasFormula));
  params.set("page", String(page));
  return params.toString();
}

// ────────────────────────────────────────────
// Main component
// ────────────────────────────────────────────

interface QuestionBankTableProps {
  initialModuleId?: string;
}

export default function QuestionBankTable({ initialModuleId }: QuestionBankTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Question detail lives at /admin/questions/[id] for admins and at
  // /reviewer/questions/[id] for reviewer-teachers. Detect from the
  // current path so links resolve to the matching layout.
  const detailBase = pathname.startsWith("/reviewer") ? "/reviewer/questions" : "/admin/questions";

  const [filters, setFilters] = useState<Filters>({
    ...DEFAULT_FILTERS,
    moduleId: initialModuleId ?? searchParams.get("moduleId") ?? "",
    status: searchParams.get("status") ?? "",
  });
  const [page, setPage] = useState(1);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [result, setResult] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const keywordRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchQuestions = useCallback(
    async (f: Filters, p: number) => {
      setLoading(true);
      try {
        const qs = buildQueryString(f, p);
        const res = await fetch(`/api/admin/questions?${qs}`);
        if (res.ok) {
          const json: ApiResponse = await res.json();
          setResult(json);
        }
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    fetchQuestions(filters, page);
    // Update URL params for shareability
    const qs = buildQueryString(filters, page);
    router.replace(`${pathname}?${qs}`, { scroll: false });
  }, [filters, page, fetchQuestions, router, pathname]);

  function handleKeywordChange(v: string) {
    if (keywordRef.current) clearTimeout(keywordRef.current);
    keywordRef.current = setTimeout(() => {
      setFilters((f) => ({ ...f, keyword: v }));
      setPage(1);
    }, 350);
  }

  function handleFilterChange(key: keyof Filters, value: string | boolean | null) {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (!result) return;
    const allIds = result.data.map((q) => q.id);
    if (selectedIds.size === allIds.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allIds));
    }
  }

  async function handleStatusChange(id: string, action: "approve" | "reject") {
    await fetch(`/api/admin/questions/${id}/${action}`, { method: "POST" });
    fetchQuestions(filters, page);
  }

  const questions = result?.data ?? [];
  const total = result?.total ?? 0;
  const pages = result?.pages ?? 1;

  return (
    <div className="flex gap-6 min-h-0">
      {/* Filter panel */}
      <aside
        className={clsx(
          "shrink-0 w-56 space-y-4 transition-all",
          filtersOpen ? "block" : "hidden lg:block"
        )}
      >
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-soft-mute uppercase tracking-widest">Filters</p>
          <button
            onClick={() => {
              setFilters(DEFAULT_FILTERS);
              setPage(1);
            }}
            className="text-xs text-soft-mute hover:text-charcoal transition-colors"
          >
            Reset
          </button>
        </div>

        {/* Keyword */}
        <div>
          <label className="block text-xs text-soft-mute mb-1">Keyword</label>
          <input
            type="text"
            placeholder="Search questions..."
            defaultValue={filters.keyword}
            onChange={(e) => handleKeywordChange(e.target.value)}
            className="w-full bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal placeholder:text-soft-mute focus:outline-none focus:border-warm-coral/50"
          />
        </div>

        {/* Section */}
        <div>
          <label className="block text-xs text-soft-mute mb-1">Section</label>
          <select
            value={filters.section}
            onChange={(e) => handleFilterChange("section", e.target.value)}
            className="w-full bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50"
          >
            <option value="">All</option>
            <option value="Math">Math</option>
            <option value="Reading & Writing">Reading &amp; Writing</option>
          </select>
        </div>

        {/* Status */}
        <div>
          <label className="block text-xs text-soft-mute mb-1">Status</label>
          <select
            value={filters.status}
            onChange={(e) => handleFilterChange("status", e.target.value)}
            className="w-full bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50"
          >
            <option value="">All</option>
            <option value="Draft">Draft</option>
            <option value="Approved">Approved</option>
            <option value="Needs Review">Needs Review</option>
            <option value="Rejected">Rejected</option>
          </select>
        </div>

        {/* Domain */}
        <div>
          <label className="block text-xs text-soft-mute mb-1">Domain</label>
          <select
            value={filters.domain}
            onChange={(e) => handleFilterChange("domain", e.target.value)}
            className="w-full bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50"
          >
            <option value="">All</option>
            {SAT_DOMAINS.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>

        {/* Skill */}
        <div>
          <label className="block text-xs text-soft-mute mb-1">Skill</label>
          <input
            type="text"
            placeholder="Filter by skill..."
            value={filters.skill}
            onChange={(e) => handleFilterChange("skill", e.target.value)}
            className="w-full bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal placeholder:text-soft-mute focus:outline-none focus:border-warm-coral/50"
          />
        </div>

        {/* Difficulty */}
        <div>
          <label className="block text-xs text-soft-mute mb-1">Difficulty</label>
          <select
            value={filters.difficulty}
            onChange={(e) => handleFilterChange("difficulty", e.target.value)}
            className="w-full bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50"
          >
            <option value="">All</option>
            <option value="Easy">Easy</option>
            <option value="Medium">Medium</option>
            <option value="Hard">Hard</option>
          </select>
        </div>

        {/* Question Type */}
        <div>
          <label className="block text-xs text-soft-mute mb-1">Type</label>
          <select
            value={filters.questionType}
            onChange={(e) => handleFilterChange("questionType", e.target.value)}
            className="w-full bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50"
          >
            <option value="">All</option>
            <option value="Multiple Choice">MC</option>
            <option value="Student Produced Response">SPR</option>
          </select>
        </div>

        {/* Boolean toggles */}
        <div className="space-y-2">
          {(
            [
              { key: "hasImage", label: "Has image" },
              { key: "hasTable", label: "Has table" },
              { key: "hasFormula", label: "Has formula" },
            ] as const
          ).map(({ key, label }) => (
            <label key={key} className="flex items-center gap-2 cursor-pointer text-xs text-mid-gray">
              <input
                type="checkbox"
                checked={filters[key] === true}
                onChange={(e) =>
                  handleFilterChange(key, e.target.checked ? true : null)
                }
                className="accent-warm-coral"
              />
              {label}
            </label>
          ))}
        </div>
      </aside>

      {/* Table */}
      <div className="flex-1 min-w-0 space-y-3">
        {/* Toolbar */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setFiltersOpen((o) => !o)}
            className="lg:hidden flex items-center gap-2 px-3 py-1.5 rounded-lg bg-light-bg text-mid-gray text-sm"
          >
            <Filter size={14} />
            Filters
          </button>
          <span className="text-sm text-soft-mute ml-auto">
            {loading ? "Loading..." : `${total} questions`}
          </span>
          <BulkActions
            selectedIds={Array.from(selectedIds)}
            onComplete={() => {
              setSelectedIds(new Set());
              fetchQuestions(filters, page);
            }}
          />
        </div>

        <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
          {questions.length === 0 && !loading ? (
            <div className="py-16 text-center">
              <p className="text-soft-mute text-sm">No questions found.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-divider text-soft-mute">
                    <th className="px-4 py-3 w-8">
                      <input
                        type="checkbox"
                        checked={selectedIds.size === questions.length && questions.length > 0}
                        onChange={toggleAll}
                        className="accent-warm-coral"
                      />
                    </th>
                    <th className="text-left px-4 py-3 font-medium">Q#</th>
                    <th className="text-left px-4 py-3 font-medium">Module</th>
                    <th className="text-left px-4 py-3 font-medium max-w-xs">Text</th>
                    <th className="text-left px-4 py-3 font-medium">Difficulty</th>
                    <th className="text-left px-4 py-3 font-medium">Domain</th>
                    <th className="text-left px-4 py-3 font-medium">Status</th>
                    <th className="text-left px-4 py-3 font-medium">Why</th>
                    <th className="text-left px-4 py-3 font-medium">Conf.</th>
                    <th className="text-left px-4 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {questions.map((q) => (
                    <tr
                      key={q.id}
                      className={clsx(
                        "border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors",
                        selectedIds.has(q.id) && "bg-warm-coral/5"
                      )}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(q.id)}
                          onChange={() => toggleSelected(q.id)}
                          className="accent-warm-coral"
                        />
                      </td>
                      <td className="px-4 py-3 text-soft-mute text-xs">
                        {q.original_question_number ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-mid-gray text-xs max-w-[120px] truncate">
                        {q.modules?.module_name ?? "—"}
                      </td>
                      <td className="px-4 py-3 max-w-xs">
                        <Link
                          href={`${detailBase}/${q.id}`}
                          className="block text-charcoal hover:text-warm-coral transition-colors text-sm"
                        >
                          <MathMarkdown className="prose prose-sm max-w-none [&_p]:my-0 [&_p]:line-clamp-2">
                            {q.question_text.length > 200
                              ? q.question_text.slice(0, 200) + "…"
                              : q.question_text}
                          </MathMarkdown>
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-mid-gray text-xs">{q.difficulty ?? "—"}</td>
                      <td className="px-4 py-3 text-mid-gray text-xs max-w-[140px] truncate" title={q.domain ?? ""}>
                        {q.domain ?? "—"}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={clsx(
                            "px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap",
                            statusStyles[q.parsing_status] ?? "bg-light-bg text-soft-mute"
                          )}
                        >
                          {q.parsing_status}
                        </span>
                      </td>
                      <td className="px-4 py-3 max-w-[220px]">
                        {(() => {
                          const issue = issueSummary(q.parsing_notes, undefined, q.question_type, undefined, q.official_answer);
                          const showNoKey =
                            q.parsing_status === "Needs Review" && !q.official_answer && !issue?.noKey;
                          if (!issue && !showNoKey) return <span className="text-soft-mute text-xs">—</span>;
                          return (
                            <div className="flex flex-wrap items-center gap-1">
                              {issue && (
                                <span
                                  title={q.parsing_notes ?? ""}
                                  className={clsx(
                                    "inline-block px-2 py-0.5 rounded-md text-xs font-medium leading-snug",
                                    issueToneStyles[issue.tone]
                                  )}
                                >
                                  {issue.label}
                                </span>
                              )}
                              {showNoKey && (
                                <span
                                  title="The source module has no answer key — the AI answer is unverified."
                                  className="inline-block px-1.5 py-0.5 rounded-md text-[11px] font-medium bg-light-bg text-soft-mute whitespace-nowrap"
                                >
                                  no answer key
                                </span>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-3">
                        <ConfidenceBadge score={q.ai_confidence_score} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <Link
                            href={`${detailBase}/${q.id}`}
                            className="p-1 rounded hover:bg-surface text-soft-mute hover:text-charcoal transition-colors"
                            title="View / Edit"
                          >
                            <Eye size={14} />
                          </Link>
                          {q.parsing_status !== "Approved" && (
                            <button
                              onClick={() => handleStatusChange(q.id, "approve")}
                              className="p-1 rounded hover:bg-warm-amber/15 text-soft-mute hover:text-warm-amber transition-colors"
                              title="Approve"
                            >
                              <CheckCircle2 size={14} />
                            </button>
                          )}
                          {q.parsing_status !== "Rejected" && (
                            <button
                              onClick={() => handleStatusChange(q.id, "reject")}
                              className="p-1 rounded hover:bg-status-error/15 text-soft-mute hover:text-status-error transition-colors"
                              title="Reject"
                            >
                              <XCircle size={14} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Pagination */}
        {pages > 1 && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-soft-mute">
              Page {page} of {pages}
            </span>
            <div className="flex gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="p-1.5 rounded-lg bg-light-bg hover:bg-light-bg disabled:opacity-30 transition-colors"
              >
                <ChevronLeft size={15} />
              </button>
              <button
                disabled={page >= pages}
                onClick={() => setPage((p) => p + 1)}
                className="p-1.5 rounded-lg bg-light-bg hover:bg-light-bg disabled:opacity-30 transition-colors"
              >
                <ChevronRight size={15} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
