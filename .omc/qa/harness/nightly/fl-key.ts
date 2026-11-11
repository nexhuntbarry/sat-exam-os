// Reads a JSON array of correct_answer values on stdin, prints the answer
// key text the print page shows for each (components/tests/PrintableTest:
// answerCandidates(…).join(" or ") || "—"). Used by FL-PRINT.
import { answerCandidates } from "../../../../lib/grade-submission";
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  const items = JSON.parse(raw || "[]") as (string | null)[];
  process.stdout.write(JSON.stringify(items.map((c) => answerCandidates(c).join(" or ") || "—")));
});
