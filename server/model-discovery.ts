import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import {
  validModel,
  type HarnessId,
  type HarnessModelChoice,
  type HarnessModelDiscovery,
  type HarnessModelEntry,
  type HarnessModelSource,
} from "../shared/contracts.js";
import { nativeModelCatalog } from "./model-catalog.js";
import { nativeSettingsRoot } from "./execution/native-settings.js";
import { codexSettings, settingsObject } from "./execution/projection.js";
import { resolveTrustedFile } from "./execution/trusted-source.js";

const maxBytes = 5_000_000;
const maxModels = 2000;
const maxProviders = 100;

async function readSource(file: string) {
  const resolved = await resolveTrustedFile(file);
  const handle = await open(
    resolved.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) throw new Error();
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    if (
      length !== before.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      resolved.state !== (await resolveTrustedFile(file)).state
    )
      throw new Error();
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, length),
      ),
      modifiedAt: before.mtime.toISOString(),
    };
  } finally {
    await handle.close();
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error();
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > maxModels) throw new Error();
  return value;
}

type Candidate = { model: unknown; label?: unknown };

function piModels(value: Record<string, unknown>, cache: boolean): Candidate[] {
  const providers = cache ? value : object(value.providers ?? {});
  if (Object.keys(providers).length > maxProviders) throw new Error();
  const candidates: Candidate[] = [];
  for (const [provider, raw] of Object.entries(providers)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,99}$/.test(provider)) throw new Error();
    const config = object(raw);
    for (const rawModel of array(config.models ?? (cache ? null : []))) {
      const model = object(rawModel);
      if (
        typeof model.id !== "string" ||
        (cache && model.provider !== provider)
      )
        throw new Error();
      candidates.push({ model: `${provider}/${model.id}`, label: model.name });
      if (candidates.length > maxModels) throw new Error();
    }
  }
  return candidates;
}

