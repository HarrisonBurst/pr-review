import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MacKeychainStore, type CredentialStore } from "../credential-store.js";

import { MemoryCredentialStore } from "./fixtures/oauth-context.js";

async function contract(store: CredentialStore) {
  const reference = `test:${randomUUID()}`;
  const first = Buffer.from("synthetic-app-owned-canary-one");
  const second = Buffer.from("synthetic-app-owned-canary-two");
  try {
    assert.equal(await store.read(reference), undefined);
    await store.replace(reference, first);
    assert.deepEqual(Buffer.from((await store.read(reference))!), first);
    await store.replace(reference, second);
    assert.deepEqual(Buffer.from((await store.read(reference))!), second);
    await store.delete(reference);
    assert.equal(await store.read(reference), undefined);
    await store.delete(reference);
  } finally {
    await store.delete(reference);
  }
}

test("replaceable credential store contract", async () => {
  await contract(new MemoryCredentialStore());
});

test("missing platform storage never falls back", async () => {
  const store = new MacKeychainStore("local.pr-review.test", "linux");
  await assert.rejects(store.read("test:absent"), /No Linux storage backend/);
  await assert.rejects(
    store.replace("test:absent", new Uint8Array()),
    /No Linux/,
  );
  await assert.rejects(store.delete("test:absent"), /No Linux/);
});

test("storage failures do not become missing credentials", async () => {
  const store = new MemoryCredentialStore();
  store.unavailable = true;
  await assert.rejects(store.read("test:absent"), /unavailable or locked/);
  await assert.rejects(store.delete("test:absent"), /unavailable or locked/);
});

test(
  "owned synthetic macOS Keychain roundtrip",
  {
    skip:
      process.env.PR_REVIEW_TEST_KEYCHAIN !== "1" ||
      process.platform !== "darwin",
  },
  async () => {
    await contract(
      new MacKeychainStore(`local.pr-review.test.${randomUUID()}`),
    );
  },
);
