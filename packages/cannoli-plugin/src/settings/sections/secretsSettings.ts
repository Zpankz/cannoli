import { Notice, SecretComponent, Setting } from "obsidian";
import Cannoli from "src/main";
import { selectUserSecret } from "src/secrets/migrate";

export function createSecretsSettings(
  containerEl: HTMLElement,
  plugin: Cannoli,
  display: () => void,
): void {
  containerEl.createEl("h1", { text: "Secrets" });

  new Setting(containerEl)
    .setName("Secrets")
    .setDesc(
      `These secrets will be available in all of your cannolis, using "{{secret name}}". Each one points at a secret in Obsidian's secret storage; the value is not stored in the canvas or in the plugin's settings, and will not be included when you bake a cannoli.`,
    )
    .addButton((button) =>
      button.setButtonText("+ Secret").onClick(async () => {
        // Create a new secret object
        const newSecret = {
          name: "",
          value: "",
          visibility: "password",
        };
        plugin.settings.secrets.push(newSecret);
        await plugin.saveSettings();
        // Refresh the settings pane to reflect the changes
        display();
      }),
    );

  // Iterate through saved secrets and display them
  for (const secret of plugin.settings.secrets) {
    new Setting(containerEl)
      .addText((text) =>
        text
          .setValue(secret.name)
          .setPlaceholder("Secret Name")
          .onChange(async (value) => {
            secret.name = value;
            await plugin.saveSettings();
          }),
      )
      .addComponent((el) =>
        new SecretComponent(plugin.app, el)
          .setValue(secret.secretId ?? "")
          .onChange(async (id) => {
            selectUserSecret(secret, id ?? "");
            await plugin.saveSettings();
          }),
      )
      .addButton((button) =>
        button
          .setButtonText("📋")
          .setTooltip("Copy to clipboard")
          .onClick(async () => {
            await navigator.clipboard.writeText(
              secret.value || plugin.secretStore.getKey(secret.secretId),
            );
            new Notice("Secret value copied to clipboard");
          }),
      )
      .addButton((button) =>
        button
          .setButtonText("Delete")
          .setWarning()
          .onClick(async () => {
            const index = plugin.settings.secrets.indexOf(secret);
            if (index > -1) {
              plugin.settings.secrets.splice(index, 1);
              await plugin.saveSettings();
              // Refresh the settings pane to reflect the changes
              display();
            }
          }),
      );
  }
}
