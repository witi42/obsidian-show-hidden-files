import { Plugin, PluginSettingTab, Setting, App } from "obsidian";

/* ── Type augmentations for internal Obsidian APIs ─────────── */

declare module "obsidian" {
	interface Vault {
		getConfig(key: string): unknown;
		setConfig(key: string, value: unknown): void;
	}
}

/** Internal adapter methods that exist at runtime but aren't typed. */
interface PrivateAdapter {
	_exists(fullPath: string, path: string): Promise<boolean>;
	getFullPath(path: string): string;
	getFullRealPath(realPath: string): string;
	getRealPath(path: string): string;
	listRecursive(path: string): Promise<void>;
	reconcileDeletion(realPath: string, path: string): Promise<void>;
	reconcileFileInternal?(realPath: string, path: string): Promise<void>;
	reconcileFolderCreation(realPath: string, path: string): Promise<void>;
}

/* ── Settings ──────────────────────────────────────────────── */

interface ShowHiddenFilesSettings {
	showAllFileTypes: boolean;
	showHiddenFiles: boolean;
}

const DEFAULT_SETTINGS: ShowHiddenFilesSettings = {
	showAllFileTypes: true,
	showHiddenFiles: true,
};

/** Obsidian internal directories that should never be exposed. */
const EXCLUDED_DOTDIRS = new Set([".obsidian", ".trash"]);

/** Check if the first segment of a path is a dotfile/dotfolder. */
function isHiddenPath(path: string): boolean {
	const segments = path.split("/");
	return segments.some(
		(s) => s.startsWith(".") && !EXCLUDED_DOTDIRS.has(s),
	);
}

/* ── Plugin ────────────────────────────────────────────────── */

export default class ShowHiddenFilesPlugin extends Plugin {
	settings!: ShowHiddenFilesSettings;
	private previousShowUnsupportedFiles = false;
	private originalReconcileDeletion:
		| PrivateAdapter["reconcileDeletion"]
		| null = null;
	private originalI18nT: ((...args: unknown[]) => string) | null = null;
	private hiddenPaths = new Set<string>();

	async onload() {
		await this.loadSettings();

		this.previousShowUnsupportedFiles =
			(this.app.vault.getConfig("showUnsupportedFiles") as boolean) ??
			false;

		this.applyShowAllFileTypes();

		this.app.workspace.onLayoutReady(async () => {
			if (this.settings.showHiddenFiles) {
				this.patchAdapter();
				this.suppressDotfileWarning();
				await this.rescanVault();
			}
		});

		this.addSettingTab(new ShowHiddenFilesSettingTab(this.app, this));
	}

	onunload() {
		this.restoreAdapter();
		this.restoreDotfileWarning();
		this.app.vault.setConfig(
			"showUnsupportedFiles",
			this.previousShowUnsupportedFiles,
		);
	}

	/* ── settings persistence ──────────────────────────────── */

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/* ── show all file types ───────────────────────────────── */

	applyShowAllFileTypes() {
		this.app.vault.setConfig(
			"showUnsupportedFiles",
			this.settings.showAllFileTypes,
		);
	}

	/* ── show hidden files — adapter monkey-patch ──────────── */

	private adapter(): PrivateAdapter {
		return this.app.vault.adapter as unknown as PrivateAdapter;
	}

	private patchAdapter() {
		const adapter = this.adapter();

		if (this.originalReconcileDeletion) return; // already patched
		this.originalReconcileDeletion =
			adapter.reconcileDeletion.bind(adapter);

		const origReconcileDeletion = this.originalReconcileDeletion;

		adapter.reconcileDeletion = async (
			realPath: string,
			path: string,
		) => {
			if (
				this.settings.showHiddenFiles &&
				isHiddenPath(path)
			) {
				// File exists on disk — re-register it instead of deleting
				const fullPath = adapter.getFullPath(path);
				if (await adapter._exists(fullPath, path)) {
					this.hiddenPaths.add(path);
					await this.showFile(path);
					return;
				}
				this.hiddenPaths.delete(path);
			}
			return origReconcileDeletion(realPath, path);
		};
	}

