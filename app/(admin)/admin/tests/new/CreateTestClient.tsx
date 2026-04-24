"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, ChevronLeft, Check } from "lucide-react";
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

const DEFAULT_TIME_LIMITS: Record<string, number> = {
  Math: 64,
  "Reading & Writing": 32,
};

export default function CreateTestClient({ modules, teachers, students, classGroups }: Props) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Step 1: Module selection
  const [selectedModuleId, setSelectedModuleId] = useState("");

  // Step 2: Config
  const [testName, setTestName] = useState("");
  const [timeLimitMinutes, setTimeLimitMinutes] = useState<number>(64);
  const [openDate, setOpenDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [showAnswers, setShowAnswers] = useState(false);
  const [allowRetake, setAllowRetake] = useState(false);

  // Step 3: Assignment
  const [selectedTeacherIds, setSelectedTeacherIds] = useState<string[]>([]);
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([]);
  const [selectedClassGroupIds, setSelectedClassGroupIds] = useState<string[]>([]);

  const selectedModule = modules.find((m) => m.id === selectedModuleId);

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
          moduleId: selectedModuleId,
          timeLimitMinutes,
          openDate: openDate || undefined,
          dueDate: dueDate || undefined,
          showAnswersAfterSubmission: showAnswers,
          allowRetake,
          teacherIds: selectedTeacherIds,
          studentIds: selectedStudentIds,
          classGroupIds: selectedClassGroupIds,
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
      <div className="flex items-center gap-2 text-soft-gray/50 text-sm">
        <a href="/admin/tests" className="hover:text-soft-gray transition-colors">Tests</a>
        <span>/</span>
        <span className="text-white">Create Test</span>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2">
        {[1, 2, 3].map((s) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={clsx(
                "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors",
                s < step
                  ? "bg-lime-green text-deep-navy"
                  : s === step
                  ? "bg-electric-blue text-white"
                  : "bg-white/10 text-soft-gray/40"
              )}
            >
              {s < step ? <Check size={12} /> : s}
            </div>
            <span className={clsx("text-sm", s === step ? "text-white font-medium" : "text-soft-gray/40")}>
              {s === 1 ? "Select Module" : s === 2 ? "Configure" : "Assign"}
            </span>
            {s < 3 && <ChevronRight size={14} className="text-soft-gray/20" />}
          </div>
        ))}
      </div>

      <div className="bg-white/3 border border-white/8 rounded-2xl p-6">
        {/* Step 1: Module selection */}
        {step === 1 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-white">Select Module</h2>
            <p className="text-soft-gray/50 text-sm">
              Only modules with approved status or ≥5 approved questions are shown.
            </p>
            {eligibleModules.length === 0 ? (
              <p className="text-soft-gray/40 text-sm py-8 text-center">
                No eligible modules. Approve at least one module first.
              </p>
            ) : (
              <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                {eligibleModules.map((mod) => (
                  <button
                    key={mod.id}
                    onClick={() => handleModuleSelect(mod)}
                    className={clsx(
                      "w-full flex items-center justify-between p-4 rounded-xl border text-left transition-all",
                      selectedModuleId === mod.id
                        ? "border-electric-blue bg-electric-blue/10"
                        : "border-white/8 bg-white/2 hover:border-white/16 hover:bg-white/4"
                    )}
                  >
                    <div>
                      <div className="text-white font-medium">{mod.module_name}</div>
                      <div className="text-soft-gray/50 text-xs mt-0.5">
                        {mod.section}{mod.module_number ? ` · M${mod.module_number}` : ""} · {mod.total_questions} questions
                      </div>
                    </div>
                    {selectedModuleId === mod.id && (
                      <Check size={16} className="text-electric-blue shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            )}
            <div className="flex justify-end pt-2">
              <button
                disabled={!selectedModuleId}
                onClick={() => setStep(2)}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-electric-blue hover:bg-electric-blue/90 text-white font-semibold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Config */}
        {step === 2 && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold text-white">Configure Test</h2>

            <div className="space-y-1">
              <label className="text-soft-gray/70 text-sm font-medium">Test Name *</label>
              <input
                type="text"
                value={testName}
                onChange={(e) => setTestName(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white placeholder-soft-gray/30 focus:outline-none focus:border-electric-blue/60 transition-colors"
                placeholder="e.g. Spring Mock SAT — Math M1"
              />
            </div>

            <div className="space-y-1">
              <label className="text-soft-gray/70 text-sm font-medium">Time Limit (minutes)</label>
              <input
                type="number"
                value={timeLimitMinutes}
                onChange={(e) => setTimeLimitMinutes(parseInt(e.target.value) || 64)}
                min={1}
                max={180}
                className="w-32 px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white focus:outline-none focus:border-electric-blue/60 transition-colors"
              />
              <p className="text-soft-gray/40 text-xs">
                SAT standard: 64 min (Math), 32 min (Reading &amp; Writing)
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-soft-gray/70 text-sm font-medium">Open Date</label>
                <input
                  type="datetime-local"
                  value={openDate}
                  onChange={(e) => setOpenDate(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white focus:outline-none focus:border-electric-blue/60 transition-colors"
                />
              </div>
              <div className="space-y-1">
                <label className="text-soft-gray/70 text-sm font-medium">Due Date</label>
                <input
                  type="datetime-local"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white focus:outline-none focus:border-electric-blue/60 transition-colors"
                />
              </div>
            </div>

            <div className="space-y-3">
              <label className="flex items-center justify-between p-3 rounded-xl bg-white/3 border border-white/8 cursor-pointer hover:bg-white/5 transition-colors">
                <div>
                  <div className="text-white text-sm font-medium">Show answers after submission</div>
                  <div className="text-soft-gray/40 text-xs">Students can review correct answers</div>
                </div>
                <div
                  onClick={() => setShowAnswers(!showAnswers)}
                  className={clsx(
                    "w-10 h-6 rounded-full transition-colors relative shrink-0",
                    showAnswers ? "bg-electric-blue" : "bg-white/10"
                  )}
                >
                  <span className={clsx(
                    "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                    showAnswers ? "translate-x-5" : "translate-x-1"
                  )} />
                </div>
              </label>

              <label className="flex items-center justify-between p-3 rounded-xl bg-white/3 border border-white/8 cursor-pointer hover:bg-white/5 transition-colors">
                <div>
                  <div className="text-white text-sm font-medium">Allow retake</div>
                  <div className="text-soft-gray/40 text-xs">Students can take this test multiple times</div>
                </div>
                <div
                  onClick={() => setAllowRetake(!allowRetake)}
                  className={clsx(
                    "w-10 h-6 rounded-full transition-colors relative shrink-0",
                    allowRetake ? "bg-electric-blue" : "bg-white/10"
                  )}
                >
                  <span className={clsx(
                    "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                    allowRetake ? "translate-x-5" : "translate-x-1"
                  )} />
                </div>
              </label>
            </div>

            <div className="flex justify-between pt-2">
              <button onClick={() => setStep(1)} className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-white/10 text-soft-gray/70 hover:text-soft-gray hover:border-white/20 transition-colors text-sm">
                <ChevronLeft size={16} /> Back
              </button>
              <button
                disabled={!testName.trim()}
                onClick={() => setStep(3)}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-electric-blue hover:bg-electric-blue/90 text-white font-semibold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Assignment */}
        {step === 3 && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold text-white">Assign Test</h2>

            {/* Teachers */}
            <div className="space-y-2">
              <label className="text-soft-gray/70 text-sm font-medium">Teachers</label>
              <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                {teachers.length === 0 ? (
                  <p className="text-soft-gray/40 text-xs">No teachers available.</p>
                ) : teachers.map((t) => (
                  <label key={t.id} className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-white/5 cursor-pointer transition-colors">
                    <input
                      type="checkbox"
                      checked={selectedTeacherIds.includes(t.id)}
                      onChange={() => toggleItem(selectedTeacherIds, t.id, setSelectedTeacherIds)}
                      className="w-4 h-4 rounded accent-electric-blue"
                    />
                    <div>
                      <div className="text-white text-sm">{t.display_name}</div>
                      <div className="text-soft-gray/40 text-xs">{t.email}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Class Groups */}
            <div className="space-y-2">
              <label className="text-soft-gray/70 text-sm font-medium">Class Groups</label>
              <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1">
                {classGroups.length === 0 ? (
                  <p className="text-soft-gray/40 text-xs">No class groups.</p>
                ) : classGroups.map((cg) => (
                  <label key={cg.id} className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-white/5 cursor-pointer transition-colors">
                    <input
                      type="checkbox"
                      checked={selectedClassGroupIds.includes(cg.id)}
                      onChange={() => toggleItem(selectedClassGroupIds, cg.id, setSelectedClassGroupIds)}
                      className="w-4 h-4 rounded accent-electric-blue"
                    />
                    <div>
                      <div className="text-white text-sm">{cg.name}</div>
                      {(cg.campus || cg.grade) && (
                        <div className="text-soft-gray/40 text-xs">{[cg.campus, cg.grade].filter(Boolean).join(" · ")}</div>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Individual students */}
            <div className="space-y-2">
              <label className="text-soft-gray/70 text-sm font-medium">Individual Students</label>
              <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                {students.length === 0 ? (
                  <p className="text-soft-gray/40 text-xs">No approved students.</p>
                ) : students.map((s) => (
                  <label key={s.id} className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-white/5 cursor-pointer transition-colors">
                    <input
                      type="checkbox"
                      checked={selectedStudentIds.includes(s.id)}
                      onChange={() => toggleItem(selectedStudentIds, s.id, setSelectedStudentIds)}
                      className="w-4 h-4 rounded accent-electric-blue"
                    />
                    <div>
                      <div className="text-white text-sm">{s.display_name}</div>
                      <div className="text-soft-gray/40 text-xs">{s.email}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Preview */}
            <div className="p-3 rounded-xl bg-white/3 border border-white/8 text-soft-gray/60 text-sm">
              {selectedClassGroupIds.length > 0 || selectedStudentIds.length > 0 ? (
                <span>
                  Assigning to {selectedClassGroupIds.length > 0 ? `${selectedClassGroupIds.length} class group(s)` : ""}
                  {selectedClassGroupIds.length > 0 && selectedStudentIds.length > 0 ? " + " : ""}
                  {selectedStudentIds.length > 0 ? `${selectedStudentIds.length} student(s) directly` : ""}
                </span>
              ) : (
                <span className="text-soft-gray/40">No students assigned yet (can assign later)</span>
              )}
            </div>

            {error && <p className="text-rose text-sm">{error}</p>}

            <div className="flex justify-between pt-2">
              <button onClick={() => setStep(2)} className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-white/10 text-soft-gray/70 hover:text-soft-gray hover:border-white/20 transition-colors text-sm">
                <ChevronLeft size={16} /> Back
              </button>
              <button
                disabled={submitting}
                onClick={handleSubmit}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-lime-green hover:bg-lime-green/90 text-deep-navy font-semibold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
