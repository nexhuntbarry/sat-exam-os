"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { Check, ChevronDown, ChevronLeft, ChevronRight, RefreshCw, Shuffle } from "lucide-react";
import {
  BREAK_MAX_MINUTES,
  DEFAULT_BREAK_MINUTES,
  DIFFICULTIES,
  MAX_QUESTIONS,
  PART_LABEL,
  STAGE_LABEL,
  defaultPart,
  defaultSkillCounts,
  domainTotals,
  minQuestions,
  partStages,
  partsOf,
  skillCap,
  skillTotal,
  suggestedPartMinutes,
  apportion,
  type CustomRules,
  type Mix,
  type PartKey,
  type PartRules,
  type PoolCounts,
  type Subject,
} from "@/lib/custom-test/rules";
import type { Selection } from "@/lib/custom-test/select";
import { domainsOf, otherSkill } from "@/lib/sat-skills";
import { PART_SECTION } from "@/lib/custom-test/rules";

export type BuilderStart =
  | { mode: "new" }
  | { mode: "edit"; testId: string; name: string; rules: CustomRules; selection: Selection; questions: Record<string, Summary>; locked: string | null }
  | { mode: "version"; name: string; rules: CustomRules; familyId: string };

interface Summary {
  id: string;
  domain: string;
  skill: string;
  difficulty: string;
  snippet: string;
  source: string;
}

const input =
  "bg-surface border border-divider text-charcoal rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-warm-coral/50 disabled:opacity-60";
const btn =
  "inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={clsx("relative w-11 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50", on ? "bg-warm-coral" : "bg-light-bg")}
    >
      <span className={clsx("absolute top-1 w-4 h-4 bg-white rounded-full transition-transform", on ? "translate-x-6" : "translate-x-1")} />
    </button>
  );
}

function NumberField({
  value,
  onChange,
  min,
  max,
  label,
  disabled,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <input
      type="number"
      inputMode="numeric"
      aria-label={label}
      min={min}
      max={max}
      value={Number.isFinite(value) ? value : ""}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === "" ? NaN : Math.round(Number(e.target.value)))}
      className={clsx(input, "w-20", className)}
    />
  );
}

const cellSum = (m: Mix | undefined) => (m ? m.Easy + m.Medium + m.Hard : 0);
const DIFF_STYLE: Record<string, string> = {
  Easy: "bg-status-success/10 text-status-success",
  Medium: "bg-warm-amber/15 text-charcoal",
  Hard: "bg-status-error/10 text-status-error",
};

/** Re-spread one domain's questions evenly over its skills that have questions. */
function spreadDomain(key: PartKey, domain: string, total: number, counts: PoolCounts): Record<string, number> {
  const d = domainsOf(PART_SECTION[key]).find((x) => x.name === domain)!;
  const withPool = d.skills.filter((s) => cellSum(counts[domain]?.[s]) > 0);
  const over = (withPool.length ? withPool : d.skills).sort((a, b) => cellSum(counts[domain]?.[b]) - cellSum(counts[domain]?.[a]));
  const even = apportion(Math.max(0, total), over.map((s) => [s, 1] as [string, number]));
  const out: Record<string, number> = Object.fromEntries(d.skills.map((s) => [s, even[s] ?? 0]));
  out[otherSkill(domain)] = 0;
  return out;
}

