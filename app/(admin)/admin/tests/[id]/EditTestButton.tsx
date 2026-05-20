"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, X, AlertTriangle } from "lucide-react";

interface ModuleOption {
  id: string;
  module_name: string;
  section: string;
  module_number: number | null;
  total_questions?: number | null;
}

interface TestData {
  id: string;
  test_name: string;
  is_adaptive: boolean;
  module_id: string | null;
  module_2_id: string | null;
  module_1_id: string | null;
  module_2_easy_id: string | null;
  module_2_hard_id: string | null;
  adaptive_threshold: number | null;
  time_limit_minutes: number | null;
  time_limit_minutes_module_2: number | null;
  open_date: string | null;
  due_date: string | null;
  show_answers_after_submission: boolean;
  allow_retake: boolean;
  desmos_enabled: boolean;
}

interface Props {
  test: TestData;
  modules: ModuleOption[];
}

// Helpers ----------------------------------------------------------
function isoToDatetimeLocal(iso: string | null): string {
  if (!iso) return "";
  // Truncate timezone & seconds for <input type="datetime-local"> compat
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function datetimeLocalToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

export default function EditTestButton({ test, modules }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state mirrors the current test row. is_adaptive is intentionally
  // not editable — see the warning banner in the modal body.
  const [testName, setTestName] = useState(test.test_name);
  const [moduleId, setModuleId] = useState(test.module_id ?? "");
  const [module2Id, setModule2Id] = useState(test.module_2_id ?? "");
  const [module1Id, setModule1Id] = useState(test.module_1_id ?? "");
  const [module2EasyId, setModule2EasyId] = useState(test.module_2_easy_id ?? "");
  const [module2HardId, setModule2HardId] = useState(test.module_2_hard_id ?? "");
  const [adaptiveThreshold, setAdaptiveThreshold] = useState<number>(
    test.adaptive_threshold ?? 60,
  );
  const [timeLimitMinutes, setTimeLimitMinutes] = useState<number>(
    test.time_limit_minutes ?? 35,
  );
  const [timeLimitMinutesModule2, setTimeLimitMinutesModule2] = useState<number | "">(
    test.time_limit_minutes_module_2 ?? "",
  );
  const [openDate, setOpenDate] = useState<string>(isoToDatetimeLocal(test.open_date));
  const [dueDate, setDueDate] = useState<string>(isoToDatetimeLocal(test.due_date));
  const [showAnswers, setShowAnswers] = useState<boolean>(
    test.show_answers_after_submission,
  );
  const [allowRetake, setAllowRetake] = useState<boolean>(test.allow_retake);
  const [desmosEnabled, setDesmosEnabled] = useState<boolean>(test.desmos_enabled);

  function reset() {
    setTestName(test.test_name);
    setModuleId(test.module_id ?? "");
    setModule2Id(test.module_2_id ?? "");
    setModule1Id(test.module_1_id ?? "");
    setModule2EasyId(test.module_2_easy_id ?? "");
    setModule2HardId(test.module_2_hard_id ?? "");
    setAdaptiveThreshold(test.adaptive_threshold ?? 60);
    setTimeLimitMinutes(test.time_limit_minutes ?? 35);
    setTimeLimitMinutesModule2(test.time_limit_minutes_module_2 ?? "");
    setOpenDate(isoToDatetimeLocal(test.open_date));
    setDueDate(isoToDatetimeLocal(test.due_date));
    setShowAnswers(test.show_answers_after_submission);
    setAllowRetake(test.allow_retake);
    setDesmosEnabled(test.desmos_enabled);
    setError(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        testName: testName.trim(),
        timeLimitMinutes,
        timeLimitMinutesModule2: timeLimitMinutesModule2 === "" ? null : Number(timeLimitMinutesModule2),
        openDate: datetimeLocalToIso(openDate),
        dueDate: datetimeLocalToIso(dueDate),
        showAnswersAfterSubmission: showAnswers,
        allowRetake,
        desmosEnabled,
      };
      if (test.is_adaptive) {
        body.module1Id = module1Id || null;
        body.module2EasyId = module2EasyId || null;
        body.module2HardId = module2HardId || null;
        body.adaptiveThreshold = adaptiveThreshold;
      } else {
        body.moduleId = moduleId || null;
        body.module2Id = module2Id || null;
      }
      const res = await fetch(`/api/admin/tests/${test.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  // Module options filtered to whatever section the current Module 1
  // belongs to, mirroring the create-test UX. R&W tests only swap to
  // other R&W modules; Math only to Math.
  const currentSection =
    modules.find(
      (m) => m.id === (test.is_adaptive ? test.module_1_id : test.module_id),
    )?.section ?? null;
  const eligible = currentSection
    ? modules.filter((m) => m.section === currentSection)
    : modules;

  return (
    <>
      <button
        onClick={() => {
          reset();
          setOpen(true);
        }}
        className="flex items-center gap-2 px-3 py-2 rounded-xl bg-light-bg hover:bg-divider text-charcoal font-semibold text-sm transition-colors"
        title="Edit test details"
      >
        <Pencil size={13} />
        Edit
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm px-4 py-6">
          <div className="bg-surface border border-divider rounded-2xl w-full max-w-2xl shadow-2xl max-h-[92vh] overflow-y-auto">
            <div className="px-5 py-4 border-b border-divider flex items-center justify-between sticky top-0 bg-surface z-10">
              <div className="flex items-center gap-2">
                <Pencil size={16} className="text-warm-coral" />
                <h3 className="font-bold text-charcoal text-base">Edit test</h3>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="text-soft-mute hover:text-charcoal"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-5 space-y-5">
              {/* Adaptive lock warning */}
              <div className="flex items-start gap-2 rounded-xl border border-warm-amber/30 bg-warm-amber/10 px-3 py-2.5 text-xs text-charcoal">
                <AlertTriangle size={14} className="text-warm-amber shrink-0 mt-0.5" />
                <p>
                  Adaptive vs non-adaptive mode is locked after creation. Changing
                  it would invalidate every existing submission&apos;s module
                  routing. If you need the other mode,{" "}
                  <strong>create a new test</strong> instead.
                </p>
              </div>

              <Field label="Test name">
                <input
                  value={testName}
                  onChange={(e) => setTestName(e.target.value)}
                  className="input"
                  autoFocus
                />
              </Field>

              <div className="rounded-xl border border-divider p-3 space-y-3">
                <p className="text-charcoal text-sm font-semibold">
                  Modules{" "}
                  <span className="text-soft-mute font-normal text-xs">
                    ({test.is_adaptive ? "Adaptive" : "Two-module"} mode)
                  </span>
                </p>
                {test.is_adaptive ? (
                  <>
                    <Field label="Module 1">
                      <select
                        value={module1Id}
                        onChange={(e) => setModule1Id(e.target.value)}
                        className="input"
                      >
                        <option value="">— None —</option>
                        {eligible.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.module_name} · {m.section}
                            {m.module_number ? ` M${m.module_number}` : ""}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Module 2 · Easy">
                        <select
                          value={module2EasyId}
                          onChange={(e) => setModule2EasyId(e.target.value)}
                          className="input"
                        >
                          <option value="">— None —</option>
                          {eligible.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.module_name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Module 2 · Hard">
                        <select
                          value={module2HardId}
                          onChange={(e) => setModule2HardId(e.target.value)}
                          className="input"
                        >
                          <option value="">— None —</option>
                          {eligible.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.module_name}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </div>
                    <Field label="Adaptive threshold (% correct on Module 1 → hard track)">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={adaptiveThreshold}
                        onChange={(e) =>
                          setAdaptiveThreshold(
                            Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                          )
                        }
                        className="input"
                      />
                    </Field>
                  </>
                ) : (
                  <>
                    <Field label="Module 1">
                      <select
                        value={moduleId}
                        onChange={(e) => setModuleId(e.target.value)}
                        className="input"
                      >
                        <option value="">— None —</option>
                        {eligible.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.module_name} · {m.section}
                            {m.module_number ? ` M${m.module_number}` : ""}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Module 2">
                      <select
                        value={module2Id}
                        onChange={(e) => setModule2Id(e.target.value)}
                        className="input"
                      >
                        <option value="">— None —</option>
                        {eligible
                          .filter((m) => m.id !== moduleId)
                          .map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.module_name} · {m.section}
                              {m.module_number ? ` M${m.module_number}` : ""}
                            </option>
                          ))}
                      </select>
                    </Field>
                  </>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Module 1 time limit (minutes)">
                  <input
                    type="number"
                    min={1}
                    value={timeLimitMinutes}
                    onChange={(e) =>
                      setTimeLimitMinutes(Math.max(1, Number(e.target.value) || 1))
                    }
                    className="input"
                  />
                </Field>
                <Field label="Module 2 time limit (optional)">
                  <input
                    type="number"
                    min={1}
                    placeholder="Falls back to Module 1's"
                    value={timeLimitMinutesModule2}
                    onChange={(e) =>
                      setTimeLimitMinutesModule2(
                        e.target.value === ""
                          ? ""
                          : Math.max(1, Number(e.target.value) || 1),
                      )
                    }
                    className="input"
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Open date / time">
                  <input
                    type="datetime-local"
                    value={openDate}
                    onChange={(e) => setOpenDate(e.target.value)}
                    className="input"
                  />
                </Field>
                <Field label="Due date / time">
                  <input
                    type="datetime-local"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="input"
                  />
                </Field>
              </div>

              <div className="grid grid-cols-1 gap-2">
                <Toggle
                  label="Show answers after submission"
                  hint="Students see the answer key + their wrong answers after submitting."
                  on={showAnswers}
                  onChange={setShowAnswers}
                />
                <Toggle
                  label="Allow retake"
                  hint="Students can request another attempt without admin grant."
                  on={allowRetake}
                  onChange={setAllowRetake}
                />
                <Toggle
                  label="Desmos calculator"
                  hint="Show the in-app Desmos panel during the test (Math sections)."
                  on={desmosEnabled}
                  onChange={setDesmosEnabled}
                />
              </div>

              {error && <p className="text-status-error text-sm">{error}</p>}
            </div>

            <div className="px-5 py-3 border-t border-divider flex justify-end gap-2 sticky bottom-0 bg-surface">
              <button
                onClick={() => setOpen(false)}
                disabled={busy}
                className="px-3 py-1.5 rounded-lg border border-divider text-mid-gray text-sm hover:text-charcoal"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={busy || !testName.trim()}
                className="px-4 py-1.5 rounded-lg bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm disabled:opacity-40"
              >
                {busy ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>
          <style jsx global>{`
            .input {
              width: 100%;
              padding: 0.5rem 0.75rem;
              border-radius: 0.625rem;
              background: var(--color-bg);
              border: 1px solid var(--color-divider);
              color: var(--color-charcoal);
              outline: none;
              font-size: 0.875rem;
            }
            .input:focus {
              border-color: rgb(240 82 61 / 0.6);
            }
          `}</style>
        </div>
      )}
    </>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-mid-gray text-xs font-medium block">{label}</label>
      {children}
    </div>
  );
}

function Toggle({
  label,
  hint,
  on,
  onChange,
}: {
  label: string;
  hint?: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <div className="flex-1">
        <p className="text-charcoal text-sm font-medium">{label}</p>
        {hint && <p className="text-soft-mute text-xs">{hint}</p>}
      </div>
      <button
        type="button"
        onClick={() => onChange(!on)}
        aria-pressed={on}
        className={
          "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-0 p-0 transition-colors focus:outline-none focus:ring-2 focus:ring-warm-coral/40 " +
          (on ? "bg-warm-coral" : "bg-divider")
        }
      >
        <span
          aria-hidden
          className={
            "inline-block h-5 w-5 transform rounded-full bg-white shadow ring-1 ring-black/5 transition-transform " +
            (on ? "translate-x-[22px]" : "translate-x-[2px]")
          }
        />
      </button>
    </div>
  );
}
