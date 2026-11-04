import type {
  SecretResolver,
  SupportedProviders,
} from "@deablabs/cannoli-core";
import type { CannoliSettings } from "../settings/settings";
import {
  KEY_FIELD_FOR_PROFILE,
  KeyField,
  PROFILE_FOR_PROVIDER,
  SecretStorageLike,
  secretIdFor,
} from "./migrate";

/**
 * Secrets for runs and plugin features, read from Obsidian's SecretStorage
 * through the ids stored on the current settings.
 *
 * A legacy plaintext field wins only while it is still non-empty, which happens
 * only when migration could not move it (no SecretStorage, or the read-back
 * did not match).
 */
export class ObsidianSecretResolver implements SecretResolver {
  constructor(
    private readonly store: SecretStorageLike | undefined,
    private readonly settings: () => CannoliSettings,
  ) {}

  /** The value stored under a SecretStorage id, or "" when unset. */
  getKey(id: string | undefined): string {
    if (!id || !this.store) return "";
    return this.store.getSecret(id) ?? "";
  }

  /** The value of a v2 key field, wherever it lives now. */
  getField(field: KeyField): string {
    const settings = this.settings();
    const plaintext = settings[field];
    if (typeof plaintext === "string" && plaintext !== "") return plaintext;
    return this.getKey(secretIdFor(settings, field));
  }

  /** The API key for a v2 provider, or "" (ollama has none). */
  providerKey(provider: SupportedProviders): string {
    const field = KEY_FIELD_FOR_PROFILE[PROFILE_FOR_PROVIDER[provider]];
    return field ? this.getField(field) : "";
  }

  get openaiKey(): string {
    return this.getField("openaiAPIKey");
  }
  get exaKey(): string {
    return this.getField("exaAPIKey");
  }
  get valTownKey(): string {
    return this.getField("valTownAPIKey");
  }
  get cannoliServerSecret(): string {
    return this.getField("cannoliServerSecret");
  }

  private builtIns(): [string, string][] {
    return [
      ["OPENAI_API_KEY", this.openaiKey],
      ["EXA_API_KEY", this.exaKey],
      ["VALTOWN_API_KEY", this.valTownKey],
    ];
  }

  private userSecret(name: string): string | null {
    // The last entry with a name wins, as the old record reduction did.
    const secrets = this.settings().secrets;
    let entry: (typeof secrets)[number] | undefined;
    for (let i = secrets.length - 1; i >= 0 && !entry; i--) {
      if (secrets[i].name === name) entry = secrets[i];
    }
    if (!entry) return null;
    return entry.value || this.getKey(entry.secretId);
  }

  get(name: string): string | null {
    // User secrets override the built-ins, as the old record spread did.
    const user = this.userSecret(name);
    if (user !== null) return user;
    const builtIn = this.builtIns().find(([n]) => n === name);
    return builtIn && builtIn[1] ? builtIn[1] : null;
  }

  /** Every name that currently resolves to a non-empty value. */
  names(): string[] {
    const names: string[] = [];
    const candidates = [
      ...this.builtIns().map(([name]) => name),
      ...this.settings().secrets.map(({ name }) => name),
    ];
    for (const name of candidates) {
      if (!names.includes(name) && this.get(name)) names.push(name);
    }
    return names;
  }
}
