// Unit checks: tagged explanation output + source-aware cut-off check (2026-11-07).
import { parseTagged, looksTruncated, curlyQuotes, parseSolverOutput } from "../lib/ai/solve-question";
let fail = 0;
const ok = (n: string, c: boolean) => { console.log(c ? "PASS" : "FAIL", n); if (!c) fail++; };
const t = parseTagged(`<independent_answer>A</independent_answer>\n<explanation>Both "korrrr" and "hu lu" mean snoring.</explanation>`, ["independent_answer", "explanation"] as const);
ok("straight quotes survive", t?.explanation === `Both "korrrr" and "hu lu" mean snoring.`);
ok("independent answer", t?.independent_answer === "A");
ok("unclosed tag keeps partial", parseTagged(`<explanation>Choice A names both`, ["explanation"] as const)?.explanation === "Choice A names both");
ok("missing tag → null", parseTagged(`no tags here`, ["explanation"] as const) === null);
const src = `The Batak word "korrrr. which represents the sound of snoring, is an onomatopoeia.`;
const ex = `Choice D quotes “korrrr. which represents the sound of snoring, and names only one word.`;
ok("unmatched quote copied from source is not cut-off", !looksTruncated(ex, src));
ok("same text without source context is cut-off", looksTruncated(ex));
ok("mid-sentence ending still cut-off", looksTruncated("Choice A names both", src));
ok("curlyQuotes pairs", curlyQuotes(`a "b" c "d"`) === "a “b” c “d”");
// Pipeline solver (2026-11-20): same tagged format for every SolverSchema field.
const solved = parseSolverOutput(`<correct_answer>B</correct_answer>\n<explanation>The word "correlate" means to vary together.\nFinal answer: B</explanation>\n<answer_expression></answer_expression>\n<check_equation></check_equation>\n<confidence>0.9</confidence>\n<needs_drawing>false</needs_drawing>`);
ok("solver: straight quotes survive", solved?.explanation === `The word "correlate" means to vary together.\nFinal answer: B`);
ok("solver: not flagged cut off", !!solved && !looksTruncated(solved.explanation));
ok("solver: fields", solved?.correct_answer === "B" && solved.confidence === 0.9 && solved.needs_drawing === false && solved.answer_expression === "");
ok("solver: optional tags", parseTagged(`<explanation>x</explanation>`, ["explanation", "confidence"] as const, ["confidence"] as const)?.confidence === "");
console.log(fail ? `${fail} FAILED` : "ALL PASSED"); process.exit(fail ? 1 : 0);
