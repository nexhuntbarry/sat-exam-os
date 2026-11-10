"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { CheckCircle2, XCircle, AlertCircle, Save, KeyRound, Sparkles, Bug, ChevronLeft, ChevronRight, ArrowRightCircle, Crop, Trash2, Eye, BookOpen, FileCheck, FileSearch } from "lucide-react";
import PDFViewer from "./PDFViewer";
import EditableMath from "./EditableMath";
import ReextractPanel, { type ReextractPatch, type ReextractProposal } from "./ReextractPanel";
import ImageCropDialog from "./ImageCropDialog";
import ConfidenceBadge from "./ConfidenceBadge";
import SupportComposer from "@/components/support/SupportComposer";
import MathMarkdown from "@/components/MathMarkdown";
import { formatDateTime } from "@/lib/datetime";
import QuestionRenderer from "@/components/tests/QuestionRenderer";
import ReviewQuestionCard from "@/components/tests/ReviewQuestionCard";
import { friendlyParsingNote } from "@/lib/friendly-parsing-notes";
import { hasMarkdownTable } from "@/lib/markdown-table";
import { SPR_FORM_HELP, SPR_TYPE, MC_TYPE, gradedAsCorrect, keyTypeProblem, answersAgreeForQuestion } from "@/lib/answer-key";
import { keySource, type ModuleKeyFacts } from "@/lib/key-source";


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

interface Choice {
  label: "A" | "B" | "C" | "D";
  text: string;
  /** Graph / figure choice — the cropped image is the choice itself. */
  image_url?: string | null;
}

interface Question {
  id: string;
  module_id: string;
  section: string;
  original_question_number: number | null;
  question_text: string;
  choices: Choice[];
  correct_answer: string | null;
  explanation: string | null;
  difficulty: "Easy" | "Medium" | "Hard" | null;
  domain: string | null;
  skill: string | null;
  concept: string | null;
  question_type: "Multiple Choice" | "Student Produced Response" | null;
  has_image: boolean;
  has_table: boolean;
  has_formula: boolean;
  page_number: number | null;
  parsing_status: string;
  parsing_notes: string | null;
  ai_confidence_score: number | null;
  reviewed_at: string | null;
  image_urls: string[] | null;
  image_alts: string[] | null;
  official_answer: string | null;
  mismatch_with_official: boolean;
  modules: {
    module_name: string;
    source_name: string | null;
    pdf_url: string;
    section: string;
    difficulty: string | null;
    module_number: number | null;
  } | null;
}

interface ReviewNav {
  /** Next still-pending question in this module (Draft / Needs Review). */
  nextId: string | null;
  /** Previous still-pending question in this module. */
  prevId: string | null;
  /** How many questions in this module still need review. */
  pendingCount: number;
  moduleId: string;
  /** Set when nextId is in another module (this module has none left after this one). */
  nextModuleName?: string | null;
}

interface QuestionReviewPanelProps {
  question: Question;
  /** When present, enables in-module "Approve & Next" review stepping. */
  nav?: ReviewNav;
  /** The module's extracted-key facts (lib/key-source), for the key's source label. */
  moduleKeyFacts?: ModuleKeyFacts | null;
}

const statusStyles: Record<string, string> = {
  Draft: "bg-light-bg text-mid-gray",
  Approved: "bg-warm-amber/15 text-warm-amber",
  "Needs Review": "bg-status-warning/15 text-status-warning",
  Rejected: "bg-status-error/15 text-status-error",
};

/** The fields Save writes — what "unsaved changes" compares. */
function editableFields(q: Question) {
  return {
    question_text: q.question_text,
    choices: q.choices,
    correct_answer: q.correct_answer,
    explanation: q.explanation,
    difficulty: q.difficulty,
    domain: q.domain,
    skill: q.skill,
    concept: q.concept,
    question_type: q.question_type,
    has_image: q.has_image,
    has_table: q.has_table,
    has_formula: q.has_formula,
    page_number: q.page_number,
  };
}

