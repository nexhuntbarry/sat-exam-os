// Unit checks: tagged explanation output + source-aware cut-off check (2026-11-07).
import { parseTagged, looksTruncated, curlyQuotes } from "../lib/ai/solve-question";
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
console.log(fail ? `${fail} FAILED` : "ALL PASSED"); process.exit(fail ? 1 : 0);
