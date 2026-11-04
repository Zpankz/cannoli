import type { SecretStorage } from "obsidian";
import type { SupportedProviders } from "@deablabs/cannoli-core";
import {
  CannoliSettings,
  DEFAULT_SETTINGS,
  ModelRef,
  ModelRoles,
  ProviderProfile,
  UserSecret,
} from "../settings/settings";

export type SecretStorageLike = Pick<
  SecretStorage,
  "setSecret" | "getSecret" | "listSecrets"
>;

/** v2 plaintext key fields, in migration order. */
export type KeyField =
  | "openaiAPIKey"
  | "anthropicAPIKey"
  | "geminiAPIKey"
  | "groqAPIKey"
  | "azureAPIKey"
  | "valTownAPIKey"
  | "exaAPIKey"
  | "cannoliServerSecret";

/** Default SecretStorage id for each v2 key field. */
export const DEFAULT_SECRET_IDS: Record<KeyField, string> = {
  openaiAPIKey: "cannoli-key-openai",
  anthropicAPIKey: "cannoli-key-anthropic",
  geminiAPIKey: "cannoli-key-google",
  groqAPIKey: "cannoli-key-groq",
  azureAPIKey: "cannoli-key-azure",
  valTownAPIKey: "cannoli-secret-valtown-api-key",
  exaAPIKey: "cannoli-secret-exa-api-key",
  cannoliServerSecret: "cannoli-secret-cannoli-server",
};

/** v2 `llmProvider` value → v3 provider profile id. */
export const PROFILE_FOR_PROVIDER: Record<SupportedProviders, string> = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "google",
  groq: "groq",
  azure_openai: "azure",
  ollama: "ollama",
};

/** Provider profile id → its v2 key field (ollama has none). */
export const KEY_FIELD_FOR_PROFILE: Record<string, KeyField> = {
  openai: "openaiAPIKey",
  anthropic: "anthropicAPIKey",
  google: "geminiAPIKey",
  groq: "groqAPIKey",
  azure: "azureAPIKey",
};

export const MISSING_SECRET_STORAGE_WARNING =
  "Cannoli could not reach Obsidian's secure storage, so your API keys stay in plaintext in the plugin's data.json. Update Obsidian to 1.11.4 or later.";

function profileIdFor(field: KeyField): string | undefined {
  return Object.keys(KEY_FIELD_FOR_PROFILE).find(
    (id) => KEY_FIELD_FOR_PROFILE[id] === field,
  );
}

/**
 * The SecretStorage id currently configured for a key field. An unset id falls
 * back to the default; "" means the user cleared the choice (no secret).
 */
export function secretIdFor(
  settings: CannoliSettings,
  field: KeyField,
): string {
  switch (field) {
    case "valTownAPIKey":
      return settings.valTownSecretId ?? DEFAULT_SECRET_IDS[field];
    case "exaAPIKey":
      return settings.exaSecretId ?? DEFAULT_SECRET_IDS[field];
    case "cannoliServerSecret":
      return settings.cannoliServerSecretId ?? DEFAULT_SECRET_IDS[field];
    default: {
      const profileId = profileIdFor(field);
      const profile = settings.providers?.find((p) => p.id === profileId);
      return profile?.secretId ?? DEFAULT_SECRET_IDS[field];
    }
  }
}

/** Point a key field at another SecretStorage id ("" for none). */
export function setSecretIdFor(
  settings: CannoliSettings,
  field: KeyField,
  id: string,
): void {
  switch (field) {
    case "valTownAPIKey":
      settings.valTownSecretId = id;
      return;
    case "exaAPIKey":
      settings.exaSecretId = id;
      return;
    case "cannoliServerSecret":
      settings.cannoliServerSecretId = id;
      return;
    default: {
      const profileId = profileIdFor(field);
      const profile = settings.providers.find((p) => p.id === profileId);
      if (profile) profile.secretId = id;
    }
  }
}

/**
 * Apply a picker choice for a key field. Blanks any plaintext fallback kept by
 * a failed migration, which would otherwise win over the chosen id.
 */
export function selectSecretFor(
  settings: CannoliSettings,
  field: KeyField,
  id: string,
): void {
  setSecretIdFor(settings, field, id);
  settings[field] = "";
}

