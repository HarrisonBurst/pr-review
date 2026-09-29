import test from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import https from "node:https";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { guardedFetch, type GuardedFetchDiagnostic } from "../guarded-fetch.js";

test("guarded HTTP pins public DNS, rejects redirects and bounds responses without forwarding credentials", async (t) => {
  let address = "1.1.1.1";
  let lookups = 0;
  let requests = 0;
  let status = 200;
  let content = "{}";
  let pendingLookup:
    (() => Promise<{ address: string; family: number }>) | undefined;
  let options: https.RequestOptions | undefined;
  t.mock.method(dns, "lookup", async () => {
    lookups++;
    return pendingLookup ? pendingLookup() : { address, family: 4 };
  });
  t.mock.method(https, "request", ((
    _url: unknown,
    input: https.RequestOptions,
    callback: (response: unknown) => void,
  ) => {
    requests++;
    options = input;
    const request = new EventEmitter() as EventEmitter & { end(): void };
    request.end = () =>
      queueMicrotask(() => {
        request.emit("finish");
        const response = Object.assign(new PassThrough(), {
          statusCode: status,
          headers: {
            "content-type": "application/json",
            location: "https://unapproved.example.com",
          },
        });
        callback(response);
        if (!response.destroyed) response.end(content);
      });
    return request;
  }) as typeof https.request);
  syncBuiltinESMExports();
  try {
    const events: GuardedFetchDiagnostic[] = [];
    const fetch = guardedFetch(
      ["https://approved.example.com"],
      undefined,
      (event) => events.push(event),
    );
    const result = await fetch("https://approved.example.com/token", {
      method: "POST",
      body: "synthetic-body",
      headers: { authorization: "Bearer synthetic-canary" },
    });
    assert.deepEqual(await result.json(), {});
    assert.equal(lookups, 1);
    assert.equal(requests, 1);
    assert.deepEqual(events, [
      { phase: "request_dispatched" },
      { phase: "response_headers", status: 200 },
    ]);
    address = "127.0.0.1";
    const pin = await new Promise((resolve, reject) =>
      (options!.lookup as Function)(
        "approved.example.com",
        { all: true },
        (error: unknown, addresses: unknown) =>
          error ? reject(error) : resolve(addresses),
      ),
    );
    assert.deepEqual(pin, [{ address: "1.1.1.1", family: 4 }]);
    assert.equal(lookups, 1);
    await assert.rejects(
      fetch("https://approved.example.com/token"),
      /public IPv4/,
    );
    assert.equal(requests, 1);
    assert.equal(events.length, 2);
    address = "1.1.1.1";
    status = 302;
    await assert.rejects(
      fetch("https://approved.example.com/token"),
      /redirects are denied/,
    );
    assert.equal(requests, 2);
    assert.deepEqual(events.slice(-2), [
      { phase: "request_dispatched" },
      { phase: "response_headers", status: 302 },
    ]);
    status = 200;
    content = "x".repeat(200001);
    await assert.rejects(
      (await fetch("https://approved.example.com/token")).text(),
      /exceeded its bounds/,
    );
    const abort = new AbortController();
    pendingLookup = () => new Promise(() => {});
    const cancelled = fetch("https://approved.example.com/token", {
      signal: abort.signal,
    });
    abort.abort();
    await assert.rejects(cancelled, /lookup cancelled/);
    assert.equal(requests, 3);
    assert.equal(events.length, 6);
    assert.doesNotMatch(
      JSON.stringify(events),
      /synthetic|https:|authorization|"headers"|"body"/,
    );
    pendingLookup = undefined;
    content = "{}";
    const throwing = guardedFetch(
      ["https://approved.example.com"],
      undefined,
      () => {
        throw new Error("OBSERVER_CANARY");
      },
    );
    assert.deepEqual(
      await (await throwing("https://approved.example.com/token")).json(),
      {},
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
