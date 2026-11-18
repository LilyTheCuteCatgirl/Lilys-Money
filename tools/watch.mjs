import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ADDON, BP, RP, minecraftRoot, syncDevelopmentPacks } from "./project.mjs";

function parseArgs(argv) {
    const options = { preview: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--preview") options.preview = true;
        else if (argv[i] === "--minecraft-path" && argv[i + 1]) options.override = argv[++i];
        else throw new Error(`Unknown or incomplete option: ${argv[i]}`);
    }
    return options;
}

/** Content fingerprint avoids duplicate syncs caused by duplicate or noisy filesystem events. */
function fileFingerprint() {
    const hash = crypto.createHash("sha256");
    function visit(dir) {
        for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const file = path.join(dir, item.name);
            hash.update(path.relative(ADDON, file).replaceAll("\\", "/") + "\0");
            if (item.isDirectory()) visit(file);
            else if (item.isFile()) hash.update(fs.readFileSync(file));
        }
    }
    visit(BP);
    visit(RP);
    return hash.digest("hex");
}

let watcher;
let timer;
try {
    const options = parseArgs(process.argv.slice(2));
    const mcRoot = minecraftRoot(options);
    if (!fs.existsSync(mcRoot) || !fs.statSync(mcRoot).isDirectory()) {
        throw new Error(`Minecraft com.mojang folder not found: ${mcRoot}\nOpen Minecraft first, or use --minecraft-path <folder>.`);
    }
    let lastSyncedFingerprint;
    function synchronize() {
        try {
            const fingerprint = fileFingerprint();
            if (fingerprint === lastSyncedFingerprint) return;
            const destinations = syncDevelopmentPacks(mcRoot);
            lastSyncedFingerprint = fingerprint;
            console.log(`Synced BP + RP (${new Date().toLocaleTimeString()})`);
            return destinations;
        } catch (error) {
            // No retry loop or automatic log spam; next saved change will trigger another attempt.
            console.error(`Sync failed: ${error.message}`);
        }
    }
    function scheduleSync() {
        clearTimeout(timer);
        timer = setTimeout(synchronize, 350);
    }

    // Watch ONLY addon/; syncing into AppData can't trigger a source change.
    watcher = fs.watch(ADDON, { recursive: true }, scheduleSync);
    watcher.on("error", (error) => console.error(`Watch error: ${error.message}`));
    console.log(`Watching ${ADDON}`);
    console.log(`Minecraft: ${mcRoot}`);
    console.log("Existing Lily's Money development packs will be replaced. Stop with Ctrl+C.");
    synchronize(); // Initial copy once, then only when actual source contents change.
} catch (error) {
    console.error(`Watch failed: ${error.message}`);
    process.exitCode = 1;
    watcher?.close();
    clearTimeout(timer);
}
