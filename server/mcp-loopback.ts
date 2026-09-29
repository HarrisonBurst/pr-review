import { createServer, type Server } from "node:http";

export class OAuthCallbackError extends Error {
  constructor(
    readonly code:
      | "oauth_callback_invalid"
      | "oauth_callback_unavailable"
      | "oauth_callback_changed",
  ) {
    super(
      code === "oauth_callback_changed"
        ? "The configured app callback changed. Explicitly reconfigure a compatible client redirect before connecting; no fixed listener was inferred."
        : code === "oauth_callback_invalid"
          ? "Choose the app callback or an exact HTTP loopback redirect with an explicit unprivileged port and plain path. No query, fragment, credentials or app-port alias is allowed."
          : "The selected callback listener is unavailable. Close your own conflicting session or explicitly choose another registered redirect; no port was replaced or taken over.",
    );
  }
}

export function oauthRedirect(value: unknown, appRedirect: string): string {
  if (value === undefined || value === appRedirect) return appRedirect;
  try {
    if (typeof value !== "string" || value.length > 256) throw new Error();
    const url = new URL(value);
    if (
      url.href !== value ||
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      Number(url.port) < 1024 ||
      Number(url.port) > 65535 ||
      !url.port ||
      url.port === new URL(appRedirect).port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname.length > 128 ||
      !/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?)?$/.test(url.pathname)
    )
      throw new Error();
    return value;
  } catch {
    throw new OAuthCallbackError("oauth_callback_invalid");
  }
}

export async function listenOAuthCallback(
  redirectUri: string,
  receive: (params: URLSearchParams) => string,
): Promise<() => void> {
  const redirect = new URL(redirectUri);
  const servers: Server[] = [];
  const close = () => {
    for (const server of servers) {
      server.close();
      server.closeAllConnections();
    }
  };
  try {
    for (const host of redirect.hostname === "localhost"
      ? ["127.0.0.1", "::1"]
      : [redirect.hostname.replace(/[\[\]]/g, "")]) {
      const server = createServer(
        {
          maxHeaderSize: 16384,
          requestTimeout: 5000,
          headersTimeout: 5000,
          connectionsCheckingInterval: 1000,
        },
        (request, response) => {
          const headers = {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "content-security-policy":
              "default-src 'none'; frame-ancestors 'none'",
            "x-content-type-options": "nosniff",
            connection: "close",
          };
          try {
            if (
              request.method !== "GET" ||
              request.headers.host !== redirect.host ||
              request.headersDistinct.host?.length !== 1 ||
              request.headers.origin ||
              request.headers["transfer-encoding"] ||
              Number(request.headers["content-length"] ?? 0) !== 0 ||
              !["127.0.0.1", "::1"].includes(
                request.socket.remoteAddress ?? "",
              ) ||
              !request.url ||
              request.url.length > 12000 ||
              !request.url.startsWith(`${redirect.pathname}?`)
            )
              throw new Error();
            const url = new URL(request.url, redirect.origin);
            if (
              url.origin !== redirect.origin ||
              url.pathname !== redirect.pathname ||
              url.hash
            )
              throw new Error();
            const location = receive(url.searchParams);
            response.once("finish", close);
            response.writeHead(303, { ...headers, location });
            response.end(
              "Return to the original app browser to finish authorization.",
            );
          } catch {
            response.writeHead(409, headers);
            response.end("OAuth callback was refused. Return to Connections.");
          }
        },
      );
      servers.push(server);
      server.maxConnections = 8;
      server.maxRequestsPerSocket = 1;
      server.setTimeout(5000, (socket) => socket.destroy());
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(
          {
            port: Number(redirect.port),
            host,
            ipv6Only: true,
            exclusive: true,
          },
          resolve,
        );
      });
    }
    return close;
  } catch {
    close();
    throw new OAuthCallbackError("oauth_callback_unavailable");
  }
}
