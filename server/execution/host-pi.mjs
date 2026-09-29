export default async function (pi) {
  let sequence = 0;
  const call = async (method, params, signal) => {
    const response = await fetch(process.env.PR_REVIEW_LOCAL_TOOLS, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.PR_REVIEW_LOCAL_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
    const value = await response.json();
    if (!response.ok || value.error)
      throw new Error(value.error?.message ?? "Local tool unavailable");
    return value.result;
  };
  const { tools } = await call("tools/list", {});
  for (const tool of tools)
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(_id, args, signal) {
        const result = await call(
          "tools/call",
          { name: tool.name, arguments: args },
          signal,
        );
        return { content: result.content, details: {} };
      },
    });
}
