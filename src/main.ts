import { lstat, readdir } from "fs/promises";
import type { Dirent } from "fs";
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
	ignoredHiddenPaths: string;
}

const DEFAULT_IGNORED_HIDDEN_PATHS = [".git", ".hg", ".svn", ".DS_Store"].join(
	"\n",
);

const DEFAULT_SETTINGS: ShowHiddenFilesSettings = {
	showAllFileTypes: true,
	showHiddenFiles: true,
	ignoredHiddenPaths: DEFAULT_IGNORED_HIDDEN_PATHS,
};

/** Obsidian internal directories that should never be exposed. */
const ALWAYS_EXCLUDED = new Set([".trash"]);

function normalizeVaultPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function splitVaultPath(path: string): string[] {
	const normalizedPath = normalizeVaultPath(path);
	return normalizedPath ? normalizedPath.split("/") : [];
}

function parseIgnoredHiddenPaths(value: string): string[] {
	return value
		.split(/[\n,]/)
		.map((path) => normalizeVaultPath(path.trim()))
		.filter((path) => path.length > 0 && !path.startsWith("#"));
}

function isAlwaysExcludedPath(path: string, configDir: string): boolean {
	const normalizedPath = normalizeVaultPath(path);
	const configDirPath = normalizeVaultPath(configDir);

	if (
		configDirPath &&
		(normalizedPath === configDirPath ||
			normalizedPath.startsWith(`${configDirPath}/`))
	) {
		return true;
	}

	return splitVaultPath(normalizedPath).some((segment) =>
		ALWAYS_EXCLUDED.has(segment),
	);
}

/** Check if any segment of a path is a dotfile/dotfolder (excluding vault config dir and .trash). */
function isHiddenPath(path: string, configDir: string): boolean {
	const segments = splitVaultPath(path);
	return (
		!isAlwaysExcludedPath(path, configDir) &&
		segments.some((s) => s.startsWith("."))
	);
}

