import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function parseJson(relativePath, original) {
    try {
        return JSON.parse(original);
    } catch (error) {
        throw new Error(`Invalid JSON in ${relativePath}: ${error.message}`);
    }
}

function jsonText(value, original) {
    const newline = original.includes("\r\n") ? "\r\n" : "\n";
    const trailingNewline = /\r?\n$/.test(original) ? newline : "";
    return JSON.stringify(value, null, 2).replaceAll("\n", newline) + trailingNewline;
}

function replaceExactlyOnce(text, pattern, replacement, description) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length !== 1) {
        throw new Error(`Expected exactly one ${description}, found ${matches.length}. No files were changed.`);
    }
    return text.replace(pattern, replacement);
}

function setVersion() {
    if (process.argv.length !== 3 || !versionPattern.test(version)) {
        throw new Error("Usage: npm run sv -- 3.4.1 (three nonnegative numbers separated by dots)");
    }
    const parts = version.split(".").map(Number);
    if (!parts.every(Number.isSafeInteger)) throw new Error("Version numbers must be safe integers.");

    // Read all versioned files before writing so a missing file is caught up front.
    const paths = [
        "addon/bp/manifest.json",
        "addon/rp/manifest.json",
        "addon/bp/scripts/main.js",
        "addon/bp/scripts/commands/moneyhelp.js",
        "package.json",
        "package-lock.json",
    ];
    const originals = new Map(paths.map((p) => [p, read(p)]));
    const next = new Map();

    const bp = parseJson(paths[0], originals.get(paths[0]));
    const rp = parseJson(paths[1], originals.get(paths[1]));
    if (!bp.header?.uuid || !rp.header?.uuid || !Array.isArray(bp.modules) || !Array.isArray(rp.modules)) {
        throw new Error("The BP or RP manifest is missing required header/module data. No files were changed.");
    }
    if (
        !bp.dependencies?.some((entry) => entry.uuid === rp.header.uuid) ||
        !rp.dependencies?.some((entry) => entry.uuid === bp.header.uuid)
    ) {
        throw new Error("BP and RP do not reference each other's UUIDs. No files were changed.");
    }

    for (const [relativePath, manifest] of [
        [paths[0], bp],
        [paths[1], rp],
    ]) {
        manifest.header.name = replaceExactlyOnce(
            manifest.header.name,
            /\bv\d+\.\d+\.\d+\b/g,
            `v${version}`,
            `${relativePath} display-name version`,
        );
        manifest.header.version = [...parts];
        for (const mod of manifest.modules) {
            if (!Array.isArray(mod.version)) throw new Error(`Module without a version in ${relativePath}. No files were changed.`);
            mod.version = [...parts];
        }
        // Update references between the two packs while preserving their Script API dependency versions.
        for (const dep of manifest.dependencies ?? []) {
            if (dep.uuid === bp.header.uuid || dep.uuid === rp.header.uuid) dep.version = [...parts];
        }
        next.set(relativePath, jsonText(manifest, originals.get(relativePath)));
    }

    next.set(
        paths[2],
        replaceExactlyOnce(originals.get(paths[2]), /Scripts v\d+\.\d+\.\d+/g, `Scripts v${version}`, "startup welcome version in main.js"),
    );
    next.set(
        paths[3],
        replaceExactlyOnce(
            originals.get(paths[3]),
            /Lily's Money v\d+\.\d+\.\d+/g,
            `Lily's Money v${version}`,
            "help-menu version in moneyhelp.js",
        ),
    );

    const pkg = parseJson(paths[4], originals.get(paths[4]));
    const lock = parseJson(paths[5], originals.get(paths[5]));
    if (pkg.name !== "lilys-money" || lock.name !== pkg.name || lock.packages?.[""]?.name !== pkg.name) {
        throw new Error("The npm package and lockfile do not match Lily's Money. No files were changed.");
    }
    pkg.version = version;
    lock.version = version;
    lock.packages[""].version = version;
    next.set(paths[4], jsonText(pkg, originals.get(paths[4])));
    next.set(paths[5], jsonText(lock, originals.get(paths[5])));

    const changed = paths.filter((p) => next.get(p) !== originals.get(p));
    const written = [];
    try {
        for (const relativePath of changed) {
            fs.writeFileSync(path.join(root, relativePath), next.get(relativePath), "utf8");
            written.push(relativePath);
        }
    } catch (error) {
        for (const relativePath of written.reverse()) {
            try {
                fs.writeFileSync(path.join(root, relativePath), originals.get(relativePath), "utf8");
            } catch (restoreError) {
                console.error(`Could not restore ${relativePath}: ${restoreError.message}`);
            }
        }
        throw error;
    }

    console.log(`Lily's Money version: ${version}`);
    if (!changed.length) {
        console.log("Already up to date. No files changed.");
    } else {
        for (const relativePath of changed) console.log(`Updated ${relativePath}`);
        console.log("Next: npm run validate && npm run test && npm run build");
    }
}

try {
    setVersion();
} catch (error) {
    console.error(`Version update failed: ${error.message}`);
    process.exitCode = 1;
}
