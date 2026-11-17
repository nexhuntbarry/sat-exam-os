"use client";

import { clsx } from "clsx";
import { useTranslations } from "next-intl";
import type { FullLengthSource } from "../full-length-sources";

export type FlKey = "rw" | "math";

/** One section's modules, as on a Section test (adaptive: m1 + easy/hard; else m1 + m2). */
export interface SectionPick {
  adaptive: boolean;
  m1: string;
  m2: string;
  easy: string;
  hard: string;
  threshold: number;
}

export const EMPTY_PICK: SectionPick = { adaptive: false, m1: "", m2: "", easy: "", hard: "", threshold: 60 };

export const FL_BLOCK_SECTION: Record<FlKey, string> = { rw: "Reading & Writing", math: "Math" };

/** Is the section complete (two modules; tracks differ from Module 1)? The API re-checks. */
export function pickComplete(p: SectionPick): boolean {
  if (!p.m1) return false;
  if (p.adaptive) return Boolean(p.easy || p.hard) && p.easy !== p.m1 && p.hard !== p.m1;
  return Boolean(p.m2) && p.m2 !== p.m1;
}

/** The request body of one section (same fields as a Section test's create body). */
export function pickBody(p: SectionPick) {
  return p.adaptive
    ? { isAdaptive: true, module1Id: p.m1, module2EasyId: p.easy || undefined, module2HardId: p.hard || undefined, adaptiveThreshold: p.threshold }
    : { isAdaptive: false, moduleId: p.m1, module2Id: p.m2 };
}

interface ModuleOption {
  id: string;
  module_name: string;
  section: string;
  module_number: number | null;
  approved: number;
  approvalTotal: number;
}

interface Props {
  /** Fully approved modules only (same rule as a Section test). */
  modules: ModuleOption[];
  sources: FullLengthSource[];
  picks: Record<FlKey, SectionPick>;
  onPick: (key: FlKey, pick: SectionPick) => void;
  /** "Start from an existing test": fills a section from a source test. */
  onSource: (key: FlKey, source: FullLengthSource) => void;
  /** Source test chosen per section by the shortcut ("" = none / edited since). */
  sourceIds: Record<FlKey, string>;
}

const selectCls =
  "w-full bg-surface border border-divider text-charcoal rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-warm-coral/50";

