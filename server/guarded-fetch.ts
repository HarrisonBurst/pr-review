import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export function publicAddress(address: string): boolean {
  const parts = address.split(".").map(Number);
  return (
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    ![0, 10, 127].includes(parts[0]) &&
    parts[0] < 224 &&
    !(parts[0] === 169 && parts[1] === 254) &&
    !(parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) &&
    !(
      parts[0] === 192 &&
      (parts[1] === 168 || parts[1] === 0 || parts[1] === 2)
    ) &&
    !(parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) &&
    !(parts[0] === 198 && [18, 19, 51].includes(parts[1])) &&
    !(parts[0] === 203 && parts[1] === 0 && parts[2] === 113)
  );
}

export function publicHttps(value: string | URL): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    isIP(url.hostname) ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    !/^[a-zA-Z0-9.-]+$/.test(url.hostname)
  )
    throw new Error(
      "Provider endpoint must be a public HTTPS hostname on port 443",
    );
  return url;
}

export type GuardedFetch = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type GuardedFetchDiagnostic =
  | { phase: "request_dispatched" }
  | { phase: "response_headers"; status: number };

export function guardedFetch(
  origins: readonly string[],
  parent?: AbortSignal,
  observe?: (event: GuardedFetchDiagnostic) => void,
): GuardedFetch {
  const report = (event: GuardedFetchDiagnostic) => {
    try {
      observe?.(event);
    } catch {}
  };
  return async (value, init = {}) => {
    const url = publicHttps(value);
    if (!origins.includes(url.origin))
      throw new Error("Provider destination is not approved");
    if (!["GET", "POST", "DELETE"].includes(init.method ?? "GET"))
      throw new Error("Unsupported provider HTTP method");
    if (
      init.body != null &&
      typeof init.body !== "string" &&
      !(init.body instanceof URLSearchParams)
    )
      throw new Error("Unsupported provider request body");
    const body = init.body?.toString();
    if (body && Buffer.byteLength(body) > 200000)
      throw new Error("Provider request exceeds 200 KB");
    const signal = AbortSignal.any([
      AbortSignal.timeout(15000),
      ...(parent ? [parent] : []),
      ...(init.signal ? [init.signal] : []),
    ]);
    signal.throwIfAborted();
    const resolved = await Promise.race([
      lookup(url.hostname, { family: 4 }),
      new Promise<never>((_, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new Error("Provider lookup cancelled")),
          { once: true },
        ),
      ),
    ]);
    signal.throwIfAborted();
    if (!publicAddress(resolved.address))
      throw new Error(
        "Provider endpoint resolved outside the supported public IPv4 transport",
      );
    return new Promise<Response>((resolve, reject) => {
      const request = httpsRequest(
        url,
        {
          method: init.method ?? "GET",
          headers: Object.fromEntries(new Headers(init.headers)),
          signal,
          lookup: (_hostname, options, callback) => {
            if (options.all)
              callback(null, [{ address: resolved.address, family: 4 }]);
            else callback(null, resolved.address, 4);
          },
        },
        (response) => {
          const status = response.statusCode ?? 500;
          report({ phase: "response_headers", status });
          if (status >= 300 && status < 400) {
            response.destroy();
            reject(new Error("Provider redirects are denied"));
            return;
          }
          const headers = new Headers();
          for (const [key, value] of Object.entries(response.headers))
            if (value)
              headers.set(key, Array.isArray(value) ? value.join(", ") : value);
          if ([204, 205, 304].includes(status)) {
            response.destroy();
            resolve(new Response(null, { status, headers }));
            return;
          }
          let bytes = 0;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              response.on("data", (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > 200000)
                  response.destroy(new Error("Provider result exceeds 200 KB"));
                else controller.enqueue(chunk);
              });
              response.on("end", () => controller.close());
              response.on("error", () =>
                controller.error(
                  new Error("Provider response failed or exceeded its bounds"),
                ),
              );
            },
            cancel() {
              response.destroy();
              request.destroy();
            },
          });
          resolve(new Response(stream, { status, headers }));
        },
      );
      request.on("error", () =>
        reject(new Error("Provider transport failed or was cancelled")),
      );
      request.once("finish", () => report({ phase: "request_dispatched" }));
      request.end(body);
    });
  };
}
