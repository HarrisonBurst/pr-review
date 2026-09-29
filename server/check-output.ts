import { checkReviewOutput } from "./output-checker.js";

let candidate = "";
for await (const part of process.stdin) candidate += part;
const result = checkReviewOutput(candidate);
process.stdout.write(JSON.stringify(result) + "\n");
process.exitCode = result.status === "valid" ? 0 : 1;
