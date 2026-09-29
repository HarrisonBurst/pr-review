import { spawn } from "node:child_process";
import { dockerResourceLimits } from "./harness.mjs";

let docker;
let child;
let stopping;
let creating;
const input = [];
let inputBytes = 0;
let stderrBytes = 0;
const send = (message) => {
  if (process.connected) process.send(message);
};
const run = (args) =>
  new Promise((resolve) => {
    const command = spawn(docker.command, [...docker.base, ...args], {
      env: docker.env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    command.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 10000) command.kill("SIGKILL");
    });
    const timer = setTimeout(() => command.kill("SIGKILL"), 15000);
    command.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, output: "" });
    });
    command.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output });
    });
  });
function stop(code = null) {
  if (stopping) return stopping;
  stopping = (async () => {
    child?.stdin.destroy();
    child?.kill("SIGKILL");
    let cleaned = true;
    if (docker) {
      await creating;
      await run(["rm", "--force", docker.name]);
      const inventory = await run([
        "ps",
        "-aq",
        "--filter",
        `name=^/${docker.name}$`,
      ]);
      cleaned = inventory.ok && !inventory.output.trim();
    }
    if (process.connected)
      await new Promise((resolve) =>
        process.send({ type: "closed", code, cleaned, stderrBytes }, resolve),
      );
    process.exit(cleaned ? 0 : 1);
  })();
  return stopping;
}
process.on("disconnect", () => void stop());
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
process.on("message", (message) => {
  if (message.type === "start" && !docker) {
    docker = message;
    creating = run(["create", "--name", docker.name, ...docker.args]);
    void creating.then((result) => {
      if (stopping) return;
      if (!result.ok) return void stop(127);
      child = spawn(
        docker.command,
        [...docker.base, "start", "--attach", "--interactive", docker.name],
        { env: docker.env, stdio: ["pipe", "pipe", "pipe"] },
      );
      for (const data of input) child.stdin.write(data);
      input.length = 0;
      inputBytes = 0;
      child.stdin.on("error", () => {});
      child.stdout.on("data", (chunk) => {
        child.stdout.pause();
        if (!process.connected) return void stop();
        process.send({ type: "stdout", data: chunk.toString("base64") }, () =>
          child?.stdout.resume(),
        );
      });
      child.stderr.on("data", (chunk) => {
        stderrBytes += chunk.length;
      });
      child.on("error", () => void stop(127));
      child.on("close", (code) => void stop(code));
    });
  } else if (message.type === "input" && !stopping) {
    if (
      (child?.stdin.writableLength ?? inputBytes) +
        Buffer.byteLength(message.data) >
      dockerResourceLimits.inputBufferBytes
    ) {
      send({ type: "backpressure" });
      void stop(1);
    } else if (child) child.stdin.write(message.data);
    else {
      input.push(message.data);
      inputBytes += Buffer.byteLength(message.data);
    }
  } else if (message.type === "stop") void stop();
});
setTimeout(() => {
  if (!docker) void stop();
}, 10000).unref();
