import { SecretComponent, Setting } from "obsidian";
import Cannoli from "src/main";
import { KeyField, secretIdFor, selectSecretFor } from "src/secrets/migrate";

/**
 * A setting row that picks a secret from Obsidian's SecretStorage. Only the
 * chosen secret's id is saved in the plugin's settings, never its value.
 */
export function addSecretSetting(
  containerEl: HTMLElement,
  plugin: Cannoli,
  field: KeyField,
  name: string,
  desc: string,
  onChanged?: () => void,
): Setting {
  return new Setting(containerEl)
    .setName(name)
    .setDesc(desc)
    .addComponent((el) =>
      new SecretComponent(plugin.app, el)
        .setValue(secretIdFor(plugin.settings, field))
        .onChange(async (id) => {
          selectSecretFor(plugin.settings, field, id ?? "");
          await plugin.saveSettings();
          onChanged?.();
        }),
    );
}
