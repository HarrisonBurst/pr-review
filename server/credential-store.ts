export interface CredentialStore {
  read(reference: string): Promise<Uint8Array | undefined>;
  replace(reference: string, value: Uint8Array): Promise<void>;
  delete(reference: string): Promise<void>;
}

export class CredentialStoreError extends Error {
  constructor(readonly status: "unsupported" | "unavailable") {
    super(
      status === "unsupported"
        ? "App-owned MCP credentials currently require macOS Keychain. No Linux storage backend is installed; no plaintext fallback is used."
        : "App-owned MCP Keychain storage is unavailable or locked. Unlock the login keychain and retry; no fallback or native credential import is used.",
    );
  }
}

export class MacKeychainStore implements CredentialStore {
  constructor(
    private readonly service = "local.pr-review.mcp",
    private readonly platform = process.platform,
  ) {}

  private async entry(reference: string) {
    if (this.platform !== "darwin")
      throw new CredentialStoreError("unsupported");
    if (!/^[a-zA-Z0-9:-]{1,128}$/.test(reference))
      throw new Error("Invalid app credential reference");
    try {
      const { AsyncEntry } = await import("@napi-rs/keyring");
      return new AsyncEntry(this.service, reference);
    } catch {
      throw new CredentialStoreError("unavailable");
    }
  }

  async read(reference: string): Promise<Uint8Array | undefined> {
    const entry = await this.entry(reference);
    try {
      return (await entry.getSecret()) ?? undefined;
    } catch {
      throw new CredentialStoreError("unavailable");
    }
  }

  async replace(reference: string, value: Uint8Array): Promise<void> {
    const entry = await this.entry(reference);
    try {
      await entry.setSecret(value);
    } catch {
      throw new CredentialStoreError("unavailable");
    }
  }

  async delete(reference: string): Promise<void> {
    const entry = await this.entry(reference);
    try {
      await entry.deleteCredential();
    } catch {
      throw new CredentialStoreError("unavailable");
    }
  }
}
