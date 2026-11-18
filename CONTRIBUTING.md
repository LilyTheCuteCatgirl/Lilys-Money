# Contributing to Lily's Money

Thanks for helping with Lily's Money! Bug fixes, improvements, and new features are welcome.

## What you need

- Node.js 20 or newer, with npm
- VS Code or another code editor
- GitHub Desktop, if you prefer not to use Git commands
- Minecraft Bedrock for in-game testing

The watch commands are set up for Minecraft Bedrock on Windows. Linting, tests, and building can run without Minecraft installed.

## Set up your fork

1. Click **Fork** on the [Lily's Money repository](https://github.com/LilyTheCuteCatgirl/Lilys-Money).
2. Open GitHub Desktop and clone your fork with **File > Clone repository**.
3. Use **Current branch > New branch** to create a branch for your change.
4. Open the project in VS Code.
5. Open the VS Code terminal and install dependencies:

```powershell
npm ci
```

## Working on the add-on

Edit the complete packs directly:

- `addon/bp/` contains the behavior pack, including scripts and `manifest.json`.
- `addon/rp/` contains the resource pack, including UI, textures, and `manifest.json`.
- `tools/` contains the npm scripts and tests.

Start watch mode with:

```powershell
npm run watch
```

It copies both packs into Minecraft's development-pack folders and syncs changes when you save. It replaces the existing `LilysMoney_BP_DEV` and `LilysMoney_RP_DEV` folders, so don't keep edits inside those deployed copies. Use Ctrl+C to stop watching.

For Minecraft Preview, run `npm run watch:preview` instead. Some changes may require `/reload` or reopening your world before they appear in-game.

## Check your changes

Run these commands before opening a pull request:

```powershell
npm run lint
npm run validate
npm run test
npm run build
```

If lint reports formatting problems, run `npm run lint:fix`, then check the changed files in GitHub Desktop. Test gameplay changes in a backup Minecraft world as well.

## A few things to keep in mind

- Keep changes focused. If you only fix a bug, avoid unrelated rewrites.
- Do not change pack UUIDs, scoreboard names, or saved-data formats without discussing compatibility first.
- Keep existing author, contributor, copyright, and third-party credits.
- Only submit code and assets you have permission to contribute.
- For larger changes, opening an issue first can help avoid working on the same thing twice.

Contributors are credited through GitHub's history and in [CONTRIBUTORS.md](CONTRIBUTORS.md) ALWAYS