function matchesIgnoredPath(path: string, ignoredPath: string): boolean {
	const normalizedPath = normalizeVaultPath(path);
	const normalizedIgnoredPath = normalizeVaultPath(ignoredPath);

	if (!normalizedPath || !normalizedIgnoredPath) return false;

	if (normalizedIgnoredPath.includes("/")) {
		return (
			normalizedPath === normalizedIgnoredPath ||
			normalizedPath.startsWith(`${normalizedIgnoredPath}/`)
		);
	}

	return splitVaultPath(normalizedPath).includes(normalizedIgnoredPath);
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
	private hiddenFilesRefreshTimer: number | null = null;

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
				await this.refreshHiddenFiles();
			}
		});

		this.addSettingTab(new ShowHiddenFilesSettingTab(this.app, this));
	}

	onunload() {
		this.clearHiddenFilesRefreshTimer();
		void this.restoreAdapter();
		this.restoreDotfileWarning();
		this.app.vault.setConfig(
			"showUnsupportedFiles",
			this.previousShowUnsupportedFiles,
		);
	}

	/* ── settings persistence ──────────────────────────────── */

	async loadSettings() {
		const loaded = (await this.loadData()) as Partial<ShowHiddenFilesSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
		if (typeof this.settings.ignoredHiddenPaths !== "string") {
			this.settings.ignoredHiddenPaths = DEFAULT_IGNORED_HIDDEN_PATHS;
		}
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

	private ignoredHiddenPaths(): string[] {
		return parseIgnoredHiddenPaths(this.settings.ignoredHiddenPaths);
	}

	private shouldSkipPath(path: string): boolean {
		const normalizedPath = normalizeVaultPath(path);

		if (isAlwaysExcludedPath(normalizedPath, this.app.vault.configDir)) {
			return true;
		}

		return this.ignoredHiddenPaths().some((ignoredPath) =>
			matchesIgnoredPath(normalizedPath, ignoredPath),
		);
	}

	private shouldRevealHiddenPath(path: string): boolean {
		const normalizedPath = normalizeVaultPath(path);

		return (
			isHiddenPath(normalizedPath, this.app.vault.configDir) &&
			!this.shouldSkipPath(normalizedPath)
		);
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
			const normalizedPath = normalizeVaultPath(path);
			if (
				this.settings.showHiddenFiles &&
				this.shouldRevealHiddenPath(normalizedPath)
			) {
				// File exists on disk — re-register it instead of deleting
				const fullPath = adapter.getFullPath(normalizedPath);
				if (await adapter._exists(fullPath, normalizedPath)) {
					await this.showPath(normalizedPath);
					return;
				}
				this.hiddenPaths.delete(normalizedPath);
			}
			return origReconcileDeletion(realPath, path);
		};
	}

	private async restoreAdapter(): Promise<void> {
		if (this.originalReconcileDeletion) {
			const adapter = this.adapter();
			adapter.reconcileDeletion = this.originalReconcileDeletion;
			this.originalReconcileDeletion = null;

			// Hide all files we previously revealed
			for (const path of this.trackedHiddenPathsByDepthDesc()) {
				await adapter.reconcileDeletion(adapter.getRealPath(path), path);
			}
			this.hiddenPaths.clear();
		}
	}

	/** Re-register a dotfile/dotfolder with the vault. */
	private async showPath(path: string, isFolder?: boolean): Promise<void> {
		const normalizedPath = normalizeVaultPath(path);
		if (!this.shouldRevealHiddenPath(normalizedPath)) return;

		const adapter = this.adapter();
		const realPath = adapter.getRealPath(normalizedPath);
		const shouldCreateFolder =
			isFolder ?? (await this.pathIsDirectory(normalizedPath));

		if (shouldCreateFolder) {
			await adapter.reconcileFolderCreation(realPath, normalizedPath);
			this.hiddenPaths.add(normalizedPath);
			return;
		}

		if (!adapter.reconcileFileInternal) return;

		await adapter.reconcileFileInternal(realPath, normalizedPath);
		this.hiddenPaths.add(normalizedPath);
	}

	/** Hide a previously shown dotfile. */
	private async hideFile(path: string): Promise<void> {
		const normalizedPath = normalizeVaultPath(path);
		const adapter = this.adapter();
		if (this.originalReconcileDeletion) {
			await this.originalReconcileDeletion(
				adapter.getRealPath(normalizedPath),
				normalizedPath,
			);
		}
	}

	private async pathIsDirectory(path: string): Promise<boolean> {
		try {
			const stat = await lstat(this.adapter().getFullPath(path));
			return stat.isDirectory();
		} catch {
			return false;
		}
	}

	private trackedHiddenPathsByDepthDesc(): string[] {
		return Array.from(this.hiddenPaths).sort(
			(left, right) =>
				splitVaultPath(right).length - splitVaultPath(left).length,
		);
	}

	private async hideSkippedTrackedPaths(): Promise<void> {
		for (const path of this.trackedHiddenPathsByDepthDesc()) {
			if (!this.shouldRevealHiddenPath(path)) {
				await this.hideFile(path);
				this.hiddenPaths.delete(path);
			}
		}
	}

	private async revealHiddenPathsFromDisk(folderPath: string): Promise<void> {
		let entries: Dirent[];

		try {
			entries = await readdir(this.adapter().getFullPath(folderPath), {
				withFileTypes: true,
			});
		} catch {
			return;
		}

		for (const entry of entries) {
			const path = normalizeVaultPath(
				folderPath ? `${folderPath}/${entry.name}` : entry.name,
			);

			if (!path || this.shouldSkipPath(path)) continue;

			const isDirectory = entry.isDirectory();

			if (this.shouldRevealHiddenPath(path)) {
				await this.showPath(path, isDirectory);
			}

			if (isDirectory) {
				await this.revealHiddenPathsFromDisk(path);
			}
		}
	}

	/** Trigger a full vault refresh and directly discover nested hidden paths. */
	private async refreshHiddenFiles(): Promise<void> {
		await this.hideSkippedTrackedPaths();
		await this.adapter().listRecursive("");
		await this.revealHiddenPathsFromDisk("");
		await this.hideSkippedTrackedPaths();
	}

	/** Enable hidden files — patch + rescan. */
	async enableHiddenFiles(): Promise<void> {
		this.patchAdapter();
		this.suppressDotfileWarning();
		await this.refreshHiddenFiles();
	}

	/** Disable hidden files — hide all revealed files + restore. */
	async disableHiddenFiles(): Promise<void> {
		this.clearHiddenFilesRefreshTimer();
		// Hide all currently visible dotfiles before restoring
		for (const path of this.trackedHiddenPathsByDepthDesc()) {
			await this.hideFile(path);
		}
		this.hiddenPaths.clear();
		await this.restoreAdapter();
		this.restoreDotfileWarning();
	}

	scheduleHiddenFilesRefresh(): void {
		if (!this.settings.showHiddenFiles) return;

		this.clearHiddenFilesRefreshTimer();
		this.hiddenFilesRefreshTimer = window.setTimeout(() => {
			this.hiddenFilesRefreshTimer = null;
			void this.refreshHiddenFiles();
		}, 500);
	}

	private clearHiddenFilesRefreshTimer(): void {
		if (this.hiddenFilesRefreshTimer === null) return;

		window.clearTimeout(this.hiddenFilesRefreshTimer);
		this.hiddenFilesRefreshTimer = null;
	}

	/* ── suppress the "bad dotfile" warning ────────────────── */

	private suppressDotfileWarning() {
		const win = window as unknown as {
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
			const win = window as unknown as {
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
				"Show files and folders whose names start with a dot, including nested hidden paths.",
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

		new Setting(containerEl)
			.setName("Ignored hidden paths")
			.setDesc(
				"One name or vault-relative path per line. Names match any segment; paths match that item and all of its children. The vault config folder and .trash are always ignored.",
			)
			.addTextArea((text) => {
				text
					.setPlaceholder(".git\n.DS_Store\nsome-folder/.env")
					.setValue(this.plugin.settings.ignoredHiddenPaths)
					.onChange(async (value) => {
						this.plugin.settings.ignoredHiddenPaths = value;
						await this.plugin.saveSettings();
						this.plugin.scheduleHiddenFilesRefresh();
					});
				text.inputEl.rows = 6;
			});
	}
}