export default function CustomTestBuilder({ start, fullLengthEnabled }: { start: BuilderStart; fullLengthEnabled: boolean }) {
  const router = useRouter();
  const editing = start.mode === "edit";
  const familyId = start.mode === "version" ? start.familyId : start.mode === "edit" ? start.rules.family_id : null;
  const [step, setStep] = useState(editing ? 3 : 1);
  const [name, setName] = useState(start.mode === "new" ? "" : start.name);
  const [subject, setSubject] = useState<Subject>(start.mode === "new" ? "rw" : start.rules.subject);
  const [parts, setParts] = useState<Partial<Record<PartKey, PartRules>>>(() =>
    start.mode === "new" ? { rw: defaultPart("rw", "rw") } : structuredClone(start.rules.parts),
  );
  const [breakOn, setBreakOn] = useState(start.mode !== "new" && Boolean(start.rules.break && start.rules.break.minutes > 0));
  const [breakMinutes, setBreakMinutes] = useState(start.mode !== "new" && start.rules.break ? start.rules.break.minutes : DEFAULT_BREAK_MINUTES);
  const [allowPause, setAllowPause] = useState(start.mode !== "new" && Boolean(start.rules.break?.allowPause));
  const [minutesTouched, setMinutesTouched] = useState<Partial<Record<PartKey, boolean>>>(start.mode === "new" ? {} : { rw: true, math: true });
  const [openDomain, setOpenDomain] = useState<string | null>(null);
  const [allowReuse, setAllowReuse] = useState(start.mode === "edit" && Boolean(start.rules.allow_reuse));

  const [counts, setCounts] = useState<Record<PartKey, PoolCounts> | null>(null);
  const [excluded, setExcluded] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selection, setSelection] = useState<Selection | null>(start.mode === "edit" ? start.selection : null);
  const [questions, setQuestions] = useState<Record<string, Summary>>(start.mode === "edit" ? start.questions : {});
  const [seed, setSeed] = useState<string | null>(start.mode === "edit" ? start.rules.seed : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Eligible counts per cell (earlier versions left out when making another version).
  useEffect(() => {
    let live = true;
    fetch(`/api/admin/custom-tests/pool${familyId && start.mode === "version" ? `?familyId=${encodeURIComponent(familyId)}` : ""}`, { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json().catch(() => null);
        if (!live) return;
        if (!r.ok) throw new Error(j?.error ?? `Server error (${r.status})`);
        setCounts(j.data.counts);
        setExcluded(j.data.excluded ?? 0);
      })
      .catch((e) => live && setLoadError(e instanceof Error ? e.message : "Could not load the question bank"));
    return () => {
      live = false;
    };
  }, [familyId, start.mode]);

  // A new test starts with the official split over what the bank has.
  useEffect(() => {
    if (!counts || start.mode !== "new") return;
    setParts((ps) => {
      const next = { ...ps };
      for (const k of partsOf(subject)) next[k] = { ...next[k]!, skills: defaultSkillCounts(k, next[k]!.questions, counts[k]) };
      return next;
    });
    // Only when the counts first arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counts]);

  const rules: CustomRules = useMemo(
    () => ({
      v: 1,
      subject,
      order: partsOf(subject),
      break: subject === "both" && breakOn ? { minutes: breakMinutes, allowPause } : null,
      parts: Object.fromEntries(partsOf(subject).map((k) => [k, parts[k]])) as CustomRules["parts"],
      seed: seed ?? "",
      family_id: familyId ?? "",
      version: 1,
    }),
    [subject, breakOn, breakMinutes, allowPause, parts, seed, familyId],
  );

  function changeSubject(s: Subject) {
    setSubject(s);
    setSelection(null);
    setParts(Object.fromEntries(partsOf(s).map((k) => [k, defaultPart(s, k, counts?.[k])])));
    setMinutesTouched({});
  }

  function updatePart(k: PartKey, patch: Partial<PartRules>, opts: { respread?: boolean } = {}) {
    setSelection(null);
    setParts((ps) => {
      const p = { ...ps[k]!, ...patch };
      if (opts.respread) p.skills = defaultSkillCounts(k, p.questions, counts?.[k]);
      if (!minutesTouched[k]) p.minutes = suggestedPartMinutes(subject, k, p);
      return { ...ps, [k]: p };
    });
  }

  function setSkill(k: PartKey, domain: string, skill: string, n: number) {
    setSelection(null);
    setParts((ps) => {
      const p = ps[k]!;
      const skills = { ...p.skills, [domain]: { ...p.skills[domain], [skill]: Math.max(0, n || 0) } };
      return { ...ps, [k]: { ...p, skills } };
    });
  }

  function setDomainTotal(k: PartKey, domain: string, n: number) {
    setSelection(null);
    setParts((ps) => {
      const p = ps[k]!;
      return { ...ps, [k]: { ...p, skills: { ...p.skills, [domain]: spreadDomain(k, domain, n || 0, counts?.[k] ?? {}) } } };
    });
  }

  function setMix(k: PartKey, which: keyof PartRules["mix"], d: keyof Mix, v: number) {
    setSelection(null);
    setParts((ps) => {
      const p = ps[k]!;
      return { ...ps, [k]: { ...p, mix: { ...p.mix, [which]: { ...p.mix[which], [d]: Math.max(0, v || 0) } } } };
    });
  }

  // ---------------------------------------------------------- validation

  const problems = useMemo(() => {
    const out: string[] = [];
    if (!name.trim()) out.push("Give the test a name");
    if (subject === "both" && breakOn && !(breakMinutes >= 1 && breakMinutes <= BREAK_MAX_MINUTES)) out.push(`Break must be 1–${BREAK_MAX_MINUTES} minutes (or turn it off)`);
    for (const k of partsOf(subject)) {
      const p = parts[k];
      if (!p) continue;
      const min = minQuestions(subject, p.adaptive);
      if (!(p.questions >= min && p.questions <= MAX_QUESTIONS[k])) out.push(`${PART_LABEL[k]}: ${min}–${MAX_QUESTIONS[k]} questions${p.adaptive ? " for an adaptive part" : ""}`);
      if (skillTotal(p.skills) !== p.questions) out.push(`${PART_LABEL[k]}: the domain split adds up to ${skillTotal(p.skills)}, not ${p.questions}`);
      for (const [w, label] of p.adaptive ? ([["m1", "Module 1"], ["m2_easy", "Module 2 (easier)"], ["m2_hard", "Module 2 (harder)"]] as const) : ([["all", ""]] as const)) {
        const m = p.mix[w];
        if (m.Easy + m.Medium + m.Hard !== 100) out.push(`${PART_LABEL[k]}${label ? ` ${label}` : ""}: difficulty must add up to 100%`);
      }
      if (p.adaptive && !(p.threshold >= 1 && p.threshold <= 100)) out.push(`${PART_LABEL[k]}: threshold 1–100%`);
      const two = partStages(subject, p).length > 1;
      if (!(p.minutes.m1 >= 1 && p.minutes.m1 <= 180) || (two && !((p.minutes.m2 ?? 0) >= 1 && (p.minutes.m2 ?? 0) <= 180))) out.push(`${PART_LABEL[k]}: module times 1–180 minutes`);
    }
    return out;
  }, [name, subject, breakOn, breakMinutes, parts]);

  // ---------------------------------------------------------- preview

  const preview = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(body.replace ? `replace:${(body.replace as { questionId: string }).questionId}` : "preview");
      setError(null);
      setNote(null);
      try {
        const res = await fetch("/api/admin/custom-tests/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rules, familyId: start.mode !== "new" ? familyId : undefined, allowReuse, ...body }),
        });
        const j = await res.json().catch(() => null);
        if (!res.ok) throw new Error(j?.error ?? `Server error (${res.status})`);
        setSelection(j.data.selection);
        setQuestions((q) => ({ ...q, ...j.data.questions }));
        if (!body.replace) setSeed(j.data.seed);
        setNote(j.data.note ?? null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not build the preview");
      } finally {
        setBusy(null);
      }
    },
    [rules, familyId, allowReuse, start.mode],
  );

  async function save(allowDuplicateName = false) {
    if (!selection) return;
    setBusy("save");
    setError(null);
    try {
      const res = await fetch(editing ? `/api/admin/custom-tests/${start.testId}` : "/api/admin/custom-tests", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          rules,
          seed,
          selection,
          familyId: start.mode === "version" ? familyId : undefined,
          allowReuse: start.mode === "version" ? allowReuse : undefined,
          allowDuplicateName,
        }),
      });
      const j = await res.json().catch(() => null);
      if (res.status === 409 && j?.code === "duplicate_name") {
        if (window.confirm("A test with this name already exists. Save anyway?")) return save(true);
        setBusy(null);
        return;
      }
      if (!res.ok) throw new Error(j?.error ?? `Server error (${res.status})`);
      router.push(`/admin/tests/${j.data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
      setBusy(null);
    }
  }

  // ---------------------------------------------------------- render

  const locked = start.mode === "edit" ? start.locked : null;
  const shapeLocked = editing;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-soft-mute text-sm">
        <a href="/admin/tests" className="hover:text-charcoal transition-colors">Tests</a>
        <span>/</span>
        {editing ? (
          <>
            <a href={`/admin/tests/${start.testId}`} className="hover:text-charcoal transition-colors">{start.name}</a>
            <span>/</span>
            <span className="text-charcoal">Edit questions</span>
          </>
        ) : (
          <>
            <a href="/admin/tests/new" className="hover:text-charcoal transition-colors">Create Test</a>
            <span>/</span>
            <span className="text-charcoal">{start.mode === "version" ? "Make another version" : "Custom test"}</span>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        {["Setup", "Questions", "Preview"].map((label, i) => (
          <div key={label} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => i + 1 < step && setStep(i + 1)}
              className={clsx(
                "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold",
                i + 1 < step ? "bg-warm-amber text-charcoal" : i + 1 === step ? "bg-warm-coral text-white" : "bg-light-bg text-soft-mute",
              )}
            >
              {i + 1 < step ? <Check size={12} /> : i + 1}
            </button>
            <span className={clsx("text-sm", i + 1 === step ? "text-charcoal font-medium" : "text-soft-mute")}>{label}</span>
            {i < 2 && <ChevronRight size={14} className="text-charcoal/20" />}
          </div>
        ))}
      </div>

      {locked && (
        <p role="alert" className="rounded-xl border border-status-warning/30 bg-status-warning/10 p-3 text-sm text-charcoal">
          {locked}
        </p>
      )}
      {loadError && (
        <p role="alert" className="rounded-xl border border-status-error/30 bg-status-error/10 p-3 text-sm text-status-error">
          {loadError}
        </p>
      )}
      {start.mode === "version" && (
        <p className="rounded-xl border border-divider bg-light-bg/60 p-3 text-sm text-mid-gray">
          Another version: same rules, none of the {excluded} questions used in earlier versions.
        </p>
      )}

      <div className="bg-surface border border-divider rounded-2xl p-6 space-y-6">
        {step === 1 && (
          <>
            <div>
              <label className="block text-sm font-medium text-charcoal mb-1" htmlFor="ct-name">Test name</label>
              <input id="ct-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={150} className={clsx(input, "w-full")} placeholder="e.g. Week 6 practice — R&W" />
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium text-charcoal">Subject</p>
              <div role="radiogroup" aria-label="Subject" className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {([
                  ["rw", "Reading and Writing", "One section."],
                  ["math", "Math", "One section."],
                  ["both", "R&W + Math", fullLengthEnabled ? "One sitting, R&W first, one combined result." : "Needs full-length tests to be switched on."],
                ] as const).map(([s, label, hint]) => (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    aria-checked={subject === s}
                    disabled={shapeLocked || (s === "both" && !fullLengthEnabled)}
                    onClick={() => changeSubject(s)}
                    className={clsx(
                      "rounded-xl border px-3.5 py-2.5 text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                      subject === s ? "border-warm-coral bg-warm-coral/5" : "border-divider hover:bg-light-bg",
                    )}
                  >
                    <span className="block text-sm font-medium text-charcoal">{label}</span>
                    <span className="block text-xs text-soft-mute mt-0.5">{hint}</span>
                  </button>
                ))}
              </div>
            </div>

            {subject === "both" && (
              <div className="rounded-2xl border border-divider px-4 py-3 space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-charcoal">Break between R&W and Math</p>
                    <p className="text-xs text-soft-mute">Off: Math starts right after R&W.</p>
                  </div>
                  <Toggle on={breakOn} onChange={setBreakOn} label="Break between sections" />
                </div>
                {breakOn && (
                  <div className="flex flex-wrap items-center gap-4">
                    <label className="flex items-center gap-2 text-sm text-charcoal">
                      Length <NumberField value={breakMinutes} onChange={setBreakMinutes} min={1} max={BREAK_MAX_MINUTES} label="Break minutes" /> min
                    </label>
                    <label className="flex items-center gap-2 text-sm text-charcoal">
                      <Toggle on={allowPause} onChange={setAllowPause} label="Students may leave during the break" /> Students may leave during the break
                    </label>
                  </div>
                )}
              </div>
            )}

            {partsOf(subject).map((k) => {
              const p = parts[k];
              if (!p) return null;
              const stages = partStages(subject, p);
              const two = stages.length > 1;
              const min = minQuestions(subject, p.adaptive);
              return (
                <div key={k} className="rounded-2xl border border-divider px-4 py-4 space-y-3">
                  <h3 className="font-semibold text-charcoal">{PART_LABEL[k]}</h3>
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                    <label className="flex items-center gap-2 text-sm text-charcoal">
                      Questions
                      <NumberField value={p.questions} min={min} max={MAX_QUESTIONS[k]} label={`${PART_LABEL[k]} questions`} onChange={(n) => updatePart(k, { questions: n }, { respread: Number.isFinite(n) })} />
                    </label>
                    <label className="flex items-center gap-2 text-sm text-charcoal">
                      <Toggle on={p.adaptive} disabled={shapeLocked} label={`${PART_LABEL[k]} adaptive`} onChange={(v) => updatePart(k, { adaptive: v })} /> Adaptive
                    </label>
                    {p.adaptive && (
                      <label className="flex items-center gap-2 text-sm text-charcoal">
                        Harder Module 2 at ≥ <NumberField value={p.threshold} min={1} max={100} label="Threshold" onChange={(n) => updatePart(k, { threshold: n })} /> % on Module 1
                      </label>
                    )}
                  </div>
                  <p className="text-xs text-soft-mute">
                    {stages.map((s) => `${STAGE_LABEL[s.key]}: ${s.n}`).join(" · ")}
                    {p.adaptive ? " — each student gets Module 1 and one Module 2." : ""} Minimum {min}, maximum {MAX_QUESTIONS[k]}.
                  </p>
                  <div className="flex flex-wrap items-center gap-4 text-sm text-charcoal">
                    <label className="flex items-center gap-2">
                      {two ? "Module 1 time" : "Time"}
                      <NumberField value={p.minutes.m1} min={1} max={180} label="Module 1 minutes" onChange={(n) => { setMinutesTouched((t) => ({ ...t, [k]: true })); updatePart(k, { minutes: { ...p.minutes, m1: n } }); }} /> min
                    </label>
                    {two && (
                      <label className="flex items-center gap-2">
                        Module 2 time
                        <NumberField value={p.minutes.m2 ?? NaN} min={1} max={180} label="Module 2 minutes" onChange={(n) => { setMinutesTouched((t) => ({ ...t, [k]: true })); updatePart(k, { minutes: { ...p.minutes, m2: n } }); }} /> min
                      </label>
                    )}
                    <button
                      type="button"
                      className="text-xs text-warm-coral-text hover:underline"
                      onClick={() => {
                        setMinutesTouched((t) => ({ ...t, [k]: false }));
                        updatePart(k, { minutes: suggestedPartMinutes(subject, k, p) });
                      }}
                    >
                      Use suggested ({k === "rw" ? "71" : "95"} s per question)
                    </button>
                  </div>
                </div>
              );
            })}

            <div className="flex justify-end">
              <button type="button" onClick={() => setStep(2)} disabled={!name.trim()} className={clsx(btn, "bg-warm-coral hover:bg-warm-coral-dark text-white")}>
                Next <ChevronRight size={16} />
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            {!counts && !loadError && <p className="text-sm text-soft-mute">Loading the question bank…</p>}
            {partsOf(subject).map((k) => {
              const p = parts[k];
              if (!p) return null;
              const totals = domainTotals(p.skills);
              const c = counts?.[k] ?? {};
              const cap = skillCap(p);
              return (
                <div key={k} className="space-y-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="font-semibold text-charcoal">{PART_LABEL[k]} · {p.questions} questions</h3>
                    <button type="button" className="text-xs text-warm-coral-text hover:underline" onClick={() => updatePart(k, {}, { respread: true })}>
                      Reset to the official split
                    </button>
                  </div>
                  <p className="text-xs text-soft-mute">
                    At most {cap} question{cap === 1 ? "" : "s"} per skill for one student
                    {cap > 1 ? " (raised because the test is longer than one question per skill)" : ""}. Numbers in grey: eligible questions in the bank (Easy / Medium / Hard).
                  </p>
                  <div className="divide-y divide-divider rounded-xl border border-divider">
                    {domainsOf(PART_SECTION[k]).map((d) => {
                      const open = openDomain === `${k}:${d.name}`;
                      const skills = [...d.skills, otherSkill(d.name)];
                      const avail = skills.reduce((s, sk) => ({ Easy: s.Easy + (c[d.name]?.[sk]?.Easy ?? 0), Medium: s.Medium + (c[d.name]?.[sk]?.Medium ?? 0), Hard: s.Hard + (c[d.name]?.[sk]?.Hard ?? 0) }), { Easy: 0, Medium: 0, Hard: 0 });
                      return (
                        <div key={d.name}>
                          <div className="flex flex-wrap items-center gap-3 px-3 py-2">
                            <button type="button" aria-expanded={open} onClick={() => setOpenDomain(open ? null : `${k}:${d.name}`)} className="flex flex-1 items-center gap-2 text-left text-sm font-medium text-charcoal min-w-[12rem]">
                              <ChevronDown size={14} className={clsx("transition-transform", open ? "" : "-rotate-90")} />
                              {d.name} <span className="text-xs text-soft-mute font-normal">(official {d.weight}%)</span>
                            </button>
                            <span className="text-xs text-soft-mute tabular-nums">{avail.Easy} / {avail.Medium} / {avail.Hard}</span>
                            <NumberField value={totals[d.name] ?? 0} min={0} max={MAX_QUESTIONS[k]} label={`${d.name} questions`} onChange={(n) => setDomainTotal(k, d.name, n)} />
                          </div>
                          {open && (
                            <div className="bg-light-bg/40 px-3 py-2 space-y-1">
                              {skills.map((s) => (
                                <div key={s} className="flex flex-wrap items-center gap-3 pl-6 text-sm">
                                  <span className="flex-1 min-w-[12rem] text-charcoal">{s}</span>
                                  <span className="text-xs text-soft-mute tabular-nums">
                                    {c[d.name]?.[s]?.Easy ?? 0} / {c[d.name]?.[s]?.Medium ?? 0} / {c[d.name]?.[s]?.Hard ?? 0}
                                  </span>
                                  <NumberField value={p.skills[d.name]?.[s] ?? 0} min={0} max={MAX_QUESTIONS[k]} label={`${s} questions`} onChange={(n) => setSkill(k, d.name, s, n)} />
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <p className={clsx("text-xs", skillTotal(p.skills) === p.questions ? "text-soft-mute" : "text-status-error")}>
                    Split total: {skillTotal(p.skills)} of {p.questions}. A skill set to 0 is left out.
                  </p>

                  <div className="space-y-2">
                    <p className="text-sm font-medium text-charcoal">Difficulty mix</p>
                    {(p.adaptive ? (["m1", "m2_easy", "m2_hard"] as const) : (["all"] as const)).map((w) => (
                      <div key={w} className="flex flex-wrap items-center gap-3 text-sm text-charcoal">
                        <span className="w-40 text-soft-mute">{w === "all" ? "Every module" : STAGE_LABEL[w]}</span>
                        {DIFFICULTIES.map((d) => (
                          <label key={d} className="flex items-center gap-1">
                            {d} <NumberField value={p.mix[w][d]} min={0} max={100} label={`${w} ${d} percent`} onChange={(n) => setMix(k, w, d, n)} className="w-16" />%
                          </label>
                        ))}
                        <span className={clsx("text-xs", p.mix[w].Easy + p.mix[w].Medium + p.mix[w].Hard === 100 ? "text-soft-mute" : "text-status-error")}>
                          = {p.mix[w].Easy + p.mix[w].Medium + p.mix[w].Hard}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

            {start.mode === "version" && (
              <label className="flex items-center gap-2 text-sm text-charcoal">
                <input type="checkbox" checked={allowReuse} onChange={(e) => setAllowReuse(e.target.checked)} />
                If the bank runs short, reuse questions from earlier versions
              </label>
            )}

            {problems.length > 0 && (
              <ul className="text-sm text-status-error list-disc pl-5">
                {problems.map((p) => <li key={p}>{p}</li>)}
              </ul>
            )}
            <div className="flex justify-between">
              <button type="button" onClick={() => setStep(1)} className={clsx(btn, "border border-divider text-charcoal hover:bg-light-bg")}>
                <ChevronLeft size={16} /> Back
              </button>
              <button
                type="button"
                disabled={problems.length > 0 || !counts || busy !== null}
                onClick={async () => {
                  await preview({});
                  setStep(3);
                }}
                className={clsx(btn, "bg-warm-coral hover:bg-warm-coral-dark text-white")}
              >
                {busy === "preview" ? "Building…" : "Preview"} <ChevronRight size={16} />
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            {!selection && <p className="text-sm text-soft-mute">{busy ? "Building the preview…" : "No preview yet."}</p>}
            {selection && selection.shortfalls.length > 0 && (
              <div role="status" className="rounded-xl border border-status-warning/30 bg-status-warning/10 p-3 text-sm text-charcoal space-y-1">
                <p className="font-medium">The bank ran short:</p>
                <ul className="list-disc pl-5">
                  {selection.shortfalls.map((s, i) => <li key={i}>{s.message}</li>)}
                </ul>
              </div>
            )}
            {note && <p className="text-sm text-mid-gray">{note}</p>}
            {selection &&
              partsOf(subject).map((k) => (
                <div key={k} className="space-y-3">
                  <h3 className="font-semibold text-charcoal">{PART_LABEL[k]}</h3>
                  {(selection.parts[k] ?? []).map((st) => (
                    <div key={st.key} className="rounded-xl border border-divider">
                      <div className="flex items-center justify-between px-3 py-2 border-b border-divider">
                        <span className="text-sm font-medium text-charcoal">{(selection.parts[k] ?? []).length > 1 ? STAGE_LABEL[st.key] : "Questions"}</span>
                        <span className="text-xs text-soft-mute">{st.questionIds.length} questions</span>
                      </div>
                      <ol className="divide-y divide-divider">
                        {st.questionIds.map((id, i) => {
                          const q = questions[id];
                          return (
                            <li key={id} className="flex flex-wrap items-start gap-3 px-3 py-2 text-sm">
                              <span className="w-6 text-right text-soft-mute tabular-nums">{i + 1}</span>
                              <span className={clsx("rounded-full px-2 py-0.5 text-xs font-medium", DIFF_STYLE[q?.difficulty ?? ""] ?? "bg-light-bg text-soft-mute")}>{q?.difficulty ?? "…"}</span>
                              <div className="flex-1 min-w-[14rem]">
                                <p className="text-xs text-soft-mute">{q ? `${q.domain} · ${q.skill}` : id.slice(0, 8)}</p>
                                <p className="text-charcoal line-clamp-2">{q?.snippet}</p>
                                <p className="text-xs text-soft-mute">{q?.source}</p>
                              </div>
                              <button
                                type="button"
                                disabled={busy !== null || Boolean(locked)}
                                onClick={() => preview({ seed: Math.random().toString(36).slice(2, 10), replace: { selection, part: k, questionId: id } })}
                                className="text-xs text-warm-coral-text hover:underline disabled:opacity-40"
                              >
                                {busy === `replace:${id}` ? "Replacing…" : "Replace"}
                              </button>
                            </li>
                          );
                        })}
                      </ol>
                    </div>
                  ))}
                </div>
              ))}
            {error && <p role="alert" className="text-sm text-status-error">{error}</p>}
            <div className="flex flex-wrap justify-between gap-2">
              <button type="button" onClick={() => setStep(2)} className={clsx(btn, "border border-divider text-charcoal hover:bg-light-bg")}>
                <ChevronLeft size={16} /> Rules
              </button>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy !== null || problems.length > 0 || Boolean(locked)} onClick={() => preview({})} className={clsx(btn, "border border-divider text-charcoal hover:bg-light-bg")}>
                  {busy === "preview" ? <RefreshCw size={16} className="animate-spin" /> : <Shuffle size={16} />} Regenerate all
                </button>
                <button
                  type="button"
                  disabled={!selection || busy !== null || problems.length > 0 || Boolean(locked)}
                  onClick={() => save()}
                  className={clsx(btn, "bg-warm-coral hover:bg-warm-coral-dark text-white")}
                >
                  {busy === "save" ? "Saving…" : editing ? "Save changes" : "Save as Draft"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
