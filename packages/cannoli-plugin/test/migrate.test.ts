import { describe, expect, it } from "vitest";
import { migrateSettings } from "../src/secrets/migrate";
import { SecretStorage } from "./mocks/obsidian";

/** A store whose read-back for one id never equals what was written. */
class MismatchStore extends SecretStorage {
  constructor(private readonly badId: string) {
    super();
  }
  getSecret(id: string): string | null {
    const value = super.getSecret(id);
    return id === this.badId && value !== null ? `${value}-corrupted` : value;
  }
}

function snapshot(store: SecretStorage): Record<string, string | null> {
  return Object.fromEntries(
    store.listSecrets().map((id) => [id, store.getSecret(id)]),
  );
}

/** A v2 data.json (no settingsVersion) with every kind of plaintext key. */
function v2Data(): Record<string, unknown> {
  return {
    llmProvider: "openai",
    defaultModel: "gpt-4o-mini",
    openaiAPIKey: "sk-openai-1",
    anthropicAPIKey: "sk-ant-2",
    geminiAPIKey: "",
    groqAPIKey: "gsk-3",
    azureAPIKey: "az-4",
    valTownAPIKey: "vt-5",
    exaAPIKey: "exa-6",
    cannoliServerSecret: "srv-7",
    secrets: [
      { name: "MY_TOKEN", value: "tok-8", visibility: "password" },
      { name: "my token", value: "tok-9", visibility: "text" },
      { name: "EMPTY", value: "", visibility: "password" },
    ],
    httpTemplates: [
      {
        id: "a",
        name: "A",
        url: "https://api.example.com/v1/{{path}}",
        method: "GET",
      },
      { id: "b", name: "B", url: "https://api.example.com/v2", method: "GET" },
      { id: "c", name: "C", url: "http://hooks.test:8080/x", method: "POST" },
      { id: "d", name: "D", url: "{{url}}", method: "GET" },
    ],
    pLimit: 7,
    requestThreshold: 3,
  };
}

const MOVED_VALUES = [
  "sk-openai-1",
  "gsk-3",
  "az-4",
  "vt-5",
  "exa-6",
  "srv-7",
  "tok-8",
  "tok-9",
];

