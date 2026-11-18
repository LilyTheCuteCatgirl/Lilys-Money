import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BP, validateProject } from "./project.mjs";

function listScripts(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(dir, entry.name);
        return entry.isDirectory() ? listScripts(file) : entry.isFile() && file.endsWith(".js") ? [file] : [];
    });
}

export function validate() {
    const { version, entry } = validateProject();
    const scripts = new Set(listScripts(path.join(BP, "scripts")));
    const visited = new Set();
    const active = new Set();
    // Pack scripts use named imports, named re-exports and side-effect imports.
    const imports = /^\s*(?:import|export)\s+(?:\{[^}]*\}\s*from\s*)?["'](\.[^"']+)["']/gm;

    function visit(script) {
        if (active.has(script))
            throw new Error(`Circular import: ${[...active, script].map((file) => path.relative(BP, file)).join(" -> ")}`);
        if (visited.has(script)) return;
        active.add(script);
        for (const [, relative] of fs.readFileSync(script, "utf8").matchAll(imports)) {
            const target = path.resolve(path.dirname(script), relative);
            if (!scripts.has(target)) throw new Error(`Missing script import in ${path.relative(BP, script)}: ${relative}`);
            visit(target);
        }
        active.delete(script);
        visited.add(script);
    }
    visit(path.resolve(BP, entry));
    for (const script of scripts) if (!visited.has(script)) throw new Error(`Unreachable script: ${path.relative(BP, script)}`);
    console.log(`Validated Lily's Money v${version}: ${scripts.size} JavaScript files and both pack manifests.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        validate();
    } catch (error) {
        console.error(`Validation failed: ${error.message}`);
        process.exitCode = 1;
    }
}
