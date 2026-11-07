// Sanity test for the take-page passage / question split (R&W two-column).
//   npx tsx scripts/test-passage-split.ts
import { splitPassageAndStem } from "../lib/passage-split";

interface Case {
  name: string;
  input: string;
  passage: string | null;
  stem: string;
}

const LONG =
  "Researchers studied a population of birds over ten years and recorded how nesting sites changed as the forest canopy thinned. They found that the birds moved to lower branches when the upper canopy lost its cover, and that the move reduced predation.";

const cases: Case[] = [
  {
    name: "plain passage + 'Which choice' question splits",
    input: `${LONG}\n\nWhich choice best states the main idea of the text?`,
    passage: LONG,
    stem: "Which choice best states the main idea of the text?",
  },
  {
    name: "short stem stays single-column",
    input: "Which choice completes the text?",
    passage: null,
    stem: "Which choice completes the text?",
  },
  {
    // Report 2026-11-07 (Test #10 M2 Q6): passage ends in an underlined run,
    // so the char before the question is ">" — the split was skipped and the
    // whole passage + question sat in the left column.
    name: "passage ending in </u> still splits",
    input: `${LONG} It pitches, <u>like a flock of crows on seed potatoes.</u>\n\nWhich choice best describes the function of the underlined portion in the text as a whole?`,
    passage: `${LONG} It pitches, <u>like a flock of crows on seed potatoes.</u>`,
    stem: "Which choice best describes the function of the underlined portion in the text as a whole?",
  },
  {
    name: "passage ending in a closing quote still splits",
    input: `${LONG} She said, "I have been deceived."\n\nWhich choice best describes the narrator?`,
    passage: `${LONG} She said, "I have been deceived."`,
    stem: "Which choice best describes the narrator?",
  },
  {
    name: "mid-sentence trigger is not a split point",
    input: `${LONG} Critics asked which choice the birds would make.`,
    passage: null,
    stem: `${LONG} Critics asked which choice the birds would make.`,
  },
  {
    // Report 2026-11-07 (Test #10 M1 Q24): the goal sentence went to the
    // passage pane and the question to the right pane.
    name: "rhetorical synthesis: goal sentence goes with the question",
    input:
      "While researching a topic, a student has taken the following notes:\n\n- Chromosomes are cellular structures that contain genes.\n- Genes carry critical instructions for determining an organism's physical traits.\n- The fennec fox and the red fox are both species of foxes.\n- As a species, the fennec fox has sixty-four chromosomes.\n\nThe student wants to emphasize a difference between the two species of foxes. Which choice most effectively uses relevant information from the notes to accomplish this goal?",
    passage:
      "While researching a topic, a student has taken the following notes:\n\n- Chromosomes are cellular structures that contain genes.\n- Genes carry critical instructions for determining an organism's physical traits.\n- The fennec fox and the red fox are both species of foxes.\n- As a species, the fennec fox has sixty-four chromosomes.",
    stem: "The student wants to emphasize a difference between the two species of foxes. Which choice most effectively uses relevant information from the notes to accomplish this goal?",
  },
  {
    name: "rhetorical synthesis: goal sentence in its own paragraph",
    input: `While researching a topic, a student has taken the following notes:\n\n${LONG}\n\nThe student wants to present the study's findings.\n\nWhich choice most effectively uses relevant information from the notes to accomplish this goal?`,
    passage: `While researching a topic, a student has taken the following notes:\n\n${LONG}`,
    stem: "The student wants to present the study's findings.\n\nWhich choice most effectively uses relevant information from the notes to accomplish this goal?",
  },
  {
    name: "passage paragraph starting 'The student wants' stays in the passage (no notes)",
    input: `${LONG}\nThe student wants to succeed in all classes.\n\nWhich choice best states the main idea of the text?`,
    passage: `${LONG}\nThe student wants to succeed in all classes.`,
    stem: "Which choice best states the main idea of the text?",
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const got = splitPassageAndStem(c.input);
  const ok = got.passage === c.passage && got.stem === c.stem;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
  if (!ok) {
    console.log(`  expected: ${JSON.stringify({ passage: c.passage, stem: c.stem })}`);
    console.log(`  got:      ${JSON.stringify(got)}`);
  }
  if (ok) pass++;
  else fail++;
}
console.log(`\n[splitPassageAndStem] ${pass}/${cases.length} passed`);
if (fail > 0) process.exit(1);