/** Apply a picker choice for a user secret, dropping any plaintext fallback. */
export function selectUserSecret(entry: UserSecret, id: string): void {
  entry.secretId = id;
  entry.value = "";
}

/** Lowercase; runs of anything but [a-z0-9] become "-"; trimmed of "-". */
export function slugSecretName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "secret"
  );
}

/**
 * A fresh `cannoli-secret-<slug>` id not in `used`. With `emptyIn`, also skip
 * ids that already hold a value there: an entry with no value of its own must
 * not bind to another vault's credential.
 */
function uniqueSecretId(
  name: string,
  used: Set<string>,
  emptyIn?: SecretStorageLike,
): string {
  const base = `cannoli-secret-${slugSecretName(name)}`;
  const taken = (id: string) =>
    used.has(id) || (!!emptyIn && !!readSecret(emptyIn, id));
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

function readSecret(store: SecretStorageLike, id: string): string | null {
  try {
    return store.getSecret(id);
  } catch {
    return null;
  }
}

/**
 * Where `value` should be stored: `base`, unless it already holds a different
 * non-empty value. SecretStorage can be shared across vaults, so that value may
 * be another vault's key: use the next free `<base>-2`, `<base>-3`… instead.
 */
function targetSecretId(
  store: SecretStorageLike,
  base: string,
  value: string,
  used: Set<string>,
): string {
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (n > 1 && used.has(id)) continue;
    const current = readSecret(store, id);
    if (!current || current === value) return id;
  }
}

/**
 * Write (unless already there), read back, and report whether the store now
 * holds exactly `value`.
 */
function storeAndVerify(
  store: SecretStorageLike,
  id: string,
  value: string,
): boolean {
  if (readSecret(store, id) === value) return true;
  try {
    store.setSecret(id, value);
    return store.getSecret(id) === value;
  } catch {
    return false;
  }
}

function v2ModelFor(settings: CannoliSettings, p: SupportedProviders): string {
  switch (p) {
    case "openai":
      return settings.defaultModel;
    case "anthropic":
      return settings.anthropicModel;
    case "gemini":
      return settings.geminiModel;
    case "groq":
      return settings.groqModel;
    case "azure_openai":
      return settings.azureModel;
    case "ollama":
      return settings.ollamaModel;
  }
}

function v3Providers(
  settings: CannoliSettings,
  store: SecretStorageLike | undefined,
): ProviderProfile[] {
  const active = PROFILE_FOR_PROVIDER[settings.llmProvider];
  const hasKey = (field: KeyField) =>
    !!settings[field] ||
    (!!store && !!readSecret(store, DEFAULT_SECRET_IDS[field]));
  const enabled = (id: string) =>
    id === active ||
    (KEY_FIELD_FOR_PROFILE[id] !== undefined &&
      hasKey(KEY_FIELD_FOR_PROFILE[id]));

  // Azure's OpenAI-compatible v1 endpoint, when only the instance is known.
  const azureBaseURL =
    settings.azureBaseURL ||
    (settings.azureOpenAIApiInstanceName
      ? `https://${settings.azureOpenAIApiInstanceName}.openai.azure.com/openai/v1`
      : undefined);

  return [
    {
      id: "openai",
      kind: "openai",
      baseURL: settings.openaiBaseURL || undefined,
      enabled: enabled("openai"),
      secretId: DEFAULT_SECRET_IDS.openaiAPIKey,
    },
    {
      id: "anthropic",
      kind: "anthropic",
      baseURL: settings.anthropicBaseURL || undefined,
      enabled: enabled("anthropic"),
      secretId: DEFAULT_SECRET_IDS.anthropicAPIKey,
    },
    {
      id: "google",
      kind: "google",
      enabled: enabled("google"),
      secretId: DEFAULT_SECRET_IDS.geminiAPIKey,
    },
    {
      id: "ollama",
      kind: "ollama",
      baseURL: settings.ollamaBaseUrl || undefined,
      enabled: enabled("ollama"),
    },
    {
      id: "groq",
      kind: "openai-compatible",
      baseURL: "https://api.groq.com/openai/v1",
      enabled: enabled("groq"),
      secretId: DEFAULT_SECRET_IDS.groqAPIKey,
    },
    {
      id: "azure",
      kind: "openai-compatible",
      baseURL: azureBaseURL,
      enabled: enabled("azure"),
      secretId: DEFAULT_SECRET_IDS.azureAPIKey,
    },
  ];
}

