import ThumbyPlugin from "main";
import { App, PluginSettingTab, Setting } from "obsidian";

export default class ThumbySettingTab extends PluginSettingTab {
	plugin: ThumbyPlugin;

	constructor(app: App, plugin: ThumbyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();
		containerEl.createEl('h2', { text: 'Youtube Info Settings' });

		new Setting(containerEl)
			.setName('YouTube API Key (optional)')
			.setDesc('An API Key for the YouTube Data API')
			.addExtraButton((btn) =>
				btn
					.setIcon('info')
					//@ts-ignore
					.setTooltip('this plugin will use the API as a backup.', {placement: 'top'})
					.setDisabled(true)
			)
			.addText((text) =>
				text
					.setValue(this.plugin.settings.youtubeApiKey)
					.onChange(async (value) => {
						this.plugin.settings.youtubeApiKey = value;
						await this.plugin.saveSettings();
					})
			);

	}
}