// Full-length SAT, step 1: the four modules picked directly, in an R&W
// block and a Math block. Each block has the Section test's Adaptive switch
// and module pickers, limited to that section's fully approved modules.
export default function FullLengthModulesStep({ modules, sources, picks, onPick, onSource, sourceIds }: Props) {
  const tf = useTranslations("fullLength");
  const optionLabel = (m: ModuleOption) =>
    `${m.module_name}${m.module_number ? ` · M${m.module_number}` : ""} · ${m.approved}/${m.approvalTotal} approved`;

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-charcoal">{tf("chooseModules")}</h2>
        <p className="text-mid-gray text-sm">
          {tf("modulesHint")}{" "}
          <a href="/admin/modules" className="text-warm-coral-text hover:underline">Modules</a>
        </p>
      </div>

      {sources.length > 0 && (
        <div className="rounded-xl border border-divider bg-light-bg/50 p-3 space-y-2">
          <p className="text-sm font-medium text-charcoal">{tf("shortcutLabel")}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {(["rw", "math"] as const).map((key) => (
              <select
                key={key}
                aria-label={`${tf("shortcutLabel")}: ${key === "rw" ? tf("sectionRw") : tf("sectionMath")}`}
                value={sourceIds[key]}
                onChange={(e) => {
                  const src = sources.find((s) => s.id === e.target.value);
                  if (src) onSource(key, src);
                }}
                className={selectCls}
              >
                <option value="">{key === "rw" ? tf("rwSource") : tf("mathSource")}…</option>
                {sources
                  .filter((s) => s.section === key)
                  .map((s) => (
                    // Only fully approved modules can be picked, so a test with
                    // unapproved modules can't fill a section.
                    <option key={s.id} value={s.id} disabled={s.unapprovedModules > 0}>
                      {s.test_name} · {s.isAdaptive ? tf("adaptive") : "M1 + M2"}
                      {s.unapprovedModules > 0 ? ` · ${tf("notApproved", { count: s.unapprovedModules })}` : ""}
                    </option>
                  ))}
              </select>
            ))}
          </div>
          <p className="text-soft-mute text-xs">{tf("shortcutHint")}</p>
        </div>
      )}

      {(["rw", "math"] as const).map((key, i) => {
        const p = picks[key];
        const set = (patch: Partial<SectionPick>) => onPick(key, { ...p, ...patch });
        const inSection = modules.filter((m) => m.section === FL_BLOCK_SECTION[key]);
        const title = key === "rw" ? tf("sectionRw") : tf("sectionMath");
        const others = inSection.filter((m) => m.id !== p.m1);
        return (
          <section key={key} aria-label={title} className="rounded-2xl border border-divider p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-charcoal text-sm font-semibold">
                  {i + 1}. {title}
                </h3>
                <p className="text-soft-mute text-xs mt-0.5">{tf("adaptiveHint")}</p>
              </div>
              <label className="flex items-center gap-2 text-xs text-mid-gray shrink-0">
                {tf("adaptive")}
                <button
                  type="button"
                  role="switch"
                  aria-checked={p.adaptive}
                  aria-label={`${title}: ${tf("adaptive")}`}
                  onClick={() => set({ adaptive: !p.adaptive })}
                  className={clsx("relative w-11 h-6 rounded-full transition-colors", p.adaptive ? "bg-warm-coral" : "bg-light-bg")}
                >
                  <span
                    className={clsx(
                      "absolute top-1 w-4 h-4 bg-white rounded-full transition-transform",
                      p.adaptive ? "translate-x-6" : "translate-x-1",
                    )}
                  />
                </button>
              </label>
            </div>

            {inSection.length === 0 ? (
              <p className="text-soft-mute text-sm">{tf("noModules", { section: title })}</p>
            ) : (
              <>
                <div>
                  <label className="block text-sm font-medium text-charcoal mb-1">
                    {tf("module1")} <span className="text-status-error">*</span>
                  </label>
                  <select
                    aria-label={`${title}: ${tf("module1")}`}
                    value={p.m1}
                    onChange={(e) => {
                      const m1 = e.target.value;
                      // Module 2 / tracks must differ from Module 1.
                      set({ m1, m2: p.m2 === m1 ? "" : p.m2, easy: p.easy === m1 ? "" : p.easy, hard: p.hard === m1 ? "" : p.hard });
                    }}
                    className={selectCls}
                  >
                    <option value="">{tf("selectModule")}</option>
                    {inSection.map((m) => (
                      <option key={m.id} value={m.id}>{optionLabel(m)}</option>
                    ))}
                  </select>
                </div>
                {!p.adaptive ? (
                  <div>
                    <label className="block text-sm font-medium text-charcoal mb-1">
                      {tf("module2")} <span className="text-status-error">*</span>
                    </label>
                    <select aria-label={`${title}: ${tf("module2")}`} value={p.m2} onChange={(e) => set({ m2: e.target.value })} className={selectCls}>
                      <option value="">{tf("selectModule")}</option>
                      {others.map((m) => (
                        <option key={m.id} value={m.id}>{optionLabel(m)}</option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {(["easy", "hard"] as const).map((track) => (
                        <div key={track}>
                          <label className="block text-sm font-medium text-charcoal mb-1">
                            {track === "easy" ? tf("module2Easy") : tf("module2Hard")}
                          </label>
                          <select
                            aria-label={`${title}: ${track === "easy" ? tf("module2Easy") : tf("module2Hard")}`}
                            value={p[track]}
                            onChange={(e) => set({ [track]: e.target.value })}
                            className={selectCls}
                          >
                            <option value="">{tf("noneTrack")}</option>
                            {others.map((m) => (
                              <option key={m.id} value={m.id}>{optionLabel(m)}</option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-charcoal mb-1">{tf("threshold")}</label>
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min={0}
                          max={100}
                          step={5}
                          aria-label={`${title}: ${tf("threshold")}`}
                          value={p.threshold}
                          onChange={(e) => set({ threshold: Number(e.target.value) })}
                          className="flex-1 accent-warm-coral"
                        />
                        <span className="font-mono text-warm-coral-text w-12 text-right">{p.threshold}%</span>
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