export default function QuestionReviewPanel({ question: initial, nav, moduleKeyFacts }: QuestionReviewPanelProps) {
  const router = useRouter();

  // Jump to the next pending question in this module (or back to the module
  // when none are left). Keeps the reviewer on one fast path instead of the
  // approve → back → lost-my-place round trip.
  function goNext() {
    if (!nav) return;
    if (nav.nextId) router.push(`/admin/questions/${nav.nextId}`);
    else router.push(`/admin/modules/${nav.moduleId}/review`);
  }

  async function approveAndNext() {
    if (!(await saveIfDirty())) return;
    setActionLoading("approve-next");
    try {
      const res = await fetch(`/api/admin/questions/${q.id}/approve`, { method: "POST" });
      if (res.ok) {
        goNext();
      } else {
        const json = await res.json().catch(() => ({}));
        showToast(json.error ?? "Action failed", false);
        setActionLoading(null);
      }
    } catch {
      showToast("Action failed", false);
      setActionLoading(null);
    }
  }
  const [q, setQ] = useState<Question>(initial);
  const [saving, setSaving] = useState(false);
  // Last saved copy of the editable fields; anything different is unsaved.
  const [saved, setSaved] = useState(() => JSON.stringify(editableFields(initial)));
  const dirty = JSON.stringify(editableFields(q)) !== saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // The key / explanation as last loaded or saved: sent as `base` so the
  // server refuses a save made on top of a newer key or explanation.
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  // "Report to dev" box: closed | open | sent (with the support thread id).
  const [report, setReport] = useState<{ open: boolean; sent: { message: string; supportId: string | null } | null }>({ open: false, sent: null });
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  type ViewMode = "edit" | "test" | "results";
  const [viewMode, setViewMode] = useState<ViewMode>("edit");
  /** Local answer state for the student-test preview — no DB writes. */
  const [previewAnswer, setPreviewAnswer] = useState("");
  const [previewCrossedOut, setPreviewCrossedOut] = useState<Set<string>>(new Set());

  const [cropIndex, setCropIndex] = useState<number | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  // "Re-extract from PDF": the AI's fresh read of this question, shown next
  // to the saved copy until the reviewer applies or closes it.
  const [reextracting, setReextracting] = useState(false);
  const [reextract, setReextract] = useState<ReextractProposal | null>(null);
  // "Regenerate explanation": an AI-written explanation for the question as
  // it is on the page now, previewed until the reviewer picks Use or Discard.
  const [regenBusy, setRegenBusy] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [regen, setRegen] = useState<{ explanation: string; forAnswer: string; aiAnswer: string | null; agrees: boolean; partial?: boolean } | null>(null);

  // Delete or replace one extracted image (reviewer cleanup of bad crops).
  async function editImage(index: number, action: "delete" | "replace", png?: Blob) {
    const url = q.image_urls?.[index];
    if (!url) return false;
    const form = new FormData();
    form.set("action", action);
    form.set("index", String(index));
    form.set("url", url);
    if (png) form.set("file", new File([png], "crop.png", { type: "image/png" }));
    setImageBusy(true);
    try {
      const res = await fetch(`/api/admin/questions/${q.id}/images`, { method: "POST", body: form });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(json.error ?? "Image update failed", false);
        return false;
      }
      setQ((prev) => ({
        ...prev,
        image_urls: json.image_urls,
        image_alts: json.image_alts,
        ...(json.has_image === false ? { has_image: false } : {}),
      }));
      if (json.has_image === false) setSaved((prev) => JSON.stringify({ ...JSON.parse(prev), has_image: false }));
      showToast(action === "delete" ? "Image deleted" : "Image cropped");
      return true;
    } catch {
      showToast("Image update failed", false);
      return false;
    } finally {
      setImageBusy(false);
    }
  }

  function deleteImage(index: number) {
    const last = (q.image_urls?.length ?? 0) === 1;
    const msg = last
      ? "Delete this image? It's the only image, so this question will show no figure."
      : "Delete this image?";
    if (window.confirm(msg)) void editImage(index, "delete");
  }

  async function saveCrop(index: number, png: Blob) {
    if (await editImage(index, "replace", png)) setCropIndex(null);
  }

  function showToast(msg: string, ok = true) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  }

  // Save the editable fields. Returns false (and says so) when it failed, so
  // callers that save before moving on can stop instead of dropping edits.
  const qRef = useRef(q);
  qRef.current = q;
  const handleSave = useCallback(async (): Promise<boolean> => {
    const sent = qRef.current;
    const fields = editableFields(sent);
    const last = JSON.parse(savedRef.current) as { correct_answer: string | null; explanation: string | null };
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/questions/${sent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fields, base: { correct_answer: last.correct_answer, explanation: last.explanation } }),
      });
      if (res.ok) {
        const json = await res.json().catch(() => ({}));
        // A key change rewrites (or hides) the explanation and may change the
        // status and notes on the server: take what was actually saved, so a
        // later save never sends the old explanation back.
        const d = (json.data ?? {}) as Partial<Question>;
        const server = {
          ...sent,
          ...("explanation" in d ? { explanation: d.explanation ?? null } : {}),
          ...("correct_answer" in d ? { correct_answer: d.correct_answer ?? null } : {}),
          ...("parsing_status" in d && d.parsing_status ? { parsing_status: d.parsing_status } : {}),
          ...("parsing_notes" in d ? { parsing_notes: d.parsing_notes ?? null } : {}),
          ...("official_answer" in d ? { official_answer: d.official_answer ?? null } : {}),
        } as Question;
        // The saved baseline is the server's version either way.
        setSaved(JSON.stringify(editableFields(server)));
        const editedSince = JSON.stringify(editableFields(qRef.current)) !== JSON.stringify(fields);
        if (!editedSince) {
          setQ(server);
        } else {
          // Never overwrite what the admin typed during a long save: take only
          // the fields the page doesn't edit, and say the server changed text.
          setQ((cur) => ({ ...cur, parsing_status: server.parsing_status, parsing_notes: server.parsing_notes, official_answer: server.official_answer }));
        }
        const serverChangedText = (server.explanation ?? "") !== (sent.explanation ?? "");
        if (json.warning) showToast(`Saved, but: ${json.warning}`, false);
        else if (editedSince && serverChangedText) showToast("Saved. The server also rewrote the explanation while you were typing — reload to see it before saving again.", false);
        else showToast("Saved");
        return true;
      }
      const json = await res.json().catch(() => ({}));
      showToast(json.error ?? "Save failed — your edits are still here", false);
      return false;
    } catch {
      showToast("Save failed — check your connection; your edits are still here", false);
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  /** Save pending edits before an action that leaves or changes status. */
  async function saveIfDirty(): Promise<boolean> {
    return dirtyRef.current ? handleSave() : true;
  }

  /** Navigate within the app, saving pending edits first. */
  async function go(href: string) {
    if (await saveIfDirty()) router.push(href);
  }

  // Ctrl/⌘+S saves; closing or reloading the tab with unsaved edits asks
  // first; clicking a link elsewhere on the page (sidebar, breadcrumbs) with
  // unsaved edits asks first too.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirtyRef.current) void handleSave();
      }
    }
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    }
    function onClick(e: MouseEvent) {
      if (!dirtyRef.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || url.pathname === location.pathname) return;
      if (!window.confirm("You have unsaved changes on this question. Leave without saving?")) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [handleSave]);

  async function handleAction(action: "approve" | "reject" | "needs-review") {
    if (!(await saveIfDirty())) return;
    setActionLoading(action);
    try {
      const res = await fetch(`/api/admin/questions/${q.id}/${action}`, {
        method: "POST",
      });
      if (res.ok) {
        const json = await res.json();
        setQ((prev) => ({ ...prev, parsing_status: json.data.parsing_status }));
        showToast(`Marked as ${action === "needs-review" ? "Needs Review" : action}`);
        router.refresh();
      } else {
        const json = await res.json().catch(() => ({}));
        showToast(json.error ?? "Action failed", false);
      }
    } finally {
      setActionLoading(null);
    }
  }

  async function handleResolveMismatch(trust: "ai" | "official") {
    if (!(await saveIfDirty())) return;
    setActionLoading(`resolve-${trust}`);
    try {
      const res = await fetch(`/api/admin/questions/${q.id}/resolve-mismatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trust }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        setQ((prev) => ({
          ...prev,
          correct_answer: json.data.correct_answer,
          official_answer: json.data.official_answer,
          mismatch_with_official: false,
          parsing_status: json.data.parsing_status,
          parsing_notes: json.data.parsing_notes,
          explanation: json.data.explanation ?? null,
        }));
        setSaved((prev) => JSON.stringify({ ...JSON.parse(prev), correct_answer: json.data.correct_answer, explanation: json.data.explanation ?? null }));
        if (json.approved === false || json.warning) {
          showToast(
            `Key saved, not approved: ${json.warning ?? "the explanation couldn't be checked"}`,
            false,
          );
        } else {
          showToast(
            trust === "ai" ? "Approved using AI's answer" : "Approved using answer key",
          );
        }
        router.refresh();
      } else {
        showToast(json.error ?? "Resolve failed", false);
      }
    } finally {
      setActionLoading(null);
    }
  }

  // The AI's answer for the mismatch panel. Prefer the "Mismatch: AI answered
  // X, official Y" note, but fall back to the answer the explanation actually
  // argues for (or the stored correct_answer) so re-processed rows — whose note
  // was overwritten by a later repair — still show a real value and keep the
  // "Trust AI" button usable.
  const answerFromExplanation = (() => {
    const e = q.explanation ?? "";
    const fin = e.match(/final\s*answer\s*:\s*([^\n\r.]+)/i)?.[1]?.trim();
    if (fin) return fin.replace(/[.$]+$/, "").trim();
    const isMcq = q.question_type === "Multiple Choice";
    if (isMcq) {
      const m = [...e.matchAll(/(?:correct answer is|answer is|answer:|option|choice|\()\s*([ABCD])\b/gi)];
      if (m.length) return m[m.length - 1][1].toUpperCase();
    }
    return null;
  })();
  // Where the saved key came from (not the unsaved edit in the field).
  const savedKey = (JSON.parse(saved) as { correct_answer: string | null }).correct_answer;
  const keySrc = keySource({ ...q, correct_answer: savedKey }, moduleKeyFacts);

  const aiAnswer =
    (q.parsing_notes
      ? q.parsing_notes.match(/Mismatch:\s*AI answered\s+([^,;]+?)\s*,\s*official/i)?.[1]?.trim() ?? null
      : null) ??
    answerFromExplanation ??
    q.correct_answer ??
    null;
  // When the "Mismatch: AI answered X" note is gone (overwritten by a later
  // repair), aiAnswer falls back to the explanation / key, so the resolver
  // showed "AI answered B / key B — pick one", which reads as a bug. Show the
  // full resolver only while the two answers differ; otherwise a compact line
  // that still lets the reviewer settle (and clear) the flag.
  const mismatchAgrees =
    answersAgreeForQuestion(aiAnswer, q.official_answer ?? savedKey, q.question_text) &&
    answersAgreeForQuestion(aiAnswer, savedKey, q.question_text);
  const showMismatch = Boolean(q.mismatch_with_official) && !mismatchAgrees;
  const showSettledMismatch = Boolean(q.mismatch_with_official) && mismatchAgrees;

  function updateChoice(label: string, text: string) {
    setQ((prev) => ({
      ...prev,
      choices: prev.choices.map((c) => (c.label === label ? { ...c, text } : c)),
    }));
  }

  // Multiple choice ↔ Fill-in switch. A fill-in question never carries
  // choices; the choices are kept aside so switching back restores them.
  const stashedChoices = useRef<Choice[]>([]);
  function setQuestionType(newType: Question["question_type"]) {
    setQ((prev) => {
      if (prev.question_type === newType) return prev;
      if (newType === SPR_TYPE) {
        if (prev.choices.length > 0) stashedChoices.current = prev.choices;
        return { ...prev, question_type: newType, choices: [] };
      }
      const restore = prev.choices.length === 0 ? stashedChoices.current : prev.choices;
      return { ...prev, question_type: newType, choices: restore };
    });
  }

  // Type and key must fit each other before Approve (same rule as the server).
  const keyProblem = keyTypeProblem(q);
  const approveBlockedTitle = keyProblem ? `Can't approve: ${keyProblem.reason}` : undefined;

  // "AI suggestion · Use": the AI solves the question as it is on the page
  // (independently of the saved key). Fill-in values come from its
  // computation evaluated in code, rounded as the stem asks.
  const [aiSuggestBusy, setAiSuggestBusy] = useState(false);
  const [aiSuggest, setAiSuggest] = useState<{ answer: string | null; warnings: string[]; forType: string | null } | null>(null);
  const [aiSuggestError, setAiSuggestError] = useState<string | null>(null);
  async function runAiSuggestion() {
    setAiSuggestBusy(true);
    setAiSuggest(null);
    setAiSuggestError(null);
    try {
      const res = await fetch(`/api/admin/questions/${q.id}/ai-answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question_text: q.question_text, choices: q.choices, question_type: q.question_type }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) setAiSuggest({ answer: json.answer ?? null, warnings: json.warnings ?? [], forType: q.question_type });
      else setAiSuggestError(json.error ?? "Couldn't get an AI answer.");
    } catch {
      setAiSuggestError("Couldn't get an AI answer.");
    } finally {
      setAiSuggestBusy(false);
    }
  }

  /** Fill-in answer field: only characters an accepted SPR answer can contain. */
  function onAnswerChange(raw: string) {
    const v = q.question_type === SPR_TYPE ? raw.replace(/[^0-9./\-|\sor]/gi, "") : raw;
    setQ((prev) => ({ ...prev, correct_answer: v || null }));
  }

  async function handleCropSourceFigure() {
    if (
      !window.confirm(
        "Re-run the image cropper for this question? Claude will pick a fresh bounding box and upload the new crop.",
      )
    )
      return;
    setActionLoading("source-figure-crop");
    try {
      const res = await fetch(`/api/admin/questions/${q.id}/repair-image`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      showToast(json.message ?? (res.ok ? "Figure re-cropped." : "Crop failed."), res.ok);
      if (res.ok) {
        // Local state doesn't follow router.refresh(); pull the new image fields.
        const fresh = await fetch(`/api/admin/questions/${q.id}`).then((r) => r.json()).catch(() => null);
        if (fresh?.data) {
          setQ((prev) => ({
            ...prev,
            has_image: fresh.data.has_image,
            image_urls: fresh.data.image_urls,
            image_alts: fresh.data.image_alts,
          }));
        }
        router.refresh();
      }
    } catch {
      showToast("Crop failed.", false);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleDeleteSourceFigure() {
    if (
      !window.confirm(
        "Remove this source figure? The question will display only the text and any extracted images.",
      )
    )
      return;
    setActionLoading("source-figure-delete");
    try {
      const res = await fetch(`/api/admin/questions/${q.id}/clear-image-flag`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      showToast(json.message ?? (res.ok ? "Source figure removed." : "Delete failed."), res.ok);
      if (res.ok) {
        setQ((prev) => ({ ...prev, has_image: false, image_urls: [], image_alts: [] }));
        router.refresh();
      }
    } catch {
      showToast("Delete failed.", false);
    } finally {
      setActionLoading(null);
    }
  }

  // Use admin-only proxy route (handles private-blob auth) instead of raw URL
  async function runReextract() {
    setReextracting(true);
    setReextract(null);
    try {
      const res = await fetch(`/api/admin/questions/${q.id}/reextract`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) setReextract(json.proposal);
      else showToast(json.message ?? json.error ?? "Couldn't read the PDF", false);
    } catch {
      showToast("Couldn't read the PDF", false);
    } finally {
      setReextracting(false);
    }
  }

  // Sends the page's current (possibly unsaved) text, choices and answer.
  // Nothing is saved: the preview only fills the field on Use.
  async function runRegenerateExplanation() {
    const answer = (q.correct_answer ?? "").trim();
    setRegen(null);
    setRegenError(null);
    if (!answer) {
      setRegenError("Set the correct answer first.");
      return;
    }
    setRegenBusy(true);
    try {
      const res = await fetch(`/api/admin/questions/${q.id}/regenerate-explanation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question_text: q.question_text,
          choices: q.choices,
          correct_answer: answer,
          question_type: q.question_type,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) {
        setRegen({ explanation: json.explanation, forAnswer: answer, aiAnswer: json.ai_answer ?? null, agrees: json.agrees !== false });
      } else if (typeof json.partial === "string" && json.partial.trim()) {
        // Still cut off after the retry: hand the reviewer the draft to finish.
        setRegen({ explanation: json.partial, forAnswer: answer, aiAnswer: null, agrees: true, partial: true });
      } else {
        setRegenError(json.error ?? "Couldn't produce a complete explanation.");
      }
    } catch {
      setRegenError("Couldn't produce a complete explanation.");
    } finally {
      setRegenBusy(false);
    }
  }

  function applyReextract(patch: ReextractPatch) {
    setQ((prev) => ({
      ...prev,
      question_text: patch.question_text ?? prev.question_text,
      choices: patch.choices
        ? prev.choices.map((c) => (patch.choices![c.label] !== undefined ? { ...c, text: patch.choices![c.label]! } : c))
        : prev.choices,
      correct_answer: patch.correct_answer ?? prev.correct_answer,
    }));
    if (patch.question_type) setQuestionType(patch.question_type);
    setReextract(null);
    showToast("Applied to the editor. Review it, then Save.");
  }

  const pdfUrl = q.modules?.pdf_url ? `/api/admin/modules/${q.module_id}/pdf` : null;
  const pageNum = q.page_number ?? 1;

  return (
    <div className="flex flex-col gap-4">
      {/* In-module review stepper — prev / count / next, so the reviewer
          moves through a module's pending questions without round-tripping
          back to the list each time. */}
      {nav && (
        <div className="flex items-center justify-between rounded-xl border border-divider bg-surface px-3 py-2 text-sm">
          <button
            onClick={() => nav.prevId && void go(`/admin/questions/${nav.prevId}`)}
            disabled={!nav.prevId}
            className="inline-flex items-center gap-1 text-mid-gray hover:text-charcoal disabled:opacity-30 transition-colors"
          >
            <ChevronLeft size={16} /> Prev
          </button>
          <span className="text-soft-mute text-xs">
            {nav.pendingCount > 0
              ? `${nav.pendingCount} left to review in this module`
              : nav.nextModuleName
                ? `This module is done · next: ${nav.nextModuleName}`
                : "All questions reviewed"}
          </span>
          <button
            onClick={() => void go(nav.nextId ? `/admin/questions/${nav.nextId}` : `/admin/modules/${nav.moduleId}/review`)}
            className="inline-flex items-center gap-1 text-mid-gray hover:text-charcoal transition-colors"
          >
            {nav.nextId ? (nav.nextModuleName ? "Next module to review" : "Next") : "Back to module"} <ChevronRight size={16} />
          </button>
        </div>
      )}

      {/* Unsaved changes bar */}
      {dirty && (
        <div
          role="status"
          className="sticky bottom-3 z-40 order-last mx-auto flex items-center gap-3 rounded-xl border border-warm-coral/30 bg-surface px-4 py-2.5 text-sm shadow-lg"
        >
          <span className="h-2 w-2 rounded-full bg-warm-coral" aria-hidden />
          <span className="font-medium text-charcoal">Unsaved changes</span>
          <span className="hidden text-xs text-soft-mute sm:inline">Saved automatically when you approve, flag or move on</span>
          <button
            type="button"
            onClick={() => setQ((prev) => ({ ...prev, ...JSON.parse(saved) }))}
            disabled={saving}
            className="rounded-lg px-2.5 py-1 text-xs font-medium text-mid-gray hover:bg-light-bg hover:text-charcoal disabled:opacity-50"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-warm-coral px-3 py-1 text-xs font-semibold text-white hover:bg-warm-coral-dark disabled:opacity-50"
          >
            <Save size={13} />
            {saving ? "Saving…" : "Save (⌘S)"}
          </button>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          className={clsx(
            "fixed top-4 right-4 z-50 px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg",
            toast.ok ? "bg-warm-amber/20 text-warm-amber border border-warm-amber/30" : "bg-status-error/15 text-status-error border border-status-error/30"
          )}
        >
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="text-soft-mute text-sm">
            Q{q.original_question_number ?? "?"} · {q.modules?.module_name ?? "Unknown module"}
          </span>
          <span className={clsx("px-2 py-0.5 rounded-full text-xs font-medium", statusStyles[q.parsing_status])}>
            {q.parsing_status}
          </span>
          <ConfidenceBadge score={q.ai_confidence_score} />
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => void handleSave()}
            disabled={saving || !dirty}
            title="Save (Ctrl/⌘+S)"
            className={clsx(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50",
              dirty
                ? "bg-warm-coral text-white hover:bg-warm-coral-dark ring-2 ring-warm-coral/30"
                : "bg-surface hover:bg-light-bg text-charcoal",
            )}
          >
            <Save size={14} />
            {saving ? "Saving..." : dirty ? "Save changes" : "Saved"}
          </button>
          <button
            onClick={() => handleAction("approve")}
            disabled={actionLoading !== null || q.parsing_status === "Approved" || !!keyProblem}
            title={approveBlockedTitle}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-warm-amber/15 hover:bg-warm-amber/25 text-warm-amber text-sm font-medium transition-colors disabled:opacity-50"
          >
            <CheckCircle2 size={14} />
            {actionLoading === "approve" ? "..." : "Approve"}
          </button>
          {nav && (
            <button
              onClick={approveAndNext}
              disabled={actionLoading !== null || !!keyProblem}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-warm-amber hover:bg-warm-amber/90 text-white text-sm font-semibold transition-colors disabled:opacity-50"
              title={approveBlockedTitle ?? "Approve this question and jump to the next one needing review"}
            >
              <ArrowRightCircle size={14} />
              {actionLoading === "approve-next" ? "..." : "Approve & Next"}
            </button>
          )}
          <button
            onClick={() => handleAction("reject")}
            disabled={actionLoading !== null || q.parsing_status === "Rejected"}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-status-error/15 hover:bg-status-error/25 text-status-error text-sm font-medium transition-colors disabled:opacity-50"
          >
            <XCircle size={14} />
            {actionLoading === "reject" ? "..." : "Reject"}
          </button>
          <button
            onClick={() => handleAction("needs-review")}
            disabled={actionLoading !== null || q.parsing_status === "Needs Review"}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-status-warning/15 hover:bg-status-warning/25 text-status-warning text-sm font-medium transition-colors disabled:opacity-50"
          >
            <AlertCircle size={14} />
            {actionLoading === "needs-review" ? "..." : "Flag"}
          </button>
          <button
            onClick={() => setReport((r) => ({ open: !r.open || !!r.sent, sent: null }))}
            disabled={actionLoading !== null}
            aria-expanded={report.open}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-100 hover:bg-purple-200 text-purple-800 text-sm font-medium transition-colors disabled:opacity-50"
            title="Send a bug report to the dev team with a link to this question"
          >
            <Bug size={14} />
            Report to dev
          </button>
        </div>
      </div>

      {report.open && (
        <div className="rounded-xl border border-divider bg-surface p-4 space-y-2">
          {report.sent ? (
            <div role="status" className="space-y-2">
              <p className="text-sm text-charcoal">
                <CheckCircle2 size={14} className="inline mr-1.5 text-status-success" />
                {report.sent.message}
              </p>
              <div className="flex items-center gap-4 text-sm">
                <a
                  href={report.sent.supportId ? `/admin/support#${report.sent.supportId}` : "/admin/support"}
                  className="text-warm-coral-text hover:underline"
                >
                  View on Report a Problem
                </a>
                <button onClick={() => setReport({ open: false, sent: null })} className="text-mid-gray hover:text-charcoal">
                  Close
                </button>
              </div>
            </div>
          ) : (
            <>
              <h2 className="text-sm font-semibold text-charcoal">Report this question to the dev team</h2>
              <SupportComposer
                url={`/api/admin/questions/${q.id}/report-bug`}
                field="note"
                optional
                autoFocus
                placeholder="Optional: what's broken on this question? Leave blank to just send a report."
                button="Send"
                onDone={(data) =>
                  setReport({
                    open: true,
                    sent: {
                      message: typeof data.message === "string" ? data.message : "Report sent.",
                      supportId: typeof data.supportId === "string" ? data.supportId : null,
                    },
                  })
                }
              />
            </>
          )}
        </div>
      )}

      {/* View mode tabs: Edit | Student view (test) | Student view (results) */}
      <div className="flex items-center gap-1 border-b border-divider pb-0">
        {(
          [
            { key: "edit", label: "Edit", Icon: BookOpen },
            { key: "test", label: "Student view (test)", Icon: Eye },
            { key: "results", label: "Student view (results)", Icon: FileCheck },
          ] as const
        ).map(({ key, label, Icon }) => (
          <button
            key={key}
            onClick={() => {
              setViewMode(key);
              if (key !== "test") setPreviewAnswer("");
            }}
            className={clsx(
              "flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors -mb-px",
              viewMode === key
                ? "border-warm-coral text-warm-coral-text bg-warm-coral/5"
                : "border-transparent text-mid-gray hover:text-charcoal hover:bg-light-bg",
            )}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {/* Flags — translated, action-oriented banner with one-click
          repair buttons. Raw engineering string lives behind a
          collapsible disclosure for the rare case the reviewer
          wants the original log line. */}
      {viewMode === "edit" && q.parsing_notes && (
        <ParsingNoteBanner
          questionId={q.id}
          raw={q.parsing_notes}
          onReloaded={() => router.refresh()}
        />
      )}

      {viewMode === "edit" && showSettledMismatch && (
        <div className="bg-light-bg border border-divider rounded-2xl px-4 py-3 flex flex-wrap items-center gap-3">
          <p className="text-mid-gray text-xs flex-1 min-w-[240px]">
            This question was flagged at import because the AI&rsquo;s first answer differed from the
            answer key. Its current answer ({aiAnswer}) matches the key, so there is nothing to choose.
          </p>
          <button
            onClick={() => handleResolveMismatch("official")}
            disabled={!!actionLoading || !q.official_answer}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-surface border border-divider hover:bg-light-bg disabled:opacity-50"
          >
            {actionLoading === "resolve-official" ? "Saving…" : "Keep answer key & approve"}
          </button>
        </div>
      )}

      {/* Mismatch resolver — visible only when AI disagreed with the answer
          key at parse time. One-click to pick which answer wins. */}
      {viewMode === "edit" && showMismatch && (
        <div className="bg-status-warning/10 border border-status-warning/30 rounded-2xl p-4 space-y-3">
          <div className="flex items-start gap-2">
            <AlertCircle size={16} className="text-status-warning shrink-0 mt-0.5" />
            <div>
              <p className="text-charcoal text-sm font-semibold">
                Answer mismatch — pick which one to trust
              </p>
              <p className="text-mid-gray text-xs mt-0.5">
                The AI solver disagreed with {keySrc.officialFromPdf ? "the PDF\u2019s answer key" : "the stored key"}{" "}on this question. Read both, then
                approve the correct one. Choosing &ldquo;Trust AI&rdquo; will overwrite
                <code className="px-1"> correct_answer</code> with the AI&rsquo;s value.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="bg-surface border border-divider rounded-xl p-3 space-y-2">
              <p className="text-xs uppercase tracking-wider text-soft-mute font-semibold flex items-center gap-1.5">
                <Sparkles size={12} className="text-warm-coral-text" />
                AI answered
              </p>
              <p className="text-2xl font-bold text-warm-coral-text">
                {aiAnswer ?? "?"}
              </p>
              {q.explanation && (
                <div className="text-mid-gray text-xs leading-relaxed border-t border-divider pt-2 max-h-32 overflow-y-auto">
                  <p className="font-medium text-charcoal mb-1">AI&rsquo;s explanation</p>
                  <MathMarkdown>{q.explanation}</MathMarkdown>
                </div>
              )}
              <button
                onClick={() => handleResolveMismatch("ai")}
                disabled={actionLoading !== null || !aiAnswer}
                className="w-full mt-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-warm-coral hover:bg-warm-coral-dark text-white text-sm font-semibold transition-colors disabled:opacity-50"
              >
                <Sparkles size={13} />
                {actionLoading === "resolve-ai" ? "Resolving..." : "Trust AI's answer"}
              </button>
            </div>

            {keySrc.officialFromPdf ? (
              <div className="bg-surface border border-divider rounded-xl p-3 space-y-2">
                <p className="text-xs uppercase tracking-wider text-soft-mute font-semibold flex items-center gap-1.5">
                  <KeyRound size={12} className="text-status-success" />
                  Official key (from PDF)
                </p>
                <p className="text-2xl font-bold text-status-success">
                  {q.official_answer}
                </p>
                <p className="text-mid-gray text-xs leading-relaxed border-t border-divider pt-2">
                  Read from the answer key page / ✓ marks of the source PDF.
                  {moduleKeyFacts?.keyDisagreement && (
                    <span className="block mt-1 text-status-warning">
                      Caution: this module&rsquo;s key disagrees with the solved answers on {moduleKeyFacts.keyDisagreement} questions — check it is the key for this module.
                    </span>
                  )}
                </p>
                <button
                  onClick={() => handleResolveMismatch("official")}
                  disabled={actionLoading !== null}
                  className="w-full mt-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-status-success hover:bg-status-success/90 text-white text-sm font-semibold transition-colors disabled:opacity-50"
                >
                  <KeyRound size={13} />
                  {actionLoading === "resolve-official" ? "Resolving..." : "Trust answer key"}
                </button>
              </div>
            ) : (
              <div className="bg-surface border border-divider rounded-xl p-3 space-y-2" aria-label="Current key">
                <p className="text-xs uppercase tracking-wider text-soft-mute font-semibold flex items-center gap-1.5">
                  <KeyRound size={12} className="text-soft-mute" />
                  Current key · {keySrc.label}
                </p>
                <p className="text-2xl font-bold text-charcoal">
                  {savedKey ?? "?"}
                </p>
                <p className="text-mid-gray text-xs leading-relaxed border-t border-divider pt-2">
                  No official key from the PDF to trust here
                  {keySrc.officialProblem ? <> (the stored &ldquo;official&rdquo; value {q.official_answer ?? ""} isn&rsquo;t one: {keySrc.officialProblem})</> : null}.
                  {" "}{keySrc.detail} Check the answer yourself, then use the AI&rsquo;s answer or edit the key below.
                </p>
              </div>
            )}
          </div>

          <p className="text-soft-mute text-xs italic">
            Need a third option? Edit <code>correct_answer</code> below and click Save +
            Approve manually.
          </p>
        </div>
      )}

      {/* ── Student preview: test view ── */}
      {viewMode === "test" && (
        <div className="rounded-2xl border border-divider bg-surface p-6">
          <p className="text-xs text-soft-mute uppercase tracking-wider font-medium mb-4">
            Student view · Test-taking — read only, includes unsaved edits
          </p>
          <QuestionRenderer
            question={{
              id: q.id,
              module_id: q.module_id,
              original_question_number: q.original_question_number ?? 1,
              question_text: q.question_text,
              choices: q.choices ?? [],
              question_type: (q.question_type ?? "Multiple Choice") as "Multiple Choice" | "Student Produced Response",
              has_image: q.has_image,
              has_table: q.has_table,
              source_pdf_url: null,
              page_number: q.page_number,
              section: q.section,
              image_urls: q.image_urls,
              image_alts: q.image_alts,
            }}
            selectedAnswer={previewAnswer}
            onAnswer={setPreviewAnswer}
            crossedOut={previewCrossedOut}
            onToggleCrossOut={(label) =>
              setPreviewCrossedOut((prev) => {
                const next = new Set(prev);
                if (next.has(label)) next.delete(label);
                else next.add(label);
                return next;
              })
            }
            questionIndex={0}
            totalQuestions={1}
            annotationsEnabled={false}
            showSourceFigure={false}
            showDebugBadges={false}
          />
        </div>
      )}

      {/* ── Student preview: results/review view ── */}
      {viewMode === "results" && (
        <div className="rounded-2xl border border-divider bg-surface p-6">
          <p className="text-xs text-soft-mute uppercase tracking-wider font-medium mb-4">
            Student view · Results &amp; review — read only, includes unsaved edits
          </p>
          <ReviewQuestionCard
            question={{
              id: q.id,
              module_id: q.module_id,
              original_question_number: q.original_question_number ?? 1,
              question_text: q.question_text,
              choices: q.choices ?? [],
              question_type: (q.question_type ?? "Multiple Choice") as "Multiple Choice" | "Student Produced Response",
              correct_answer: q.correct_answer,
              explanation: q.explanation,
              has_image: q.has_image,
              has_table: q.has_table,
              image_urls: q.image_urls,
              image_alts: q.image_alts,
              page_number: q.page_number,
              source_pdf_url: null,
            }}
            mine={null}
            showExplanation
            showSourceFigure={false}
          />
        </div>
      )}

      {/* Side-by-side layout */}
      {viewMode === "edit" && <div className="grid grid-cols-2 gap-6 min-h-[640px]">
        {/* Left: PDF */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-soft-mute font-medium uppercase tracking-wide">
              PDF · Page {pageNum}
            </p>
            {pdfUrl && q.page_number != null && (
              <button
                type="button"
                onClick={() => void runReextract()}
                disabled={reextracting}
                title="Read this question again from the PDF page and compare it with the saved copy"
                className="inline-flex items-center gap-1.5 rounded-lg border border-divider bg-surface px-2.5 py-1 text-xs font-medium text-charcoal hover:bg-light-bg disabled:opacity-60"
              >
                <FileSearch size={13} />
                {reextracting ? "Reading the PDF… (about 10–30 s)" : "Re-extract from PDF"}
              </button>
            )}
          </div>
          {pdfUrl ? (
            <PDFViewer url={pdfUrl} page={pageNum} className="flex-1 min-h-[600px] w-full rounded-xl border border-divider" />
          ) : (
            <div className="flex-1 bg-surface border border-divider rounded-xl flex items-center justify-center text-soft-mute text-sm">
              No PDF
            </div>
          )}
        </div>

        {/* Right: Editable form */}
        <div className="flex flex-col gap-4 overflow-y-auto max-h-[780px] pr-1">
          {reextract && (
            <ReextractPanel
              current={{ question_text: q.question_text, choices: q.choices, correct_answer: q.correct_answer, question_type: q.question_type }}
              proposal={reextract}
              onApply={applyReextract}
              onClose={() => setReextract(null)}
            />
          )}
          {/* Question text */}
          <div>
            <label className="block text-xs text-soft-mute mb-1">Question Text</label>
            <EditableMath
              label="Question text"
              value={q.question_text}
              rows={8}
              onChange={(v) => setQ((prev) => ({ ...prev, question_text: v }))}
            />
          </div>

          {/* Inline PDF page — FALLBACK only shown when no extracted crop
              exists. Auto-hidden when the table is already in question_text
              as Markdown (has_table-only rows): the student won't see a
              redundant PDF screenshot alongside the rendered table. When
              has_image is ALSO set (real figure or misclassified), we still
              show the iframe so the reviewer can crop or delete it. */}
          {(() => {
            const noExtracts = !(q.image_urls && q.image_urls.length > 0);
            const tableInText = hasMarkdownTable(q.question_text);
            // True when the source figure would show only because has_table
            // is set — the table is already rendered from Markdown, so the
            // full-page PDF view is a pure duplicate.
            const tableOnlyDuplicate = q.has_table && !q.has_image && noExtracts && tableInText;
            const showSourceFigure =
              (q.has_image || q.has_table) && noExtracts && !tableOnlyDuplicate;

            return (
              <>
                {/* Duplicate-table notice: table already in text, figure auto-hidden */}
                {tableOnlyDuplicate && (
                  <div className="flex items-center gap-2 rounded-xl bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-800">
                    <AlertCircle size={14} className="shrink-0 text-blue-500" />
                    <span>
                      Table already in question text — source figure hidden automatically.
                    </span>
                  </div>
                )}

                {/* Duplicate warning when has_image=true AND markdown table present */}
                {showSourceFigure && tableInText && q.has_image && (
                  <div className="flex items-center gap-2 rounded-xl bg-status-warning/8 border border-status-warning/20 px-3 py-2 text-xs text-status-warning">
                    <AlertCircle size={14} className="shrink-0" />
                    <span>
                      Table is already in the question text — this source figure may be a screenshot of the same table.
                      Use <strong>Delete</strong> below if it is redundant.
                    </span>
                  </div>
                )}

                {showSourceFigure && (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-xs text-soft-mute">
                        Source figure · Page {q.page_number ?? 1}
                      </label>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={handleCropSourceFigure}
                          disabled={actionLoading !== null}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-surface border border-divider text-xs text-charcoal hover:bg-light-bg disabled:opacity-50 transition-colors"
                          title="Re-run the image cropper to get a clean bounding-box crop"
                        >
                          <Crop size={12} />
                          {actionLoading === "source-figure-crop" ? "Cropping…" : "Crop"}
                        </button>
                        <button
                          type="button"
                          onClick={handleDeleteSourceFigure}
                          disabled={actionLoading !== null}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-status-error/10 border border-status-error/20 text-xs text-status-error hover:bg-status-error/20 disabled:opacity-50 transition-colors"
                          title="Remove the source figure (clears has_image flag and any uploaded crops)"
                        >
                          <Trash2 size={12} />
                          {actionLoading === "source-figure-delete" ? "Deleting…" : "Delete"}
                        </button>
                      </div>
                    </div>
                    <iframe
                      src={`/api/modules/${q.module_id}/page/${q.page_number ?? 1}`}
                      className="w-full h-[360px] rounded-xl border border-divider bg-white"
                      title={`Question figure (PDF page ${q.page_number ?? 1})`}
                    />
                  </div>
                )}
              </>
            );
          })()}

          {/* Extracted images (best-effort enhancement when cropping worked) */}
          {q.image_urls && q.image_urls.length > 0 && (
            <div>
              <label className="block text-xs text-soft-mute mb-2">
                Extracted Images ({q.image_urls.length})
              </label>
              <div className="flex flex-wrap gap-3">
                {q.image_urls.map((url, i) => (
                  <div key={url} className="space-y-1">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/blob-image?u=${encodeURIComponent(url)}`}
                      alt={q.image_alts?.[i] ?? "Question image"}
                      className="max-w-full md:max-w-md rounded-xl border border-divider bg-white"
                    />
                    <div className="flex gap-3 text-xs">
                      <button
                        onClick={() => setCropIndex(i)}
                        disabled={imageBusy}
                        className="inline-flex items-center gap-1 text-mid-gray hover:text-charcoal disabled:opacity-40"
                      >
                        <Crop size={13} /> Crop
                      </button>
                      <button
                        onClick={() => deleteImage(i)}
                        disabled={imageBusy}
                        className="inline-flex items-center gap-1 text-status-error hover:underline disabled:opacity-40"
                      >
                        <Trash2 size={13} /> Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              {cropIndex !== null && q.image_urls[cropIndex] && (
                <ImageCropDialog
                  src={`/api/blob-image?u=${encodeURIComponent(q.image_urls[cropIndex])}`}
                  saving={imageBusy}
                  onCancel={() => setCropIndex(null)}
                  onSave={(png) => saveCrop(cropIndex, png)}
                />
              )}
            </div>
          )}

          {/* Choices — only shown for Multiple Choice questions */}
          {q.question_type === "Multiple Choice" && (
            <div>
              <label className="block text-xs text-soft-mute mb-2">
                Answer Choices {q.choices.length === 0 && (
                  <span className="text-soft-mute/70">(none yet)</span>
                )}
              </label>
              {q.choices.length > 0 ? (
                <div className="space-y-2">
                  {q.choices.map((c) => {
                    const isCorrect = q.correct_answer === c.label;
                    return (
                      <div key={c.label} className="flex items-center gap-2">
                        <span
                          className={clsx(
                            "text-xs w-5 shrink-0 font-semibold text-center rounded-full py-0.5",
                            isCorrect
                              ? "bg-warm-amber/25 text-warm-amber"
                              : "text-soft-mute",
                          )}
                        >
                          {c.label}
                        </span>
                        <div className="flex-1 flex flex-col gap-1">
                          {(c.text || !c.image_url) && (
                            <EditableMath
                              label={`Choice ${c.label}`}
                              value={c.text}
                              rows={2}
                              className="rounded-lg py-1.5"
                              onChange={(v) => updateChoice(c.label, v)}
                            />
                          )}
                          {c.image_url && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={`/api/blob-image?u=${encodeURIComponent(c.image_url)}`}
                              alt={`Choice ${c.label} graph`}
                              className="max-w-full md:max-w-xs rounded-lg border border-divider bg-white"
                            />
                          )}
                          {c.image_url && (
                            <EditableMath
                              label={`Choice ${c.label} text (optional, shown with the graph)`}
                              value={c.text}
                              rows={2}
                              className="rounded-lg py-1"
                              emptyText="Graph choice · click to add text"
                              onChange={(v) => updateChoice(c.label, v)}
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-xs text-soft-mute/70 italic">
                  No choices yet — add options below or re-parse.
                </div>
              )}
            </div>
          )}

          {/* Question type switch — right above the answer, so the type and
              the key are checked together. */}
          <div>
            <span className="block text-xs text-soft-mute mb-1">Question type</span>
            <div role="radiogroup" aria-label="Question type" className="inline-flex rounded-lg border border-divider bg-light-bg p-0.5 text-xs">
              {([
                [MC_TYPE, "Multiple choice"],
                [SPR_TYPE, "Fill-in (SPR)"],
              ] as const).map(([t, label]) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={q.question_type === t}
                  onClick={() => setQuestionType(t)}
                  className={clsx(
                    "rounded-md px-3 py-1 font-medium transition-colors",
                    q.question_type === t ? "bg-surface text-charcoal shadow-sm" : "text-soft-mute hover:text-charcoal",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {keyProblem && (
            <p role="alert" className="rounded-lg border border-status-error/30 bg-status-error/10 px-3 py-2 text-xs text-status-error">
              Can&rsquo;t approve yet: {keyProblem.reason}.
            </p>
          )}
          {q.question_type === SPR_TYPE && q.choices.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-soft-mute">
              This fill-in question still has {q.choices.length} answer choice{q.choices.length === 1 ? "" : "s"}.
              <button
                type="button"
                onClick={() => setQ((prev) => ({ ...prev, choices: [] }))}
                title="Clears the leftover choices on this page. Click Save to keep the change."
                className="rounded-md border border-divider bg-surface px-2 py-0.5 text-[11px] font-medium text-charcoal hover:bg-light-bg"
              >
                Remove choices
              </button>
            </div>
          )}

          {/* Correct answer + explanation */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="correct-answer" className="block text-xs text-soft-mute mb-1">Correct Answer</label>
              {savedKey && (
                <p className="mb-1 text-[11px] leading-snug text-soft-mute" title={keySrc.detail} data-testid="key-source">
                  <span className={clsx("font-semibold", keySrc.kind === "official-pdf" ? "text-status-success" : keySrc.kind === "ai-parsed" || keySrc.kind === "ai" || keySrc.kind === "other-version" || keySrc.kind === "unknown" ? "text-status-warning" : "text-charcoal")}>
                    {keySrc.label}
                  </span>
                  {keySrc.kind !== "official-pdf" && <> · {keySrc.detail}</>}
                </p>
              )}
              {q.correct_answer && (
                <MathMarkdown className="prose prose-sm max-w-none text-charcoal bg-light-bg border border-divider rounded-lg px-3 py-1.5 mb-1 [&_p]:my-0">
                  {q.correct_answer}
                </MathMarkdown>
              )}
              <input
                id="correct-answer"
                type="text"
                inputMode={q.question_type === SPR_TYPE ? "decimal" : undefined}
                value={q.correct_answer ?? ""}
                onChange={(e) => onAnswerChange(e.target.value)}
                aria-invalid={!!keyProblem}
                className={clsx(
                  "w-full bg-light-bg border rounded-lg px-3 py-1.5 text-xs text-charcoal focus:outline-none focus:border-warm-coral/50",
                  keyProblem ? "border-status-error/50" : "border-divider",
                )}
                placeholder={q.question_type === SPR_TYPE ? "e.g. 12, 3.5, 7/2" : "A, B, C or D"}
              />
              {q.question_type === SPR_TYPE && (() => {
                // Same code as grading (lib/answer-key gradedAsCorrect), for the key in the field.
                const graded = gradedAsCorrect(q.correct_answer, q.question_text).summary;
                return (
                  <>
                    {graded && (
                      <p className="mt-1 text-xs leading-snug text-charcoal" data-testid="graded-as-correct">{graded}</p>
                    )}
                    <details className="mt-1 text-[11px] leading-snug text-soft-mute">
                      <summary className="cursor-pointer">Allowed answer formats</summary>
                      {SPR_FORM_HELP}
                    </details>
                  </>
                );
              })()}
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={runAiSuggestion}
                  disabled={aiSuggestBusy || !q.question_type}
                  title="The AI solves the question as it is on this page, without looking at the saved key. Nothing changes until you click Use."
                  className="inline-flex items-center gap-1 rounded-md border border-divider bg-surface px-2 py-0.5 text-[11px] font-medium text-charcoal hover:bg-light-bg disabled:opacity-60"
                >
                  <Sparkles size={11} />
                  {aiSuggestBusy ? "Solving… (about 10–30 s)" : "AI suggestion"}
                </button>
                {aiSuggest && aiSuggest.forType === q.question_type && (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-charcoal" aria-label="AI suggestion">
                    {aiSuggest.answer ? (
                      <>
                        AI suggestion: <strong>{aiSuggest.answer}</strong>
                        {aiSuggest.answer !== (q.correct_answer ?? "").trim() && (
                          <>
                            {" · "}
                            <button
                              type="button"
                              onClick={() => setQ((prev) => ({ ...prev, correct_answer: aiSuggest.answer }))}
                              className="font-semibold text-warm-coral hover:underline"
                            >
                              Use
                            </button>
                          </>
                        )}
                      </>
                    ) : (
                      <span className="text-status-warning">No usable AI answer.</span>
                    )}
                  </span>
                )}
              </div>
              {aiSuggest && aiSuggest.forType === q.question_type && aiSuggest.warnings.length > 0 && (
                <p className="mt-1 text-[11px] text-status-warning">Check by hand: {aiSuggest.warnings.join("; ")}.</p>
              )}
              {aiSuggestError && <p className="mt-1 text-[11px] text-status-error">{aiSuggestError}</p>}
            </div>
            <div>
              <label className="block text-xs text-soft-mute mb-1">Page #</label>
              <input
                type="number"
                value={q.page_number ?? ""}
                onChange={(e) =>
                  setQ((prev) => ({ ...prev, page_number: e.target.value ? parseInt(e.target.value, 10) : null }))
                }
                className="w-full bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between gap-2 mb-1">
              <label className="block text-xs text-soft-mute">
                Explanation {q.explanation && (
                  <span className="text-soft-mute/70">({q.explanation.length} chars)</span>
                )}
              </label>
              <button
                type="button"
                onClick={runRegenerateExplanation}
                disabled={regenBusy}
                title="Write a new explanation from the question, choices and answer as they are on this page (unsaved edits included). Nothing is saved until you click Use and then Save."
                className="inline-flex items-center gap-1.5 rounded-lg border border-divider bg-surface px-2.5 py-1 text-xs font-medium text-charcoal hover:bg-light-bg disabled:opacity-60"
              >
                <Sparkles size={13} />
                {regenBusy ? "Writing… (about 10–40 s)" : "Regenerate explanation"}
              </button>
            </div>
            {regenError && (
              <p role="alert" className="mb-2 rounded-lg border border-status-error/30 bg-status-error/10 px-3 py-2 text-xs text-status-error">
                {regenError}
              </p>
            )}
            {regen && (
              <section aria-label="Regenerated explanation" className="mb-2 rounded-xl border border-warm-amber/40 bg-warm-amber/5 p-3 space-y-2">
                <p className="text-xs font-medium text-charcoal">
                  New explanation (preview — not saved) · explains answer {regen.forAnswer}
                </p>
                {regen.partial && (
                  <p role="alert" className="rounded-lg border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-status-warning">
                    Couldn't produce a complete explanation — this draft looks cut off at the end. Click Use to put it in the editor and finish it by hand.
                  </p>
                )}
                {!regen.agrees && regen.aiAnswer && (
                  <p role="alert" className="rounded-lg border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-status-warning">
                    Warning: working it out on its own, the AI got <strong>{regen.aiAnswer}</strong>, but the answer on this page is{" "}
                    <strong>{regen.forAnswer}</strong>. The explanation still argues {regen.forAnswer} — check the answer key. The answer was not changed.
                  </p>
                )}
                {(q.correct_answer ?? "").trim() !== regen.forAnswer && (
                  <p className="text-xs text-status-warning">The answer on the page has changed since this was written.</p>
                )}
                <MathMarkdown className="prose prose-sm max-w-none text-charcoal">{regen.explanation}</MathMarkdown>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setQ((prev) => ({ ...prev, explanation: regen.explanation }));
                      setRegen(null);
                      showToast("Explanation filled in. Review it, then Save.");
                    }}
                    className="rounded-lg bg-warm-coral px-3 py-1 text-xs font-medium text-white hover:opacity-90"
                  >
                    Use
                  </button>
                  <button
                    type="button"
                    onClick={() => setRegen(null)}
                    className="rounded-lg border border-divider bg-surface px-3 py-1 text-xs font-medium text-charcoal hover:bg-light-bg"
                  >
                    Discard
                  </button>
                </div>
              </section>
            )}
            <EditableMath
              label="Explanation"
              value={q.explanation ?? ""}
              rows={10}
              className="leading-relaxed"
              emptyText="No explanation yet · click to write one"
              onChange={(v) => setQ((prev) => ({ ...prev, explanation: v || null }))}
            />
          </div>

          {/* Metadata */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-soft-mute mb-1">Difficulty</label>
              <select
                value={q.difficulty ?? ""}
                onChange={(e) =>
                  setQ((prev) => ({ ...prev, difficulty: (e.target.value || null) as Question["difficulty"] }))
                }
                className="w-full bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50"
              >
                <option value="">—</option>
                <option value="Easy">Easy</option>
                <option value="Medium">Medium</option>
                <option value="Hard">Hard</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs text-soft-mute mb-1">Domain</label>
            <select
              value={q.domain ?? ""}
              onChange={(e) => setQ((prev) => ({ ...prev, domain: e.target.value || null }))}
              className="w-full bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50"
            >
              <option value="">—</option>
              {SAT_DOMAINS.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-soft-mute mb-1">Skill</label>
              <input
                type="text"
                value={q.skill ?? ""}
                onChange={(e) => setQ((prev) => ({ ...prev, skill: e.target.value || null }))}
                className="w-full bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50"
              />
            </div>
            <div>
              <label className="block text-xs text-soft-mute mb-1">Concept</label>
              <input
                type="text"
                value={q.concept ?? ""}
                onChange={(e) => setQ((prev) => ({ ...prev, concept: e.target.value || null }))}
                className="w-full bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50"
              />
            </div>
          </div>

          {/* Boolean flags */}
          <div className="flex gap-4">
            {(
              [
                { key: "has_image", label: "Has image" },
                { key: "has_table", label: "Has table" },
                { key: "has_formula", label: "Has formula" },
              ] as const
            ).map(({ key, label }) => (
              <label key={key} className="flex items-center gap-2 cursor-pointer text-xs text-mid-gray">
                <input
                  type="checkbox"
                  checked={q[key]}
                  onChange={(e) => setQ((prev) => ({ ...prev, [key]: e.target.checked }))}
                  className="accent-warm-coral"
                />
                {label}
              </label>
            ))}
          </div>

          {/* Parsing metadata (read-only) */}
          {q.ai_confidence_score !== null && (
            <div className="bg-surface border border-divider rounded-xl p-3 text-xs text-soft-mute space-y-1">
              <p>AI confidence: {Math.round((q.ai_confidence_score ?? 0) * 100)}%</p>
              {q.reviewed_at && <p>Reviewed: {formatDateTime(q.reviewed_at)}</p>}
            </div>
          )}
        </div>
      </div>}
    </div>
  );
}

/* ────────────────────────── parsing-note banner ────────────────────────── */

function ParsingNoteBanner({
  questionId,
  raw,
  onReloaded,
}: {
  questionId: string;
  raw: string;
  onReloaded: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const note = friendlyParsingNote(raw);
  if (!note) return null;

  const tone =
    note.tone === "error"
      ? "bg-status-danger/8 border-status-danger/25 text-status-danger"
      : note.tone === "info"
        ? "bg-blue-50 border-blue-200 text-blue-900"
        : "bg-status-warning/8 border-status-warning/20 text-status-warning";

  async function run(path: string, confirmMsg: string | undefined) {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(path);
    setResult(null);
    try {
      const res = await fetch(`/api/admin/questions/${questionId}${path}`, {
        method: "POST",
      });
      const json = (await res.json()) as { ok: boolean; message: string };
      setResult(json);
      if (json.ok) onReloaded();
    } catch (e) {
      setResult({
        ok: false,
        message: e instanceof Error ? e.message : "Request failed",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className={`${tone} border rounded-xl px-4 py-3 text-sm space-y-2`}
    >
      <p className="font-semibold leading-snug">{note.headline}</p>
      {note.detail && (
        <p className="text-xs opacity-80 leading-snug">{note.detail}</p>
      )}
      {note.action && (
        <p className="text-xs opacity-90 leading-snug">
          <span className="font-medium">What to do: </span>
          {note.action}
        </p>
      )}
      {note.actions && note.actions.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {note.actions.map((a) => {
            const isBusy = busy === a.path;
            return (
              <button
                key={a.path}
                type="button"
                disabled={busy !== null}
                onClick={() => run(a.path, a.confirm)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-charcoal text-white text-xs font-medium hover:opacity-90 disabled:opacity-50"
              >
                {isBusy ? (a.pending ?? `${a.label}…`) : a.label}
              </button>
            );
          })}
        </div>
      )}
      {result && (
        <p
          className={`text-xs leading-snug pt-1 ${
            result.ok ? "text-emerald-700" : "text-status-danger"
          }`}
        >
          {result.message}
        </p>
      )}
      <details className="text-[11px] opacity-60 mt-1">
        <summary className="cursor-pointer">Show technical detail</summary>
        <p className="font-mono break-all mt-1">{raw}</p>
      </details>
    </div>
  );
}