	private restoreAdapter() {
		if (this.originalReconcileDeletion) {
			const adapter = this.adapter();
			adapter.reconcileDeletion = this.originalReconcileDeletion;
			this.originalReconcileDeletion = null;

			// Hide all files we previously revealed
			for (const path of this.hiddenPaths) {
				adapter.reconcileDeletion(adapter.getRealPath(path), path);
			}
			this.hiddenPaths.clear();
		}
	}

	/** Re-register a dotfile/dotfolder with the vault. */
	private async showFile(path: string): Promise<void> {
		const adapter = this.adapter();
		const realPath = adapter.getRealPath(path);

		if (adapter.reconcileFileInternal) {
			await adapter.reconcileFileInternal(realPath, path);
		}
	}

	/** Hide a previously shown dotfile. */
	private async hideFile(path: string): Promise<void> {
		const adapter = this.adapter();
		if (this.originalReconcileDeletion) {
			await this.originalReconcileDeletion(
				adapter.getRealPath(path),
				path,
			);
		}
	}

	/** Trigger a full vault rescan so all dotfiles hit our patched reconcileDeletion. */
	private async rescanVault(): Promise<void> {
		await this.adapter().listRecursive("");
	}

	/** Enable hidden files — patch + rescan. */
	async enableHiddenFiles(): Promise<void> {
		this.patchAdapter();
		this.suppressDotfileWarning();
		await this.rescanVault();
	}

	/** Disable hidden files — hide all revealed files + restore. */
	async disableHiddenFiles(): Promise<void> {
		// Hide all currently visible dotfiles before restoring
		for (const path of this.hiddenPaths) {
			await this.hideFile(path);
		}
		this.hiddenPaths.clear();
		this.restoreAdapter();
		this.restoreDotfileWarning();
	}

	/* ── suppress the "bad dotfile" warning ────────────────── */

	private suppressDotfileWarning() {
		const win = self as unknown as {
			i18next?: { t: (...args: unknown[]) => string };
		};
		if (!win.i18next || this.originalI18nT) return;

		this.originalI18nT = win.i18next.t.bind(win.i18next);
		const origT = this.originalI18nT;

		win.i18next.t = function (...args: unknown[]): string {
			if (args[0] === "plugins.file-explorer.msg-bad-dotfile") {
				return "";
			}
			return origT(...args);
		};
	}

	private restoreDotfileWarning() {
		if (this.originalI18nT) {
			const win = self as unknown as {
				i18next?: { t: (...args: unknown[]) => string };
			};
			if (win.i18next) {
				win.i18next.t = this.originalI18nT;
			}
			this.originalI18nT = null;
		}
	}
}

/* ── Settings tab ──────────────────────────────────────────── */

class ShowHiddenFilesSettingTab extends PluginSettingTab {
	plugin: ShowHiddenFilesPlugin;

	constructor(app: App, plugin: ShowHiddenFilesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Show all file types")
			.setDesc(
				"Show files with unsupported extensions in the file explorer. " +
					'Synced with Obsidian\'s native "Detect all file extensions" setting.',
			)
			.addToggle((toggle) => {
				const current =
					(this.app.vault.getConfig(
						"showUnsupportedFiles",
					) as boolean) ?? false;
				toggle.setValue(current).onChange(async (value) => {
					this.plugin.settings.showAllFileTypes = value;
					await this.plugin.saveSettings();
					this.plugin.applyShowAllFileTypes();
				});
			});

		new Setting(containerEl)
			.setName("Show hidden files")
			.setDesc(
				"Show files and folders whose names start with a dot (e.g. .gitignore, .env).",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showHiddenFiles)
					.onChange(async (value) => {
						this.plugin.settings.showHiddenFiles = value;
						await this.plugin.saveSettings();
						if (value) {
							await this.plugin.enableHiddenFiles();
						} else {
							await this.plugin.disableHiddenFiles();
						}
					}),
			);
	}
}
