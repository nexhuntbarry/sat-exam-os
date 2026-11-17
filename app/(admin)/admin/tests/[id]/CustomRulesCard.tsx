import Link from "next/link";
import { PART_LABEL, STAGE_LABEL, domainTotals, partStages, type CustomRules } from "@/lib/custom-test/rules";

// Test page of a Custom test: the saved rules, plus Edit questions (a Draft
// nobody has started) and Make another version (same rules, none of the
// earlier versions' questions).
export default function CustomRulesCard({
  testId,
  rules,
  status,
  started,
}: {
  testId: string;
  rules: CustomRules;
  status: string;
  started: boolean;
}) {
  const editable = status === "Draft" && !started;
  return (
    <section className="bg-surface border border-divider rounded-2xl p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-charcoal font-semibold">Custom test rules</h2>
          <p className="text-soft-mute text-xs">
            Version {rules.version}
            {rules.subject === "both"
              ? ` · R&W then Math · ${rules.break && rules.break.minutes > 0 ? `${rules.break.minutes} min break${rules.break.allowPause ? " (may leave)" : ""}` : "no break"}`
              : ""}
            {rules.allow_reuse ? " · may reuse earlier versions' questions" : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {editable ? (
            <Link href={`/admin/tests/new/custom?edit=${testId}`} className="rounded-xl border border-divider px-3 py-1.5 text-sm text-charcoal hover:bg-light-bg">
              Edit questions
            </Link>
          ) : (
            <span className="text-xs text-soft-mute self-center">
              {started ? "Questions are locked: students have started." : "Move back to Draft to edit questions."}
            </span>
          )}
          <Link href={`/admin/tests/new/custom?from=${testId}`} className="rounded-xl bg-warm-coral px-3 py-1.5 text-sm font-semibold text-white hover:bg-warm-coral-dark">
            Make another version
          </Link>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {rules.order
          .filter((k) => rules.parts[k])
          .map((k) => {
            const p = rules.parts[k]!;
            const stages = partStages(rules.subject, p);
            const mixes = p.adaptive
              ? ([["m1", p.mix.m1], ["m2_easy", p.mix.m2_easy], ["m2_hard", p.mix.m2_hard]] as const).map(
                  ([s, m]) => `${STAGE_LABEL[s]} ${m.Easy}/${m.Medium}/${m.Hard}`,
                )
              : [`${p.mix.all.Easy}/${p.mix.all.Medium}/${p.mix.all.Hard}`];
            return (
              <div key={k} className="rounded-xl border border-divider p-3 text-sm space-y-1">
                <p className="font-medium text-charcoal">
                  {PART_LABEL[k]} · {p.questions} questions · {p.adaptive ? `adaptive (harder Module 2 at ≥ ${p.threshold}%)` : "fixed"}
                </p>
                <p className="text-mid-gray">
                  {stages.map((s) => `${STAGE_LABEL[s.key]} ${s.n}`).join(" · ")} · {p.minutes.m1}
                  {p.minutes.m2 ? ` + ${p.minutes.m2}` : ""} min
                </p>
                <p className="text-mid-gray">
                  {Object.entries(domainTotals(p.skills))
                    .filter(([, n]) => n > 0)
                    .map(([d, n]) => `${d} ${n}`)
                    .join(" · ")}
                </p>
                <p className="text-soft-mute text-xs">Difficulty (Easy/Medium/Hard %): {mixes.join(" · ")}</p>
              </div>
            );
          })}
      </div>
      {(rules.shortfalls ?? []).length > 0 && (
        <div className="text-xs text-mid-gray">
          <p className="font-medium text-charcoal">Shortfalls accepted when saved</p>
          <ul className="list-disc pl-5">
            {(rules.shortfalls ?? []).map((s, i) => (
              <li key={i}>{s.message}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