export async function discoverHarnessModels(
  harness: HarnessId,
  retained: HarnessModelEntry[],
  env: NodeJS.ProcessEnv,
): Promise<HarnessModelDiscovery> {
  const sources: HarnessModelSource[] = [];
  const models = new Map<string, HarnessModelChoice>();
  let nativeConfiguration: Record<string, unknown> | undefined;
  function add(source: HarnessModelSource, candidates: Candidate[]) {
    let omitted = 0;
    for (const { model, label } of candidates) {
      if (!validModel(model) || model === null) {
        omitted++;
        continue;
      }
      const readable =
        typeof label === "string" &&
        label.trim().length > 0 &&
        label.length <= 200 &&
        !/[\p{Cc}\p{Cf}]/u.test(label)
          ? label.trim()
          : model;
      const existing = models.get(model);
      if (existing) {
        if (!existing.sources.includes(source.id))
          existing.sources.push(source.id);
        if (existing.label === model) existing.label = readable;
      } else
        models.set(model, { model, label: readable, sources: [source.id] });
    }
    if (omitted) {
      source.status = "partial";
      source.message += ` ${omitted} identifiers omitted because they do not match the app's existing model validation; nothing was selected or rewritten.`;
    }
    sources.push(source);
  }
  async function fileSource(
    id: string,
    name: string,
    kind: HarnessModelSource["kind"],
    message: string,
    extract: (value: Record<string, unknown>) => Candidate[],
  ) {
    const source: HarnessModelSource = {
      id,
      kind,
      path: null,
      status: "ready",
      modifiedAt: null,
      freshness: kind === "cached_catalog" ? "unknown" : "not_applicable",
      message,
    };
    try {
      const root = nativeSettingsRoot(harness, env);
      if (!path.isAbsolute(root)) throw new Error();
      source.path = path.join(root, name);
      const file = await readSource(source.path);
      const value = name.endsWith(".toml")
        ? codexSettings(file.text)
        : settingsObject(file.text);
      const candidates = extract(value);
      source.modifiedAt = file.modifiedAt;
      add(source, candidates);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      source.status = missing ? "missing" : "error";
      source.message = missing
        ? "No local source file. Native default and Custom remain selectable; Save validation still applies."
        : "Could not read a stable regular UTF-8 source within 5 MB, 100 providers and 2000 models, or its model fields are malformed. No commands or credentials were resolved. Native default and Custom remain selectable; Save validation still applies.";
      sources.push(source);
    }
  }
  await fileSource(
    "native-settings",
    harness === "codex" ? "config.toml" : "settings.json",
    "configuration",
    "User-level configured model only, not an available-model list or effective native policy. Native default is resolved only on Save.",
    (settings) => {
      nativeConfiguration = settings;
      if (harness !== "pi")
        return settings.model === undefined ? [] : [{ model: settings.model }];
      if (
        settings.defaultProvider === undefined ||
        settings.defaultModel === undefined
      )
        return [];
      if (
        typeof settings.defaultProvider !== "string" ||
        typeof settings.defaultModel !== "string"
      )
        throw new Error();
      return [
        { model: `${settings.defaultProvider}/${settings.defaultModel}` },
      ];
    },
  );
  if (harness === "pi") {
    await fileSource(
      "pi-models",
      "models.json",
      "configuration",
      "Declared provider/model IDs and labels only. Auth/header commands, provider modules and modelOverrides are not resolved; declarations do not prove native validity or access.",
      (value) => piModels(value, false),
    );
    await fileSource(
      "pi-models-store",
      "models-store.json",
      "cached_catalog",
      "Previously cached Pi provider catalog only; may be stale or include unavailable models. File modification time is not provider verification. No catalog refresh or authentication was attempted.",
      (value) => piModels(value, true),
    );
  }
  add(
    {
      id: "saved-selection",
      kind: "saved_selection",
      path: null,
      status: "ready",
      modifiedAt: null,
      freshness: "not_applicable",
      message:
        "Retained app selections, including custom IDs. Membership is not validation of access or execution compatibility.",
    },
    retained
      .filter((entry) => entry.harness === harness && entry.model !== null)
      .map((entry) => ({ model: entry.model })),
  );
  const catalog: HarnessModelSource = {
    id: "native-catalog",
    kind: "catalog",
    path: null,
    status: "unsupported",
    modifiedAt: null,
    freshness: "unknown",
    message:
      "Pi --list-models/RPC/SDK are not launched or imported. Built-in and extension provider modules, auth stores and live catalogs are not loaded. Static sources are incomplete; use retained IDs or Custom.",
  };
  if (harness === "pi") sources.push(catalog);
  else {
    const configuredEnv = nativeConfiguration?.env;
    const providerEnv = {
      ...env,
      ...(configuredEnv && typeof configuredEnv === "object"
        ? configuredEnv
        : {}),
    } as Record<string, unknown>;
    const alternateProvider =
      harness === "codex"
        ? (nativeConfiguration?.model_provider !== undefined &&
            nativeConfiguration.model_provider !== "openai") ||
          nativeConfiguration?.model_catalog_json !== undefined ||
          nativeConfiguration?.profile !== undefined ||
          nativeConfiguration?.openai_base_url !== undefined ||
          Boolean(env.OPENAI_BASE_URL)
        : [
            "ANTHROPIC_BASE_URL",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
          ].some((key) => Boolean(providerEnv[key]));
    if (alternateProvider || sources[0].status === "error") {
      catalog.message =
        "Native catalog unavailable for an alternate provider, profile/catalog override or unreadable configuration. No first-party fallback is used. Configured and saved IDs are retained, not discovered catalog entries; use Custom.";
      sources.push(catalog);
    } else {
      try {
        const candidates = await nativeModelCatalog(harness, env);
        catalog.status = candidates.length ? "ready" : "unsupported";
        catalog.message = `${harness === "claude" ? "Claude bare initialization" : "Codex app-server model/list"} returned the installed harness's unauthenticated first-party catalog in a disposable home. Not your account's available models or effective native policy. No prompt, thread, turn, login or native user configuration was sent. Native default is still resolved only on Save.`;
        add(catalog, candidates);
      } catch (error) {
        catalog.status =
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "unsupported"
            : "error";
        catalog.message =
          "Installed harness metadata could not be acquired within 15 seconds and bounded protocol limits. A compatible Claude --bare initialization or Codex app-server model/list is required. No account catalog or fallback was used; configured/saved IDs remain available, not discovered catalog entries.";
        sources.push(catalog);
      }
    }
  }
  const failed = sources.some((source) => source.status === "error");
  const partial =
    sources.some((source) => source.status === "partial") ||
    (harness !== "pi" && catalog.status !== "ready" && models.size > 0);
  return {
    harness,
    checkedAt: new Date().toISOString(),
    status: failed
      ? models.size
        ? "partial"
        : "error"
      : partial
        ? "partial"
        : models.size
          ? "ready"
          : "unsupported",
    availability: "not_checked",
    models: [...models.values()].sort((a, b) => a.model.localeCompare(b.model)),
    sources,
  };
}
