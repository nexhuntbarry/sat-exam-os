"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, ChevronLeft, Check, Calculator, Image as ImageIcon } from "lucide-react";
import { clsx } from "clsx";

interface Module {
  id: string;
  module_name: string;
  section: string;
  module_number: number | null;
  parsing_status: string;
  total_questions: number;
}

interface User {
  id: string;
  display_name: string;
  email: string;
}

interface ClassGroup {
  id: string;
  name: string;
  campus: string | null;
  grade: string | null;
}

interface Props {
  modules: Module[];
  teachers: User[];
  students: User[];
  classGroups: ClassGroup[];
}

// Per-module SAT timing: each section delivers two modules with its own
// timer. Math gets 35 min/module, Reading & Writing 32 min/module.
const DEFAULT_TIME_LIMITS: Record<string, number> = {
  Math: 35,
  "Reading & Writing": 32,
};

export default function CreateTestClient({ modules, teachers, students, classGroups }: Props) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Step 1: Module selection. Non-adaptive tests serve two modules in
  // sequence (Module 1 = selectedModuleId, Module 2 = module2Id).
  const [selectedModuleId, setSelectedModuleId] = useState("");
  const [module2Id, setModule2Id] = useState("");

  // Adaptive mode (#1) — when on, the test serves Module 1 then routes
  // students to Module 2 (easy or hard) based on Module 1 score.
  const [isAdaptive, setIsAdaptive] = useState(false);
  const [module1Id, setModule1Id] = useState("");
  const [module2EasyId, setModule2EasyId] = useState("");
  const [module2HardId, setModule2HardId] = useState("");
  const [adaptiveThreshold, setAdaptiveThreshold] = useState<number>(60);

  // Step 2: Config
  const [testName, setTestName] = useState("");
  const [timeLimitMinutes, setTimeLimitMinutes] = useState<number>(35);
  const [timeLimitMinutesModule2, setTimeLimitMinutesModule2] = useState<number | "">("");
  const [openDate, setOpenDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [showAnswers, setShowAnswers] = useState(false);
  const [allowRetake, setAllowRetake] = useState(false);

  // Desmos calculator toggle. Default ON: the real SAT allows Desmos
  // on every Math section, so admins were forgetting to flip the
  // switch and students reported missing-calculator on Math tests.
  // R&W tests ignore the setting anyway (the take page gates on
  // section), so defaulting true here is safe for non-Math tests too.
  const [desmosEnabled, setDesmosEnabled] = useState(true);

  // Step 3: Assignment
  const [selectedTeacherIds, setSelectedTeacherIds] = useState<string[]>([]);
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([]);
  const [selectedClassGroupIds, setSelectedClassGroupIds] = useState<string[]>([]);

  const selectedModule = modules.find((m) => m.id === selectedModuleId);

  // Section gate for math aids — for adaptive tests we look at Module 1
  // since both Module 2 tracks share its section.
  const activeModuleForSection = isAdaptive
    ? modules.find((m) => m.id === module1Id)
    : selectedModule;
  const isMathTest = activeModuleForSection?.section === "Math";

  function handleModuleSelect(mod: Module) {
    setSelectedModuleId(mod.id);
    setTimeLimitMinutes(DEFAULT_TIME_LIMITS[mod.section] ?? 64);
    if (!testName) setTestName(`${mod.module_name} Test`);
  }

  function toggleItem<T>(arr: T[], item: T, setter: (v: T[]) => void) {
    setter(arr.includes(item) ? arr.filter((i) => i !== item) : [...arr, item]);
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/admin/tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          testName,
          moduleId: isAdaptive ? undefined : selectedModuleId,
          module2Id: isAdaptive ? undefined : module2Id || undefined,
          timeLimitMinutes,
          openDate: openDate || undefined,
          dueDate: dueDate || undefined,
          showAnswersAfterSubmission: showAnswers,
          allowRetake,
          teacherIds: selectedTeacherIds,
          studentIds: selectedStudentIds,
          classGroupIds: selectedClassGroupIds,
          isAdaptive,
          module1Id: isAdaptive ? module1Id : undefined,
          module2EasyId: isAdaptive ? module2EasyId || undefined : undefined,
          module2HardId: isAdaptive ? module2HardId || undefined : undefined,
          adaptiveThreshold: isAdaptive ? adaptiveThreshold : undefined,
          desmosEnabled: isMathTest ? desmosEnabled : false,
          timeLimitMinutesModule2:
            (isAdaptive || (!isAdaptive && module2Id)) && typeof timeLimitMinutesModule2 === "number"
              ? timeLimitMinutesModule2
              : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to create test");
      router.push(`/admin/tests/${json.data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
      setSubmitting(false);
    }
  }

  const eligibleModules = modules.filter(
    (m) => m.parsing_status === "approved" || m.total_questions >= 5
  );

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-soft-mute text-sm">
        <a href="/admin/tests" className="hover:text-charcoal transition-colors">Tests</a>
        <span>/</span>
        <span className="text-charcoal">Create Test</span>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2">
        {[1, 2, 3].map((s) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={clsx(
                "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors",
                s < step
                  ? "bg-warm-amber text-charcoal"
                  : s === step
                  ? "bg-warm-coral text-white"
                  : "bg-light-bg text-soft-mute"
              )}
            >
              {s < step ? <Check size={12} /> : s}
            </div>
            <span className={clsx("text-sm", s === step ? "text-charcoal font-medium" : "text-soft-mute")}>
              {s === 1 ? "Select Module" : s === 2 ? "Configure" : "Assign"}
            </span>
            {s < 3 && <ChevronRight size={14} className="text-charcoal/20" />}
          </div>
        ))}
      </div>

      <div className="bg-surface border border-divider rounded-2xl p-6">
        {/* Step 1: Module selection */}
        {step === 1 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-charcoal">Select Module</h2>
            <p className="text-soft-mute text-sm">
              Only modules with approved status or ≥5 approved questions are shown.
            </p>

            {/* Adaptive toggle */}
            <div className="flex items-center justify-between rounded-2xl border border-warm-coral/15 bg-warm-coral/5 px-4 py-3">
              <div>
                <p className="text-charcoal text-sm font-medium">Adaptive (2-module SAT)</p>
                <p className="text-soft-mute text-xs mt-0.5 leading-relaxed">
                  When on, the test serves Module 1 then routes the student to Module 2
                  (easy or hard) based on the Module 1 score, mirroring real SAT.
                </p>
              </div>
              <button
                onClick={() => setIsAdaptive((v) => !v)}
                className={clsx(
                  "relative w-11 h-6 rounded-full transition-colors shrink-0",
                  isAdaptive ? "bg-warm-coral" : "bg-light-bg",
                )}
              >
                <span
                  className={clsx(
                    "absolute top-1 w-4 h-4 bg-white rounded-full transition-transform",
                    isAdaptive ? "translate-x-6" : "translate-x-1",
                  )}
                />
              </button>
            </div>

            {!isAdaptive ? (
              eligibleModules.length === 0 ? (
                <p className="text-soft-mute text-sm py-8 text-center">
                  No eligible modules. Approve at least one module first.
                </p>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-charcoal mb-1">
                      Module 1 <span className="text-status-error">*</span>
                    </label>
                    <select
                      value={selectedModuleId}
                      onChange={(e) => {
                        const m = eligibleModules.find((mm) => mm.id === e.target.value);
                        if (m) handleModuleSelect(m);
                        else setSelectedModuleId("");
                      }}
                      className="w-full bg-surface border border-divider text-charcoal rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-warm-coral/50"
                    >
                      <option value="">Select Module 1…</option>
                      {eligibleModules.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.module_name} · {m.section}{m.module_number ? ` M${m.module_number}` : ""} · {m.total_questions}q
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-charcoal mb-1">
                      Module 2 <span className="text-status-error">*</span>
                    </label>
                    <select
                      value={module2Id}
                      onChange={(e) => setModule2Id(e.target.value)}
                      className="w-full bg-surface border border-divider text-charcoal rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-warm-coral/50"
                    >
                      <option value="">Select Module 2…</option>
                      {eligibleModules
                        .filter((m) => m.id !== selectedModuleId)
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.module_name} · {m.section}{m.module_number ? ` M${m.module_number}` : ""} · {m.total_questions}q
                          </option>
                        ))}
                    </select>
                  </div>
                  <p className="text-soft-mute text-xs">
                    Students take Module 1 then Module 2 in sequence (no adaptive routing).
                    Each module has its own timer.
                  </p>
                </div>
              )
            ) : (
              <div className="space-y-3">
                {/* Module 1 picker */}
                <div>
                  <label className="block text-sm font-medium text-charcoal mb-1">
                    Module 1 <span className="text-status-error">*</span>
                  </label>
                  <select
                    value={module1Id}
                    onChange={(e) => {
                      setModule1Id(e.target.value);
                      const m = eligibleModules.find((mm) => mm.id === e.target.value);
                      if (m && !testName) setTestName(`${m.module_name} (Adaptive)`);
                      if (m) setTimeLimitMinutes(DEFAULT_TIME_LIMITS[m.section] ?? 64);
                    }}
                    className="w-full bg-surface border border-divider text-charcoal rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-warm-coral/50"
                  >
                    <option value="">Select Module 1…</option>
                    {eligibleModules.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.module_name} · {m.section}{m.module_number ? ` M${m.module_number}` : ""}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-charcoal mb-1">
                      Module 2 — Easy track
                    </label>
                    <select
                      value={module2EasyId}
                      onChange={(e) => setModule2EasyId(e.target.value)}
                      className="w-full bg-surface border border-divider text-charcoal rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-warm-coral/50"
                    >
                      <option value="">— None —</option>
                      {eligibleModules.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.module_name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-charcoal mb-1">
                      Module 2 — Hard track
                    </label>
                    <select
                      value={module2HardId}
                      onChange={(e) => setModule2HardId(e.target.value)}
                      className="w-full bg-surface border border-divider text-charcoal rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-warm-coral/50"
                    >
                      <option value="">— None —</option>
                      {eligibleModules.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.module_name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-charcoal mb-1">
                    Adaptive threshold (Module 1 score % → hard track)
                  </label>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={adaptiveThreshold}
                      onChange={(e) => setAdaptiveThreshold(Number(e.target.value))}
                      className="flex-1 accent-warm-coral"
                    />
                    <span className="font-mono text-warm-coral w-12 text-right">
                      {adaptiveThreshold}%
                    </span>
                  </div>
                  <p className="text-soft-mute text-xs mt-1">
                    Score this % or higher on Module 1 → hard Module 2. Below → easy Module 2.
                  </p>
                </div>

                <p className="text-mid-gray text-xs italic">
                  Note: take-flow + auto-routing land in the next batch — for now this just
                  records which modules a test will use.
                </p>
              </div>
            )}

            <div className="flex justify-end pt-2">
              <button
                disabled={
                  isAdaptive
                    ? !module1Id || (!module2EasyId && !module2HardId)
                    : !selectedModuleId || !module2Id || selectedModuleId === module2Id
                }
                onClick={() => setStep(2)}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Config */}
        {step === 2 && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold text-charcoal">Configure Test</h2>

            <div className="space-y-1">
              <label className="text-mid-gray text-sm font-medium">Test Name *</label>
              <input
                type="text"
                value={testName}
                onChange={(e) => setTestName(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl bg-surface border border-divider text-charcoal placeholder-soft-mute focus:outline-none focus:border-warm-coral/60 transition-colors"
                placeholder="e.g. Spring Mock SAT — Math M1"
              />
            </div>

            <div className="space-y-1">
              <label className="text-mid-gray text-sm font-medium">
                {isAdaptive || module2Id ? "Module 1 time limit (minutes)" : "Time Limit (minutes)"}
              </label>
              <input
                type="number"
                value={timeLimitMinutes}
                onChange={(e) => setTimeLimitMinutes(parseInt(e.target.value) || 35)}
                min={1}
                max={180}
                className="w-32 px-4 py-2.5 rounded-xl bg-light-bg border border-divider text-charcoal focus:outline-none focus:border-warm-coral/60 transition-colors"
              />
              <p className="text-soft-mute text-xs">
                Per module. SAT standard: 35 min (Math), 32 min (Reading &amp; Writing). Each module times independently.
              </p>
            </div>

            {(isAdaptive || module2Id) && (
              <div className="space-y-1">
                <label className="text-mid-gray text-sm font-medium">
                  Module 2 time limit (minutes)
                </label>
                <input
                  type="number"
                  value={timeLimitMinutesModule2}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "") setTimeLimitMinutesModule2("");
                    else setTimeLimitMinutesModule2(parseInt(v) || 35);
                  }}
                  min={1}
                  max={180}
                  placeholder={`Same as Module 1 (${timeLimitMinutes})`}
                  className="w-48 px-4 py-2.5 rounded-xl bg-light-bg border border-divider text-charcoal placeholder-soft-mute focus:outline-none focus:border-warm-coral/60 transition-colors"
                />
                <p className="text-soft-mute text-xs">
                  Leave blank to reuse Module 1&rsquo;s limit. Adaptive tests apply this to both Module 2 easy and hard tracks.
                </p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-mid-gray text-sm font-medium">Open Date</label>
                <input
                  type="datetime-local"
                  value={openDate}
                  onChange={(e) => setOpenDate(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl bg-light-bg border border-divider text-charcoal focus:outline-none focus:border-warm-coral/60 transition-colors"
                />
              </div>
              <div className="space-y-1">
                <label className="text-mid-gray text-sm font-medium">Due Date</label>
                <input
                  type="datetime-local"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl bg-light-bg border border-divider text-charcoal focus:outline-none focus:border-warm-coral/60 transition-colors"
                />
              </div>
            </div>

            <div className="space-y-3">
              <label className="flex items-center justify-between p-3 rounded-xl bg-surface border border-divider cursor-pointer hover:bg-light-bg transition-colors">
                <div>
                  <div className="text-charcoal text-sm font-medium">Show answers after submission</div>
                  <div className="text-soft-mute text-xs">Students can review correct answers</div>
                </div>
                <div
                  onClick={() => setShowAnswers(!showAnswers)}
                  className={clsx(
                    "w-10 h-6 rounded-full transition-colors relative shrink-0",
                    showAnswers ? "bg-warm-coral" : "bg-light-bg"
                  )}
                >
                  <span className={clsx(
                    "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                    showAnswers ? "translate-x-5" : "translate-x-1"
                  )} />
                </div>
              </label>

              <label className="flex items-center justify-between p-3 rounded-xl bg-surface border border-divider cursor-pointer hover:bg-light-bg transition-colors">
                <div>
                  <div className="text-charcoal text-sm font-medium">Allow retake</div>
                  <div className="text-soft-mute text-xs">Students can take this test multiple times</div>
                </div>
                <div
                  onClick={() => setAllowRetake(!allowRetake)}
                  className={clsx(
                    "w-10 h-6 rounded-full transition-colors relative shrink-0",
                    allowRetake ? "bg-warm-coral" : "bg-light-bg"
                  )}
                >
                  <span className={clsx(
                    "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                    allowRetake ? "translate-x-5" : "translate-x-1"
                  )} />
                </div>
              </label>
            </div>

            {isMathTest && (
              <div className="space-y-3 pt-2 border-t border-divider">
                <div className="text-charcoal text-sm font-semibold flex items-center gap-2">
                  <Calculator size={14} className="text-warm-coral" />
                  Math aids
                </div>

                <label className="flex items-center justify-between p-3 rounded-xl bg-surface border border-divider cursor-pointer hover:bg-light-bg transition-colors">
                  <div>
                    <div className="text-charcoal text-sm font-medium">Desmos calculator</div>
                    <div className="text-soft-mute text-xs">Side panel iframe — same as digital SAT</div>
                  </div>
                  <div
                    onClick={() => setDesmosEnabled(!desmosEnabled)}
                    className={clsx(
                      "w-10 h-6 rounded-full transition-colors relative shrink-0",
                      desmosEnabled ? "bg-warm-coral" : "bg-light-bg",
                    )}
                  >
                    <span
                      className={clsx(
                        "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                        desmosEnabled ? "translate-x-5" : "translate-x-1",
                      )}
                    />
                  </div>
                </label>

                <div className="p-3 rounded-xl bg-surface border border-divider space-y-1.5">
                  <div className="text-charcoal text-sm font-medium flex items-center gap-1.5">
                    <ImageIcon size={13} className="text-warm-coral" />
                    Formula reference sheet
                  </div>
                  <p className="text-soft-mute text-xs leading-relaxed">
                    Now a global setting — admin uploads once and every Math test uses
                    the same sheet.{" "}
                    <a href="/admin/settings" className="text-warm-coral hover:underline">
                      Manage in Platform settings →
                    </a>
                  </p>
                </div>
              </div>
            )}

            <div className="flex justify-between pt-2">
              <button onClick={() => setStep(1)} className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-divider text-mid-gray hover:text-charcoal hover:border-divider transition-colors text-sm">
                <ChevronLeft size={16} /> Back
              </button>
              <button
                disabled={!testName.trim()}
                onClick={() => setStep(3)}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Assignment */}
        {step === 3 && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold text-charcoal">Assign Test</h2>

            {/* Teachers */}
            <div className="space-y-2">
              <label className="text-mid-gray text-sm font-medium">Teachers</label>
              <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                {teachers.length === 0 ? (
                  <p className="text-soft-mute text-xs">No teachers available.</p>
                ) : teachers.map((t) => (
                  <label key={t.id} className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-light-bg cursor-pointer transition-colors">
                    <input
                      type="checkbox"
                      checked={selectedTeacherIds.includes(t.id)}
                      onChange={() => toggleItem(selectedTeacherIds, t.id, setSelectedTeacherIds)}
                      className="w-4 h-4 rounded accent-warm-coral"
                    />
                    <div>
                      <div className="text-charcoal text-sm">{t.display_name}</div>
                      <div className="text-soft-mute text-xs">{t.email}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Class Groups */}
            <div className="space-y-2">
              <label className="text-mid-gray text-sm font-medium">Class Groups</label>
              <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1">
                {classGroups.length === 0 ? (
                  <p className="text-soft-mute text-xs">No class groups.</p>
                ) : classGroups.map((cg) => (
                  <label key={cg.id} className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-light-bg cursor-pointer transition-colors">
                    <input
                      type="checkbox"
                      checked={selectedClassGroupIds.includes(cg.id)}
                      onChange={() => toggleItem(selectedClassGroupIds, cg.id, setSelectedClassGroupIds)}
                      className="w-4 h-4 rounded accent-warm-coral"
                    />
                    <div>
                      <div className="text-charcoal text-sm">{cg.name}</div>
                      {(cg.campus || cg.grade) && (
                        <div className="text-soft-mute text-xs">{[cg.campus, cg.grade].filter(Boolean).join(" · ")}</div>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Individual students */}
            <div className="space-y-2">
              <label className="text-mid-gray text-sm font-medium">Individual Students</label>
              <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                {students.length === 0 ? (
                  <p className="text-soft-mute text-xs">No approved students.</p>
                ) : students.map((s) => (
                  <label key={s.id} className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-light-bg cursor-pointer transition-colors">
                    <input
                      type="checkbox"
                      checked={selectedStudentIds.includes(s.id)}
                      onChange={() => toggleItem(selectedStudentIds, s.id, setSelectedStudentIds)}
                      className="w-4 h-4 rounded accent-warm-coral"
                    />
                    <div>
                      <div className="text-charcoal text-sm">{s.display_name}</div>
                      <div className="text-soft-mute text-xs">{s.email}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Preview */}
            <div className="p-3 rounded-xl bg-surface border border-divider text-mid-gray text-sm">
              {selectedClassGroupIds.length > 0 || selectedStudentIds.length > 0 ? (
                <span>
                  Assigning to {selectedClassGroupIds.length > 0 ? `${selectedClassGroupIds.length} class group(s)` : ""}
                  {selectedClassGroupIds.length > 0 && selectedStudentIds.length > 0 ? " + " : ""}
                  {selectedStudentIds.length > 0 ? `${selectedStudentIds.length} student(s) directly` : ""}
                </span>
              ) : (
                <span className="text-soft-mute">No students assigned yet (can assign later)</span>
              )}
            </div>

            {error && <p className="text-status-error text-sm">{error}</p>}

            <div className="flex justify-between pt-2">
              <button onClick={() => setStep(2)} className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-divider text-mid-gray hover:text-charcoal hover:border-divider transition-colors text-sm">
                <ChevronLeft size={16} /> Back
              </button>
              <button
                disabled={submitting}
                onClick={handleSubmit}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-warm-amber hover:bg-warm-amber/90 text-charcoal font-semibold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting ? "Creating..." : <><Check size={16} /> Create Test</>}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
