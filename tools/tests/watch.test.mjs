import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ROOT, BP, RP, BP_FOLDER_NAME, RP_FOLDER_NAME } from "../project.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, timeoutMs = 12000) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for watch to sync");
        await wait(80);
    }
}

test("watch replaces existing packs, creates missing packs, and only re-syncs on actual file changes", { timeout: 30000 }, async () => {
    // Work solely in temp directories; never touch real AppData or the project's source.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lilys-money-watch-"));
    const fakeProject = path.join(tmp, "source");
    const mcRoot = path.join(tmp, "com.mojang");
    const projectTools = path.join(fakeProject, "tools");
    const devBp = path.join(mcRoot, "development_behavior_packs", BP_FOLDER_NAME);
    const devRp = path.join(mcRoot, "development_resource_packs", RP_FOLDER_NAME);
    fs.mkdirSync(projectTools, { recursive: true });
    fs.cpSync(BP, path.join(fakeProject, "addon", "bp"), { recursive: true });
    fs.cpSync(RP, path.join(fakeProject, "addon", "rp"), { recursive: true });
    for (const file of ["watch.mjs", "project.mjs"]) {
        fs.copyFileSync(path.join(ROOT, "tools", file), path.join(projectTools, file));
    }
    fs.mkdirSync(devBp, { recursive: true });
    fs.writeFileSync(path.join(devBp, "old-unmanaged-copy.txt"), "remove me");
    fs.mkdirSync(path.dirname(devRp), { recursive: true }); // RP folder itself is initially missing
    fs.mkdirSync(path.join(mcRoot, "development_behavior_packs", "UnrelatedPack"));
    fs.writeFileSync(path.join(mcRoot, "development_behavior_packs", "UnrelatedPack", "keep.txt"), "do not touch");
    const child = spawn(process.execPath, [path.join(projectTools, "watch.mjs"), "--minecraft-path", mcRoot], {
        cwd: fakeProject,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
        output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
        output += chunk.toString();
    });
    const numberOfSyncs = () => output.split("Synced BP + RP").length - 1;
    try {
        await until(() => numberOfSyncs() >= 1);
        assert.equal(fs.existsSync(path.join(devBp, "old-unmanaged-copy.txt")), false);
        assert.equal(
            fs.readFileSync(path.join(devBp, "scripts", "main.js"), "utf8"),
            fs.readFileSync(path.join(BP, "scripts", "main.js"), "utf8"),
        );
        assert.equal(fs.readFileSync(path.join(devBp, "manifest.json"), "utf8"), fs.readFileSync(path.join(BP, "manifest.json"), "utf8"));
        assert.ok(fs.existsSync(path.join(devRp, "manifest.json")));
        assert.ok(fs.existsSync(path.join(devRp, "ui", "server_form.json")));
        assert.ok(fs.existsSync(path.join(mcRoot, "development_behavior_packs", "UnrelatedPack", "keep.txt")));
        await wait(800);
        assert.equal(numberOfSyncs(), 1, `Unexpected repeated syncing: ${output}`);

        const edited = path.join(fakeProject, "addon", "bp", "scripts", "main.js");
        fs.appendFileSync(edited, "\n// WATCH TEST LILY\n");
        await until(() => numberOfSyncs() >= 2);
        assert.ok(fs.readFileSync(path.join(devBp, "scripts", "main.js"), "utf8").includes("WATCH TEST LILY"));
        await wait(650);
        assert.equal(numberOfSyncs(), 2, `Watch didn't settle after source edit: ${output}`);

        const resource = path.join(fakeProject, "addon", "rp", "WATCH-TEST.txt");
        fs.writeFileSync(resource, "temporary test file");
        await until(() => numberOfSyncs() >= 3);
        assert.ok(fs.existsSync(path.join(devRp, "WATCH-TEST.txt")));
        fs.rmSync(resource);
        await until(() => numberOfSyncs() >= 4);
        assert.ok(!fs.existsSync(path.join(devRp, "WATCH-TEST.txt")));
    } finally {
        child.kill();
        await wait(200);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
