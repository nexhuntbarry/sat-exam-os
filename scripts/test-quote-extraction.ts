// Regression test: extracted stem / choice text must not stop at a quotation
// mark (Test #14 English M1/M2: stems ended right before “The Selfish Giant.”,
// “broader”, …; M1 Q8's choices, which open with “, came back empty).
//
// Cause: the text came back inside a JSON string (generateObject). At an
// opening quote the model typed a bare " which ENDS the JSON string, so the
// rest was silently dropped. Printout transcription and the per-question
// re-read now return plain text inside tags (lib/ai/tagged-output.ts).
//
//   node --import tsx scripts/test-quote-extraction.ts
//   LIVE=1 node --env-file=.env.local --import tsx scripts/test-quote-extraction.ts   (+ one real model call)
import { readTag, readTags, unescapeTagText } from "../lib/ai/tagged-output";
import { parseTranscription } from "../lib/printout-parser";
import { parseReextractReply, rereadIsComplete } from "../lib/repair-ops";
import { stemLooksCutOff } from "../lib/parse-guards";

let fail = 0;
const ok = (n: string, c: boolean, detail?: unknown) => {
  console.log(c ? "PASS" : "FAIL", n, detail !== undefined && !c ? JSON.stringify(detail) : "");
  if (!c) fail++;
};

// What the model writes. Straight AND curly quotes, a quote at the very start
// of a choice, a quoted title mid-stem, an apostrophe, LaTeX.
const STEM_M1_Q6 =
  "The following text is from Oscar Wilde's 1888 short story “The Selfish Giant.”\n\n" +
  'Every afternoon, as they were coming from school, the children used to go and play in the Giant\'s garden. "How happy we are here!" they cried to each other.\n\n' +
  "Which choice best states the function of the underlined sentence in the text as a whole?";
const STEM_M2_Q1 =
  "The tourism business, though, is <u>broader</u> than just the destination.\n\nAs used in the text, what does the word “broader” most nearly mean?";

// 1) The old mechanism, shown on the synthetic case: a JSON string ends at the
//    first bare ", which is exactly where the stored stems stopped.
{
  const modelJson = `{"text": "As used in the text, what does the word "broader" most nearly mean?"}`;
  const cut = modelJson.match(/"text": "((?:[^"\\]|\\.)*)"/)?.[1] ?? "";
  ok("old JSON path: string ends at the quote (the bug)", cut === "As used in the text, what does the word ", cut);
  ok("old JSON path: the cut stem is caught by stemLooksCutOff", stemLooksCutOff(cut));
}

// 2) Printout transcription reply (tagged).
{
  const reply = `<part id="STEM-1">
<text>${STEM_M1_Q6}</text>
</part>
<part id="A">
<text>“there are individuals of our species to whom the immediate misery of others is nothing”</text>
</part>
<part id="B">
<text>"in every age there have been found men very willing to perform the office of executioner"</text>
</part>
<part id="STEM-2">
<text>Tree populations, 2003 study</text>
<figure box="0.05,0.1,0.95,0.9">Table of tree species percentages over time</figure>
</part>`;
  const m = parseTranscription(reply);
  ok("transcription: stem kept whole through “The Selfish Giant.”", m.get("STEM-1")?.text === STEM_M1_Q6, m.get("STEM-1")?.text);
  ok("transcription: stem not cut off", !stemLooksCutOff(m.get("STEM-1")?.text));
  ok("transcription: choice opening with “ is not empty", (m.get("A")?.text ?? "").startsWith("“there are individuals"), m.get("A"));
  ok("transcription: choice opening with straight \" is not empty", (m.get("B")?.text ?? "").startsWith('"in every age'), m.get("B"));
  const fig = m.get("STEM-2")?.figures[0];
  ok("transcription: figure box + alt parsed", !!fig && fig.x0 === 0.05 && fig.y1 === 0.9 && fig.alt.startsWith("Table of tree"), fig);
  ok("transcription: lower-case / spaced ids normalised", parseTranscription('<part id=" a "><text>x</text></part>').has("A"));
}

// 3) Per-question re-read reply (tagged) — the re-extract helper.
{
  const reply = `<found>yes</found>
<question_type>Multiple Choice</question_type>
<question_text>${STEM_M2_Q1}</question_text>
<choice label="A">more pronounced</choice>
<choice label="B">“more general”</choice>
<choice label="C">more spacious</choice>
<choice label="D">"more extensive"</choice>
<marked_answer>D</marked_answer>`;
  const r = parseReextractReply(reply);
  ok("re-read: stem kept whole through “broader”", r?.question_text === STEM_M2_Q1, r?.question_text);
  ok("re-read: 4 choices, quoted ones intact", r?.choices.length === 4 && r.choices[1].text === "“more general”" && r.choices[3].text === '"more extensive"', r?.choices);
  ok("re-read: marked answer", r?.marked_answer === "D");
  ok(
    "re-read: complete",
    !!r && rereadIsComplete({ question_type: r.question_type, question_text: r.question_text, choices: r.choices, warnings: [] }),
  );
  const cut = parseReextractReply(`<found>yes</found><question_type>Multiple Choice</question_type><question_text>As used in the text, what does the word </question_text><choice label="A">a</choice><choice label="B">b</choice><choice label="C">c</choice><choice label="D"></choice>`);
  ok(
    "re-read: a cut stem / empty choice is NOT complete (never overwrites)",
    !!cut && !rereadIsComplete({ question_type: cut.question_type, question_text: cut.question_text, choices: cut.choices, warnings: [] }),
  );
  const spr = parseReextractReply("<found>yes</found><question_type>Student Produced Response</question_type><question_text>What is x?</question_text><marked_answer></marked_answer>");
  ok("re-read: fill-in has no choices and no marked answer", spr?.choices.length === 0 && spr.marked_answer === null);
  ok("re-read: found=no", parseReextractReply("<found>no</found><question_text></question_text>")?.found === false);
}

// 4) Tag helpers.
ok("unclosed last tag (token limit) returns what's there", readTag("<text>abc “def", "text") === "abc “def");
ok("JSON-habit double backslashes undone", unescapeTagText("$\\\\frac{1}{2}$ and \\\\$5") === "$\\frac{1}{2}$ and \\$5");
ok("LaTeX \\neq is not treated as a newline escape", unescapeTagText("$a \\neq b$") === "$a \\neq b$");
ok("<u> tags inside text survive", readTags('<part id="A"><text>a <u>b</u> c</text></part>', "part")[0].body.includes("<u>b</u>"));

async function live() {
  // One real transcription of a synthetic quoted line (no PDF needed).
  const { transcribeSlots } = await import("../lib/printout-parser");
  const res = await transcribeSlots(1, [
    { id: "STEM-1", kind: "text", text: "As used in the text, what does the word “broader” most nearly mean?" },
    { id: "STEM-2", kind: "text", text: "“What we are seeing is huge variability within tree populations over time,” said scientist James Clark." },
  ]);
  ok("LIVE: stem keeps “broader” and the question mark", /broader.{0,3} most nearly mean\?$/.test(res.get("STEM-1")?.text ?? ""), res.get("STEM-1"));
  ok("LIVE: piece opening with “ is kept whole", /What we are seeing.*said scientist James Clark\.$/.test(res.get("STEM-2")?.text ?? ""), res.get("STEM-2"));
}

(process.env.LIVE ? live() : Promise.resolve()).then(() => {
  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
});
