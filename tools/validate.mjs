import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BP, RP, ROOT, validateProject } from "./project.mjs";

function listScripts(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(dir, entry.name);
        return entry.isDirectory() ? listScripts(file) : entry.isFile() && file.endsWith(".js") ? [file] : [];
    });
}

export function validate() {
    const { version } = validateProject();
    let errors = 0;
    const scripts = listScripts(path.join(BP, "scripts"));
    if (!scripts.length) throw new Error("No behavior-pack scripts found.");
    const imports = /\b(?:import|export)\s+(?:[^;'"\n]*?\sfrom\s*)?["'](\.[^"']+)["']/g;
    for (const script of scripts) {
        const contents = fs.readFileSync(script, "utf8");
        for (const [, relative] of contents.matchAll(imports)) {
            const target = path.resolve(path.dirname(script), relative);
            if (!fs.existsSync(target)) {
                console.error(`Missing import: ${path.relative(ROOT, script)} → ${relative}`);
                errors++;
            }
        }
    }
    if (errors) throw new Error(`${errors} missing local import(s).`);
    console.log(`Validated Lily's Money v${version}: ${scripts.length} JavaScript files and both pack manifests.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        validate();
    } catch (error) {
        console.error(`Validation failed: ${error.message}`);
        process.exitCode = 1;
    }
}
