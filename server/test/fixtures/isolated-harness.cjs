const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const harness = path.basename(process.argv[1]);
  const args = process.argv.slice(2);
  const model = args[args.indexOf("--model") + 1];
  const prompt = fs.readFileSync(0, "utf8");
  const question = prompt.includes("not a full PR review");
  const schema = JSON.parse(prompt.split("\n\n").at(-1));
  fs.appendFileSync(
    process.env.FIXTURE_LOG,
    JSON.stringify({
      harness,
      model,
      args,
      prompt,
      home: process.env.HOME,
      cwd: process.cwd(),
      piHome: process.env.PI_CODING_AGENT_DIR,
    }) + "\n",
  );
  if (model === "fail") process.exit(1);
  if (model === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  const call = async (method, params) =>
    (
      await (
        await fetch(process.env.PR_REVIEW_LOCAL_TOOLS, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + process.env.PR_REVIEW_LOCAL_TOKEN,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        })
      ).json()
    ).result;
  const tools = await call("tools/list", {});
  if (
    tools.tools
      .map((tool) => tool.name)
      .filter(
        (name) =>
          ![
            "documents_get",
            "get_issue",
            "list_issues",
            "listDatasets",
            "getDatasetFields",
            "queryDataset",
            "notion-fetch",
          ].includes(name),
      )
      .sort()
      .join() !== "check_review_output,read_source"
  )
    throw Error("Unexpected tools");
  if (tools.tools.some((tool) => tool.name === "documents_get")) {
    const document = await call("tools/call", {
      name: "documents_get",
      arguments: { id: "fixture-document" },
    });
    if (!JSON.stringify(document).includes("Untrusted synthetic document"))
      throw Error("Approved read unavailable");
  }
  if (tools.tools.some((tool) => tool.name === "get_issue")) {
    const issue = await call("tools/call", {
      name: "get_issue",
      arguments: { id: "FIX-42" },
    });
    if (!JSON.stringify(issue).includes("SYNTHETIC Linear ticket intent"))
      throw Error("Approved Linear read unavailable");
  }
  if (tools.tools.some((tool) => tool.name === "notion-fetch")) {
    const document = await call("tools/call", {
      name: "notion-fetch",
      arguments: { id: "synthetic-page-id" },
    });
    if (!JSON.stringify(document).includes("SYNTHETIC Notion document"))
      throw Error("Approved Notion read unavailable");
  }
  if (tools.tools.some((tool) => tool.name === "queryDataset")) {
    const events = await call("tools/call", {
      name: "queryDataset",
      arguments: {
        datasetName: "synthetic-events",
        startTime: "2026-01-01T00:00:00Z",
        endTime: "2026-01-01T00:05:00Z",
        limit: 1,
      },
    });
    if (!JSON.stringify(events).includes("SYNTHETIC Axiom events"))
      throw Error("Approved Axiom read unavailable");
  }
  if (!question) {
    const resource = await call("tools/call", {
      name: "read_source",
      arguments: { path: "resources/fixture-audit/rubric.md" },
    });
    if (resource.content[0].text !== "FROZEN RUBRIC")
      throw Error("Resource not frozen");
  }
  let value = {
    overview: "# Synthetic fixture " + model,
    body: "Review " + model,
    rationale: "Private " + model,
    verdict: "COMMENT",
    findings: [
      {
        id: model,
        severity: "non_blocking",
        path: "src/demo.ts",
        line: 2,
        body: "Finding " + model,
        evidence: "Evidence " + model,
        origin: "introduced",
        included: true,
      },
    ],
  };
  if (prompt.includes("You are Main,")) {
    const evidence = JSON.parse(
      prompt.split("ADDITIONAL EVIDENCE DATA (JSON):\n\n")[1].split("\n\n")[0],
    );
    value.findings = evidence
      .flatMap((entry) => entry.result?.findings ?? [])
      .concat(value.findings);
    value.body =
      "Synthesized " +
      evidence.map((entry) => entry.id + ":" + entry.status).join(",");
  }
  if (question)
    value = schema.properties.answer
      ? { answer: "Synthetic focused answer " + model, followUps: [] }
      : {
          body: "Synthetic draft comment",
          severity: "non_blocking",
          origin: "introduced",
          evidence: "Private question evidence",
        };
  if (!question) {
    const checked = await call("tools/call", {
      name: "check_review_output",
      arguments: { candidate: JSON.stringify(value) },
    });
    if (checked.isError) throw Error("Checker rejected fixture");
  }
  if (model === "invalid") value.verdict = "NOT_VALID";
  if (model === "oversized") value.rationale = "x".repeat(210000);
  const line = (value) => console.log(JSON.stringify(value));
  if (harness === "claude") {
    if (model === "truncated") process.stdout.write('{"type":"result"');
    else
      line({
        type: "result",
        subtype: "success",
        is_error: false,
        structured_output: value,
      });
  } else if (harness === "codex") {
    line({ type: "turn.started" });
    line({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify(value) },
    });
    if (model !== "truncated") line({ type: "turn.completed" });
    if (model === "incomplete-next-turn") line({ type: "turn.started" });
  } else {
    line({ type: "agent_start" });
    line({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: JSON.stringify(value) }],
      },
    });
    if (model !== "truncated") line({ type: "agent_end" });
    if (model === "incomplete-next-turn") {
      line({ type: "agent_start" });
      line({ type: "agent_end" });
    }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
