import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );

export class ContainerMcp {
  constructor(connections, environment) {
    this.connections = connections;
    this.environment = environment;
    this.remaining = 100;
    this.active = 0;
    this.evidence = { inventories: 0, reads: 0, denied: 0 };
  }

  async invoke(connection, args) {
    if (--this.remaining < 0 || this.active >= 4)
      throw new Error("Local MCP request/concurrency budget exceeded");
    const profile = connection.profile;
    if (
      createHash("sha256").update(JSON.stringify(profile)).digest("hex") !==
      connection.profileDigest
    )
      throw new Error("Local MCP profile changed");
    const child = spawn(process.execPath, [`/scratch/${connection.target}`], {
      cwd: "/scratch",
      env: this.environment,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.active++;
    const decoder = new StringDecoder("utf8");
    let pending;
    let sequence = 0;
    let bytes = 0;
    let buffer = "";
    let failure;
    const fail = () => {
      failure = new Error(
        "Local MCP protocol, size, process or time boundary failed",
      );
      pending?.reject(failure);
      pending = undefined;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(fail, 15000);
    child.on("error", fail);
    child.on("exit", () => {
      if (pending) fail();
    });
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 200000) return fail();
      buffer += decoder.write(chunk);
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const message = JSON.parse(line);
          if (
            !pending ||
            message.jsonrpc !== "2.0" ||
            message.id !== pending.id ||
            message.error ||
            message.method ||
            !message.result
          )
            return fail();
          const current = pending;
          pending = undefined;
          current.resolve(message.result);
        } catch {
          return fail();
        }
      }
    });
    const request = (method, params) =>
      new Promise((resolve, reject) => {
        if (failure) return reject(failure);
        const id = ++sequence;
        pending = { id, resolve, reject };
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        );
      });
    child.stdin.on("error", fail);
    try {
      const initialized = await request("initialize", {
        protocolVersion: profile.server.protocol,
        capabilities: {},
        clientInfo: { name: "pr-review", version: "1" },
      });
      if (
        initialized.protocolVersion !== profile.server.protocol ||
        initialized.serverInfo?.name !== profile.server.name ||
        initialized.serverInfo?.version !== profile.server.version ||
        Object.keys(initialized.capabilities ?? {}).some(
          (key) => key !== "tools",
        )
      )
        throw new Error("Local MCP server identity/capabilities changed");
      child.stdin.write(
        '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
      );
      const listed = await request("tools/list", {});
      if (
        listed.nextCursor ||
        listed.tools?.length !== 1 ||
        listed.tools[0].name !== profile.tool.name ||
        canonical(listed.tools[0].inputSchema) !==
          canonical(profile.tool.inputSchema)
      )
        throw new Error(
          "Local MCP inventory changed; tool names/annotations grant nothing",
        );
      this.evidence.inventories++;
      if (args === undefined)
        return {
          name: profile.tool.name,
          description: profile.label,
          inputSchema: profile.tool.inputSchema,
        };
      if (
        !args ||
        Object.keys(args).length !== 1 ||
        typeof args.id !== "string" ||
        !connection.request.scope.includes(args.id)
      )
        throw new Error("Local MCP resource or argument denied");
      const result = await request("tools/call", {
        name: profile.tool.name,
        arguments: args,
      });
      if (
        result.isError ||
        result.content?.length !== 1 ||
        result.content[0].type !== "text" ||
        typeof result.content[0].text !== "string"
      )
        throw new Error("Local MCP result must be one bounded text item");
      this.evidence.reads++;
      return result;
    } catch (error) {
      this.evidence.denied++;
      throw error;
    } finally {
      this.active--;
      clearTimeout(timer);
      child.kill("SIGKILL");
      child.stdin.destroy();
      child.stdout.destroy();
    }
  }

  enabled() {
    return this.connections.filter(
      (item) =>
        item.request.enabled &&
        item.request.allowedTools.includes(item.profile.tool.id),
    );
  }

  async tools() {
    const names = this.enabled().map((item) => item.profile.tool.name);
    if (new Set(names).size !== names.length)
      throw new Error("Ambiguous local MCP tool identity");
    return Promise.all(this.enabled().map((item) => this.invoke(item)));
  }

  async call(name, args) {
    const connections = this.enabled().filter(
      (item) => item.profile.tool.name === name,
    );
    if (connections.length !== 1) throw new Error("Local MCP tool denied");
    return this.invoke(connections[0], args);
  }
}
