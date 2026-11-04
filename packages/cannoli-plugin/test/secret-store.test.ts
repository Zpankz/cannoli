import { describe, expect, it } from "vitest";
import {
  migrateSettings,
  selectSecretFor,
  selectUserSecret,
  setSecretIdFor,
} from "../src/secrets/migrate";
import { ObsidianSecretResolver } from "../src/secrets/secret-store";
import { SecretStorage } from "./mocks/obsidian";

function setup() {
  const store = new SecretStorage();
  const { settings } = migrateSettings(
    {
      llmProvider: "openai",
      openaiAPIKey: "sk-1",
      exaAPIKey: "exa-2",
      secrets: [
        { name: "TOKEN", value: "tok-3", visibility: "password" },
        { name: "OPENAI_API_KEY", value: "override-4", visibility: "password" },
      ],
    },
    store,
  );
  return {
    store,
    settings,
    resolver: new ObsidianSecretResolver(store, () => settings),
  };
}

describe("ObsidianSecretResolver", () => {
  it("reads migrated keys and user secrets from the store", () => {
    const { resolver, settings } = setup();
    expect(settings.openaiAPIKey).toBe("");
    expect(resolver.openaiKey).toBe("sk-1");
    expect(resolver.providerKey("openai")).toBe("sk-1");
    expect(resolver.providerKey("ollama")).toBe("");
    expect(resolver.get("TOKEN")).toBe("tok-3");
    expect(resolver.get("EXA_API_KEY")).toBe("exa-2");
    expect(resolver.get("VALTOWN_API_KEY")).toBeNull();
    // User secrets override built-ins, as the old record spread did.
    expect(resolver.get("OPENAI_API_KEY")).toBe("override-4");
    expect(resolver.names().sort()).toEqual(
      ["EXA_API_KEY", "OPENAI_API_KEY", "TOKEN"].sort(),
    );
  });

  it("names() lists only secrets with a non-empty stored value", () => {
    const { store, settings, resolver } = setup();
    settings.secrets.push({
      name: "UNSET",
      value: "",
      visibility: "password",
      secretId: "cannoli-secret-unset",
    });
    store.setSecret("cannoli-secret-token", "");
    expect(resolver.names()).not.toContain("UNSET");
    expect(resolver.names()).not.toContain("TOKEN");
    expect(resolver.names()).toContain("EXA_API_KEY");
  });

  it("the last user secret with a duplicate name wins", () => {
    const store = new SecretStorage();
    const { settings } = migrateSettings(
      {
        secrets: [
          { name: "DUP", value: "first-1", visibility: "password" },
          { name: "DUP", value: "second-2", visibility: "password" },
        ],
      },
      store,
    );
    const resolver = new ObsidianSecretResolver(store, () => settings);
    expect(resolver.get("DUP")).toBe("second-2");
  });

  it("a picker change overrides a kept plaintext fallback", () => {
    const store = new SecretStorage();
    store.setSecret("picked-key", "picked-1");
    store.setSecret("picked-token", "picked-2");
    // Plaintext the migration kept because the store write failed.
    const { settings } = migrateSettings(
      {
        openaiAPIKey: "old-plain",
        secrets: [{ name: "TOKEN", value: "old-tok", visibility: "password" }],
      },
      undefined,
    );
    const resolver = new ObsidianSecretResolver(store, () => settings);
    expect(resolver.openaiKey).toBe("old-plain");
    expect(resolver.get("TOKEN")).toBe("old-tok");

    selectSecretFor(settings, "openaiAPIKey", "picked-key");
    selectUserSecret(settings.secrets[0], "picked-token");
    expect(resolver.openaiKey).toBe("picked-1");
    expect(resolver.get("TOKEN")).toBe("picked-2");

    // Clearing the picker leaves no key, not the old plaintext.
    selectSecretFor(settings, "openaiAPIKey", "");
    expect(resolver.openaiKey).toBe("");
  });

  it("a cleared secret choice resolves to no key and survives a reload", () => {
    const { store, settings } = setup();
    setSecretIdFor(settings, "openaiAPIKey", "");
    const reloaded = migrateSettings(
      JSON.parse(JSON.stringify(settings)),
      store,
    );
    expect(reloaded.changed).toBe(false);
    const resolver = new ObsidianSecretResolver(store, () => reloaded.settings);
    expect(resolver.providerKey("openai")).toBe("");
    // The stored secret itself is untouched.
    expect(store.getSecret("cannoli-key-openai")).toBe("sk-1");
  });
});
