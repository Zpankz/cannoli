// In-memory stand-ins for the parts of the Obsidian API the plugin's unit tests touch.
// The real "obsidian" package ships types only, so vitest aliases it to this file.

/** SecretStorage held in a Map, with the real API's id validation. */
export class SecretStorage {
  private readonly values = new Map<string, string>();

  setSecret(id: string, secret: string): void {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid secret id: ${id}`);
    this.values.set(id, secret);
  }

  getSecret(id: string): string | null {
    return this.values.has(id) ? (this.values.get(id) as string) : null;
  }

  listSecrets(): string[] {
    return [...this.values.keys()];
  }
}

/** Every Notice shown, in order. */
export const notices: { message: string; duration?: number }[] = [];

export class Notice {
  constructor(message: string, duration?: number) {
    notices.push({ message, duration });
  }
  hide(): void {}
}

export class Plugin {
  async loadData(): Promise<unknown> {
    return null;
  }
  async saveData(_data: unknown): Promise<void> {}
}
