import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ADDON = path.join(ROOT, "addon");
export const BP = path.join(ADDON, "bp");
export const RP = path.join(ADDON, "rp");
export const BUILDS = path.join(ROOT, "builds");
export const BP_FOLDER_NAME = "LilysMoney_BP_DEV";
export const RP_FOLDER_NAME = "LilysMoney_RP_DEV";

export function readManifest(packPath) {
    const manifestPath = path.join(packPath, "manifest.json");
    if (!fs.existsSync(manifestPath)) throw new Error(`Missing manifest: ${manifestPath}`);
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

export function validateProject() {
    const bp = readManifest(BP);
    const rp = readManifest(RP);
    const scriptModule = bp.modules?.find((m) => m.type === "script");
    if (!scriptModule?.entry) throw new Error("BP manifest has no JavaScript entry point.");
    const entry = path.resolve(BP, scriptModule.entry);
    if (!entry.startsWith(BP + path.sep) || !fs.existsSync(entry)) {
        throw new Error(`BP entry does not exist: ${scriptModule.entry}`);
    }
    if (!bp.dependencies?.some((d) => d.uuid === rp.header?.uuid)) {
        throw new Error("Behavior pack does not reference the resource-pack UUID.");
    }
    if (!rp.dependencies?.some((d) => d.uuid === bp.header?.uuid)) {
        throw new Error("Resource pack does not reference the behavior-pack UUID.");
    }
    const bpVersion = bp.header.version.join(".");
    const rpVersion = rp.header.version.join(".");
    if (bpVersion !== rpVersion) throw new Error("BP/RP versions differ.");
    return { version: bpVersion, entry: scriptModule.entry };
}

export function minecraftRoot({ preview = false, override } = {}) {
    const explicit = override ?? process.env.LILYS_MONEY_MINECRAFT_PATH;
    if (explicit) return path.resolve(explicit);
    if (!process.env.APPDATA) {
        throw new Error("APPDATA is unavailable. On Windows, run this from a normal terminal; for testing, use --minecraft-path <path>.");
    }
    return path.join(
        process.env.APPDATA,
        preview ? "Minecraft Bedrock Preview" : "Minecraft Bedrock",
        "Users",
        "Shared",
        "games",
        "com.mojang",
    );
}

export function destinationPaths(mcRoot) {
    return {
        bp: path.join(mcRoot, "development_behavior_packs", BP_FOLDER_NAME),
        rp: path.join(mcRoot, "development_resource_packs", RP_FOLDER_NAME),
    };
}

/** Deliberately REPLACES the designated Lily's Money development folder, even if it already exists. */
export function replaceDevelopmentPack(source, destination, type) {
    const expectedParent = type === "bp" ? "development_behavior_packs" : "development_resource_packs";
    const expectedName = type === "bp" ? BP_FOLDER_NAME : RP_FOLDER_NAME;
    if (path.basename(destination) !== expectedName || path.basename(path.dirname(destination)) !== expectedParent) {
        throw new Error(`Refusing to replace a folder that isn't the designated Lily's Money development ${type} pack: ${destination}`);
    }
    if (!fs.statSync(source).isDirectory() || !fs.existsSync(path.join(source, "manifest.json"))) {
        throw new Error(`Source ${type} pack is incomplete: ${source}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    // The user explicitly wants existing copies replaced, including older unmanaged copies.
    fs.rmSync(destination, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
    fs.cpSync(source, destination, { recursive: true, force: true });
}

export function syncDevelopmentPacks(mcRoot) {
    // Do all preflight checks BEFORE deleting an existing development pack.
    validateProject();
    if (!fs.existsSync(mcRoot) || !fs.statSync(mcRoot).isDirectory()) {
        throw new Error(
            `Minecraft com.mojang folder not found: ${mcRoot}\nLaunch Minecraft once, or pass --minecraft-path with the correct directory.`,
        );
    }
    const destinations = destinationPaths(mcRoot);
    replaceDevelopmentPack(BP, destinations.bp, "bp");
    replaceDevelopmentPack(RP, destinations.rp, "rp");
    return destinations;
}