describe("migrateSettings", () => {
  it("moves plaintext keys then blanks only after read-back", () => {
    const store = new MismatchStore("cannoli-key-anthropic");
    const { settings, moved, changed, warning } = migrateSettings(
      v2Data(),
      store,
    );

    expect(warning).toBeUndefined();
    expect(changed).toBe(true);
    expect(settings.settingsVersion).toBe(3);
    // 9 non-empty keys; the anthropic read-back mismatched, so it is not counted.
    expect(moved).toBe(8);

    expect(store.getSecret("cannoli-key-openai")).toBe("sk-openai-1");
    expect(store.getSecret("cannoli-key-groq")).toBe("gsk-3");
    expect(store.getSecret("cannoli-key-azure")).toBe("az-4");
    expect(store.getSecret("cannoli-secret-valtown-api-key")).toBe("vt-5");
    expect(store.getSecret("cannoli-secret-exa-api-key")).toBe("exa-6");
    expect(store.getSecret("cannoli-secret-cannoli-server")).toBe("srv-7");
    expect(store.getSecret("cannoli-key-google")).toBeNull();

    expect(settings.openaiAPIKey).toBe("");
    expect(settings.groqAPIKey).toBe("");
    expect(settings.azureAPIKey).toBe("");
    expect(settings.valTownAPIKey).toBe("");
    expect(settings.exaAPIKey).toBe("");
    expect(settings.cannoliServerSecret).toBe("");
    // Read-back mismatch: the field keeps its plaintext value.
    expect(settings.anthropicAPIKey).toBe("sk-ant-2");

    expect(settings.secrets).toEqual([
      {
        name: "MY_TOKEN",
        value: "",
        visibility: "password",
        secretId: "cannoli-secret-my-token",
      },
      {
        name: "my token",
        value: "",
        visibility: "text",
        secretId: "cannoli-secret-my-token-2",
      },
      {
        name: "EMPTY",
        value: "",
        visibility: "password",
        secretId: "cannoli-secret-empty",
      },
    ]);
    expect(store.getSecret("cannoli-secret-my-token")).toBe("tok-8");
    expect(store.getSecret("cannoli-secret-my-token-2")).toBe("tok-9");
    // Empty values are never written.
    expect(store.getSecret("cannoli-secret-empty")).toBeNull();

    const persisted = JSON.stringify(settings);
    for (const value of MOVED_VALUES) expect(persisted).not.toContain(value);

    // v3 sections, with the legacy fields kept.
    expect(settings.concurrency).toEqual({ pLimit: 7, requestThreshold: 3 });
    expect(settings.network).toEqual({
      allow: ["api.example.com", "hooks.test"],
      allowLocalhost: true,
    });
    expect(settings.models.call).toBe("openai:gpt-4o-mini");
    expect(settings.llmProvider).toBe("openai");
    expect(settings.defaultModel).toBe("gpt-4o-mini");
  });

  it("changes no secrets and warns when secretStorage is missing", () => {
    const { settings, moved, warning } = migrateSettings(v2Data(), undefined);
    expect(moved).toBe(0);
    expect(warning).toMatch(/secure storage/i);
    expect(settings.openaiAPIKey).toBe("sk-openai-1");
    expect(settings.secrets).toEqual(v2Data().secrets);
  });

  it("keeps plaintext and loads when every storage read throws", () => {
    class ThrowingStore extends SecretStorage {
      getSecret(): string | null {
        throw new Error("storage unavailable");
      }
    }
    const { settings, moved } = migrateSettings(v2Data(), new ThrowingStore());
    expect(moved).toBe(0);
    expect(settings.settingsVersion).toBe(3);
    expect(settings.openaiAPIKey).toBe("sk-openai-1");
    expect(settings.secrets.map((s) => s.value)).toEqual([
      "tok-8",
      "tok-9",
      "",
    ]);
  });

  it("idempotent on second load", () => {
    const store = new SecretStorage();
    const first = migrateSettings(v2Data(), store);
    expect(first.moved).toBe(9);
    const storedAfterFirst = snapshot(store);

    const saved = JSON.parse(JSON.stringify(first.settings));
    const second = migrateSettings(saved, store);

    expect(second.moved).toBe(0);
    expect(second.changed).toBe(false);
    expect(second.warning).toBeUndefined();
    expect(second.settings).toEqual(first.settings);
    // Blank fields never clobber a stored secret with an empty string.
    expect(snapshot(store)).toEqual(storedAfterFirst);
    expect(store.getSecret("cannoli-key-openai")).toBe("sk-openai-1");
  });

  it("groq/azure become openai-compatible profiles", () => {
    const store = new SecretStorage();
    const { settings } = migrateSettings(
      {
        ...v2Data(),
        llmProvider: "groq",
        groqModel: "mixtral-8x7b-32768",
        azureBaseURL: "",
        azureOpenAIApiInstanceName: "my-instance",
        azureOpenAIApiDeploymentName: "my-deployment",
        azureOpenAIApiVersion: "2024-02-01",
      },
      store,
    );

    const byId = Object.fromEntries(settings.providers.map((p) => [p.id, p]));
    expect(byId.groq).toEqual({
      id: "groq",
      kind: "openai-compatible",
      baseURL: "https://api.groq.com/openai/v1",
      enabled: true,
      secretId: "cannoli-key-groq",
    });
    expect(byId.azure).toEqual({
      id: "azure",
      kind: "openai-compatible",
      // Azure's OpenAI-compatible v1 endpoint for the instance.
      baseURL: "https://my-instance.openai.azure.com/openai/v1",
      enabled: true,
      secretId: "cannoli-key-azure",
    });
    expect(byId.openai).toMatchObject({
      kind: "openai",
      secretId: "cannoli-key-openai",
    });
    // The explicit v2 choice is kept for the call role.
    expect(settings.models.call).toBe("groq:mixtral-8x7b-32768");
    // Legacy fields stay for the runtime.
    expect(settings.groqModel).toBe("mixtral-8x7b-32768");
    expect(settings.azureOpenAIApiVersion).toBe("2024-02-01");

    // azureBaseURL, when set, wins over the instance/deployment URL.
    const withBase = migrateSettings(
      { ...v2Data(), azureBaseURL: "https://proxy.example/azure" },
      new SecretStorage(),
    ).settings.providers.find((p) => p.id === "azure");
    expect(withBase?.baseURL).toBe("https://proxy.example/azure");

    // Neither: no baseURL is guessed.
    const neither = migrateSettings(
      {
        ...v2Data(),
        azureBaseURL: "",
        azureOpenAIApiInstanceName: "",
        azureOpenAIApiDeploymentName: "my-deployment",
      },
      new SecretStorage(),
    ).settings.providers.find((p) => p.id === "azure");
    expect(neither?.baseURL).toBeUndefined();
  });

  it("never overwrites a different stored secret", () => {
    // Another vault already keeps its own keys under the default ids.
    const store = new SecretStorage();
    store.setSecret("cannoli-key-openai", "other-vault-a");
    store.setSecret("cannoli-key-openai-2", "other-vault-b");
    store.setSecret("cannoli-secret-my-token", "other-vault-c");

    const { settings, moved } = migrateSettings(v2Data(), store);

    expect(store.getSecret("cannoli-key-openai")).toBe("other-vault-a");
    expect(store.getSecret("cannoli-key-openai-2")).toBe("other-vault-b");
    expect(store.getSecret("cannoli-key-openai-3")).toBe("sk-openai-1");
    expect(settings.providers.find((p) => p.id === "openai")?.secretId).toBe(
      "cannoli-key-openai-3",
    );
    expect(settings.openaiAPIKey).toBe("");

    expect(store.getSecret("cannoli-secret-my-token")).toBe("other-vault-c");
    const token = settings.secrets.find((s) => s.name === "MY_TOKEN");
    expect(token?.value).toBe("");
    expect(store.getSecret(token!.secretId!)).toBe("tok-8");
    expect(token!.secretId).not.toBe("cannoli-secret-my-token");
    // Every id is distinct, so "my token" did not land on MY_TOKEN's id.
    const ids = settings.secrets.map((s) => s.secretId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      store.getSecret(
        settings.secrets.find((s) => s.name === "my token")!.secretId!,
      ),
    ).toBe("tok-9");
    expect(moved).toBe(9);

    // The resolver follows the chosen ids, and a reload is a no-op.
    const second = migrateSettings(JSON.parse(JSON.stringify(settings)), store);
    expect(second.changed).toBe(false);
  });

  it("blanks without writing when the store already holds the same value", () => {
    const store = new SecretStorage();
    store.setSecret("cannoli-key-openai", "sk-openai-1");
    let writes = 0;
    const setSecret = store.setSecret.bind(store);
    store.setSecret = (id: string, value: string) => {
      if (id === "cannoli-key-openai") writes++;
      setSecret(id, value);
    };
    const { settings } = migrateSettings(v2Data(), store);
    expect(writes).toBe(0);
    expect(settings.openaiAPIKey).toBe("");
    expect(settings.providers.find((p) => p.id === "openai")?.secretId).toBe(
      "cannoli-key-openai",
    );
  });

  it("keeps a cleared user-secret choice cleared on reload", () => {
    const store = new SecretStorage();
    const first = migrateSettings(v2Data(), store);
    const saved = JSON.parse(JSON.stringify(first.settings));
    // The settings UI saves "" when the user clears the picker.
    saved.secrets[0].secretId = "";
    const second = migrateSettings(saved, store);
    expect(second.changed).toBe(false);
    expect(second.settings.secrets[0]).toEqual({
      name: "MY_TOKEN",
      value: "",
      visibility: "password",
      secretId: "",
    });
    // A legacy entry with no secretId key still gets one.
    expect(first.settings.secrets[2].secretId).toBe("cannoli-secret-empty");
  });

  it("an empty legacy user secret never binds to a stored credential", () => {
    const store = new SecretStorage();
    store.setSecret("cannoli-secret-my-token", "other-vault-token");
    const { settings } = migrateSettings(
      { secrets: [{ name: "MY_TOKEN", value: "", visibility: "password" }] },
      store,
    );
    const id = settings.secrets[0].secretId!;
    expect(id).toBeTruthy();
    expect(id).not.toBe("cannoli-secret-my-token");
    expect(store.getSecret(id) ?? "").toBe("");
    expect(store.getSecret("cannoli-secret-my-token")).toBe(
      "other-vault-token",
    );
  });

  it("loads defaults from malformed data without throwing", () => {
    const store = new SecretStorage();
    for (const raw of [null, "oops", 42, [1, 2], { secrets: "nope" }]) {
      const { settings } = migrateSettings(raw, store);
      expect(settings.settingsVersion).toBe(3);
      expect(settings.secrets).toEqual([]);
    }
    const v3 = migrateSettings(
      { settingsVersion: 3, providers: "bad", secrets: { a: 1 } },
      store,
    );
    expect(Array.isArray(v3.settings.secrets)).toBe(true);
    expect(Array.isArray(v3.settings.providers)).toBe(true);
  });

  it("new installs get the AI SDK engine, upgraders keep LangChain", () => {
    const store = new SecretStorage();
    expect(migrateSettings(null, store).settings.providerEngine).toBe("ai-sdk");

    const v2 = migrateSettings(v2Data(), store);
    expect(v2.settings.providerEngine).toBe("langchain");
    expect(v2.changed).toBe(true);

    const v3 = migrateSettings({ settingsVersion: 3, secrets: [] }, store);
    expect(v3.settings.providerEngine).toBe("langchain");
    expect(v3.changed).toBe(true);

    const chosen = migrateSettings(
      { ...v2.settings, providerEngine: "ai-sdk" },
      store,
    );
    expect(chosen.settings.providerEngine).toBe("ai-sdk");
    expect(chosen.changed).toBe(false);
  });
});
