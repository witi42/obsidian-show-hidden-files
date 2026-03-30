# Show Hidden Files — Obsidian Plugin

Reveals hidden dotfiles (`.claude`, `.gitignore`, `.env`, `.github/`, etc.) and all file types directly in the Obsidian file explorer.

## Features

- **Show all file types** — Exposes files with unsupported extensions (`.json`, `.yml`, `.toml`, etc.) in the file explorer. Synced with Obsidian's native "Detect all file extensions" setting.
- **Show hidden files** — Shows files and folders whose names start with a dot, which Obsidian hides by default.

Both settings are **enabled by default** when the plugin is activated and **fully reverted** when the plugin is disabled.

> **Note:** Enabling this plugin exposes sensitive dotfiles (`.env`, `.git-credentials`, etc.) in the Obsidian file explorer, making them viewable, editable, and deletable. Make sure you understand what these files are before modifying them.

## Installation

### From Community Plugins (recommended)

1. Open **Settings → Community plugins → Browse**
2. Search for **Show Hidden Files**
3. Click **Install**, then **Enable**

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` (if present) from the [latest release](https://github.com/witi42/obsidian-show-hidden-files/releases/latest).
2. Create the folder `.obsidian/plugins/show-hidden-files/` inside your vault.
3. Copy the downloaded files into that folder.
4. Open **Settings → Community plugins**, refresh the list, and enable **Show Hidden Files**.

### BRAT

Install via [BRAT](https://github.com/TfTHacker/obsidian42-brat) with the repo URL:

```
witi42/obsidian-show-hidden-files
```

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Show all file types | On | Toggle unsupported file extensions in the explorer. Mirrors Obsidian's native "Detect all file extensions" option. |
| Show hidden files | On | Toggle dotfiles and dotfolders in the explorer. `.obsidian` and `.trash` are always excluded. |

## Building from source

```bash
git clone https://github.com/witi42/obsidian-show-hidden-files.git
cd obsidian-show-hidden-files
npm install
npm run build
```

This produces `main.js` in the project root. Copy it along with `manifest.json` into your vault's plugin folder to test.

For development with hot-reload:

```bash
npm run dev
```

## How it works

- **Show all file types** uses Obsidian's internal `vault.setConfig('showUnsupportedFiles', …)` API to toggle the native setting programmatically.
- **Show hidden files** intercepts the vault adapter's `reconcileDeletion` method — when Obsidian tries to hide a dotfile, the plugin re-registers it instead. A full vault rescan via `listRecursive` triggers discovery of all dotfiles on startup.
- On disable, both settings are restored to their previous values and all revealed dotfiles are hidden again.

## Compatibility

- **Desktop only** — relies on Node.js filesystem APIs for dotfile discovery.
- Requires Obsidian **v0.15.0+**.

## License

[MIT](LICENSE)