function v3Models(settings: CannoliSettings): ModelRoles {
  const model = v2ModelFor(settings, settings.llmProvider);
  const call: ModelRef = model
    ? `${PROFILE_FOR_PROVIDER[settings.llmProvider]}:${model}`
    : DEFAULT_SETTINGS.models.call;
  // v2 had one model choice; the new roles default to it.
  return {
    call,
    agent: call,
    router: call,
    ...(settings.ollamaModel
      ? { local: `ollama:${settings.ollamaModel}` as ModelRef }
      : {}),
  };
}

function templateHosts(settings: CannoliSettings): string[] {
  const hosts: string[] = [];
  const templates = Array.isArray(settings.httpTemplates)
    ? settings.httpTemplates
    : [];
  for (const template of templates) {
    try {
      const host = new URL(template.url).hostname;
      if (host && !hosts.includes(host)) hosts.push(host);
    } catch {
      // A URL that is itself a variable has no fixed host.
    }
  }
  return hosts;
}

/**
 * Bring raw `data.json` content up to settings v3 and move every plaintext key
 * into SecretStorage. Pure apart from the store: the caller saves and notifies.
 *
 * A field is blanked only after the store reads back exactly what was written.
 * Running it again on its own output moves nothing and changes nothing.
 */
export function migrateSettings(
  raw: unknown,
  store: SecretStorageLike | undefined,
): {
  settings: CannoliSettings;
  moved: number;
  changed: boolean;
  warning?: string;
} {
  // Malformed data falls back to defaults rather than failing plugin load.
  const data = (
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? JSON.parse(JSON.stringify(raw))
      : {}
  ) as Partial<CannoliSettings>;
  const settings: CannoliSettings = {
    ...(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as CannoliSettings),
    ...data,
  };
  let changed = false;
  if (!Array.isArray(settings.secrets)) {
    settings.secrets = [];
    changed = true;
  }
  const validProviders = Array.isArray(data.providers)
    ? data.providers
    : undefined;

  if (data.settingsVersion !== 3) {
    settings.providers = validProviders ?? v3Providers(settings, store);
    settings.models = data.models ?? v3Models(settings);
    settings.concurrency = data.concurrency ?? {
      pLimit: settings.pLimit,
      requestThreshold: settings.requestThreshold,
    };
    settings.network = data.network ?? {
      allow: templateHosts(settings),
      allowLocalhost: true,
    };
    settings.settingsVersion = 3;
    changed = true;
  } else if (!Array.isArray(settings.providers)) {
    settings.providers = v3Providers(settings, store);
    changed = true;
  }

  if (!store) {
    return {
      settings,
      moved: 0,
      changed,
      warning: MISSING_SECRET_STORAGE_WARNING,
    };
  }

  let moved = 0;
  const fields = Object.keys(DEFAULT_SECRET_IDS) as KeyField[];
  const used = new Set<string>([
    ...fields.map((field) => secretIdFor(settings, field)),
    ...settings.secrets.flatMap((s) => (s.secretId ? [s.secretId] : [])),
  ]);

  for (const field of fields) {
    const value = settings[field];
    if (typeof value !== "string" || value === "") continue;
    const base = secretIdFor(settings, field);
    const id = targetSecretId(store, base, value, used);
    if (!storeAndVerify(store, id, value)) continue;
    used.add(id);
    if (id !== base) setSecretIdFor(settings, field, id);
    // Blank only if the field now resolves through the id that holds the value.
    if (secretIdFor(settings, field) !== id) continue;
    settings[field] = "";
    moved++;
  }

  settings.secrets = settings.secrets.map((entry): UserSecret => {
    const next = { ...entry };
    // "" is a choice the user cleared: keep it unless a value needs a home.
    if (next.secretId === undefined || (!next.secretId && next.value)) {
      next.secretId = uniqueSecretId(
        next.name,
        used,
        next.value ? undefined : store,
      );
      changed = true;
    }
    if (next.value) {
      const id = targetSecretId(store, next.secretId, next.value, used);
      if (storeAndVerify(store, id, next.value)) {
        used.add(id);
        next.secretId = id;
        next.value = "";
        moved++;
      }
    }
    return next;
  });

  if (moved > 0) changed = true;
  return { settings, moved, changed };
}
