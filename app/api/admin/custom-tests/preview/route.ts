import { NextResponse } from "next/server";
import { customTestAdmin, familyExclusions, parseSelection, poolFor, summaries } from "@/lib/custom-test/api";
import { PART_SECTION, normalizeRules, rulesErrors, skillCap, type CustomRules, type PartKey } from "@/lib/custom-test/rules";
import { buildSelection, newSeed, replaceQuestion, type PoolQuestion } from "@/lib/custom-test/select";
import { canonicalSkill } from "@/lib/sat-skills";

// POST /api/admin/custom-tests/preview — no writes.
// Body: { rules, seed?, familyId?, allowReuse?, replace?: { selection, part, questionId } }
//  - no replace: a draw from the rules (a new seed unless one is given —
//    Regenerate all sends none);
//  - replace: the given selection with one question swapped for another of
//    the same skill and difficulty (then the usual fallback).
// Returns { seed, selection: { parts, shortfalls }, questions, caps, note }.
export async function POST(req: Request) {
  const ctx = await customTestAdmin();
  if (ctx instanceof NextResponse) return ctx;
  const { admin, db } = ctx;
  let body: { rules?: unknown; seed?: unknown; familyId?: unknown; allowReuse?: unknown; replace?: { selection?: unknown; part?: unknown; questionId?: unknown } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const errors = rulesErrors(body.rules);
  if (errors.length > 0) return NextResponse.json({ error: errors.join("; "), errors }, { status: 400 });
  const rules = normalizeRules(body.rules as CustomRules);
  const seed = typeof body.seed === "string" && /^[a-z0-9:-]{1,40}$/i.test(body.seed) ? body.seed : newSeed();
  const allowReuse = body.allowReuse === true;

  try {
    const [pool, family] = await Promise.all([poolFor(db, admin), familyExclusions(db, body.familyId)]);
    const opts = { seed, exclude: family.ids, allowReuse };
    let note: string | null = null;
    let selection;
    if (body.replace) {
      const current = parseSelection(body.replace.selection);
      const part = body.replace.part;
      if (!current || (part !== "rw" && part !== "math") || typeof body.replace.questionId !== "string") {
        return NextResponse.json({ error: "Invalid replace request" }, { status: 400 });
      }
      const questionId = body.replace.questionId;
      // A saved question that is no longer eligible (the usual reason to
      // replace one on a Draft): its cell comes from its stored labels.
      let info: PoolQuestion | null = null;
      if (!pool.questions.some((q) => q.id === questionId)) {
        const { data: row } = await db.from("questions").select("id, section, domain, skill, difficulty, has_table, has_image").eq("id", questionId).maybeSingle();
        if (row) {
          const canon = canonicalSkill(PART_SECTION[part as PartKey], row.domain as string | null, row.skill as string | null, {
            quantitative: Boolean(row.has_table || row.has_image),
          });
          const d = row.difficulty as string;
          info = { id: questionId, part: part as PartKey, domain: canon.domain, skill: canon.skill, difficulty: (["Easy", "Medium", "Hard"].includes(d) ? d : "Medium") as "Medium", dupKey: `gone:${questionId}` };
        }
      }
      const r = replaceQuestion(pool.questions, rules, current, { part: part as PartKey, questionId, info }, opts);
      if ("error" in r) return NextResponse.json({ error: r.error }, { status: 409 });
      selection = r.selection;
      note = r.note;
    } else {
      selection = buildSelection(pool.questions, rules, opts);
    }
    const caps = Object.fromEntries(rules.order.map((k) => [k, skillCap(rules.parts[k]!)]));
    return NextResponse.json({
      data: { seed, selection, questions: summaries(pool, selection), caps, note, excluded: family.ids.size },
    });
  } catch (e) {
    console.error("[custom-tests/preview]", e);
    return NextResponse.json({ error: "Could not build the preview" }, { status: 500 });
  }
}
