import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceTool = fileURLToPath(new URL("../set-version.mjs", import.meta.url));

function makeFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lilys-money-version-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const put = (filename, content) => {
        const fullPath = path.join(root, filename);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n");
    };
    put("tools/set-version.mjs", fs.readFileSync(sourceTool, "utf8"));
    put("package.json", { name: "lilys-money", version: "3.4.0" });
    put("package-lock.json", {
        name: "lilys-money",
        version: "3.4.0",
        lockfileVersion: 3,
        packages: { "": { name: "lilys-money", version: "3.4.0" }, "node_modules/some-dep": { version: "1.2.3" } },
    });
    const ids = { bp: "bp-uuid", rp: "rp-uuid" };
    put("addon/bp/manifest.json", {
        header: { name: "Lily's Money (v3.4.1)", uuid: ids.bp, version: [3, 4, 1], min_engine_version: [1, 21, 100] },
        modules: [
            { type: "data", version: [3, 4, 1] },
            { type: "script", version: [3, 4, 1] },
        ],
        dependencies: [
            { uuid: ids.rp, version: [3, 4, 1] },
            { module_name: "@minecraft/server", version: "2.1.0" },
        ],
    });
    put("addon/rp/manifest.json", {
        header: { name: "Lily's Money (v3.4.0)", uuid: ids.rp, version: [3, 4, 0] },
        modules: [{ type: "resources", version: [3, 4, 0] }],
        dependencies: [{ uuid: ids.bp, version: [3, 4, 0] }],
    });
    put("addon/bp/scripts/main.js", 'const startup = "Lily\'s Money - v3.4.0";\n');
    put("addon/bp/scripts/commands/moneyhelp.js", 'const help = "Lily\'s Money v3.4.0";\n');
    const run = (value) => spawnSync(process.execPath, [path.join(root, "tools/set-version.mjs"), value], { cwd: root, encoding: "utf8" });
    const read = (filename) => fs.readFileSync(path.join(root, filename), "utf8");
    const json = (filename) => JSON.parse(read(filename));
    return { root, run, read, json };
}

test("version command updates all pack, npm and in-game labels but not Minecraft API versions", (t) => {
    const { run, read, json } = makeFixture(t);
    const result = run("3.5.2");
    assert.equal(result.status, 0, result.stderr);
    const bp = json("addon/bp/manifest.json");
    const rp = json("addon/rp/manifest.json");
    assert.deepEqual(bp.header.version, [3, 5, 2]);
    assert.deepEqual(rp.header.version, [3, 5, 2]);
    assert.ok(bp.header.name.includes("v3.5.2"));
    assert.ok(rp.header.name.includes("v3.5.2"));
    assert.deepEqual(
        bp.modules.map((x) => x.version),
        [
            [3, 5, 2],
            [3, 5, 2],
        ],
    );
    assert.deepEqual(
        rp.modules.map((x) => x.version),
        [[3, 5, 2]],
    );
    assert.deepEqual(bp.dependencies[0].version, [3, 5, 2]);
    assert.deepEqual(rp.dependencies[0].version, [3, 5, 2]);
    assert.equal(bp.dependencies[1].version, "2.1.0");
    assert.deepEqual(bp.header.min_engine_version, [1, 21, 100]);
    assert.ok(read("addon/bp/scripts/main.js").includes("Lily's Money - v3.5.2"));
    assert.ok(read("addon/bp/scripts/commands/moneyhelp.js").includes("Lily's Money v3.5.2"));
    assert.equal(json("package.json").version, "3.5.2");
    assert.equal(json("package-lock.json").version, "3.5.2");
    assert.equal(json("package-lock.json").packages[""].version, "3.5.2");
    assert.equal(json("package-lock.json").packages["node_modules/some-dep"].version, "1.2.3");
    const repeat = run("3.5.2");
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.match(repeat.stdout, /No files changed/);
});

test("invalid version or missing welcome label leaves every file unchanged", (t) => {
    const { root, run } = makeFixture(t);
    const before = new Map();
    function snapshot() {
        const files = [
            "package.json",
            "package-lock.json",
            "addon/bp/manifest.json",
            "addon/rp/manifest.json",
            "addon/bp/scripts/main.js",
            "addon/bp/scripts/commands/moneyhelp.js",
        ];
        return new Map(files.map((p) => [p, fs.readFileSync(path.join(root, p), "utf8")]));
    }
    for (const [p, data] of snapshot()) before.set(p, data);
    assert.notEqual(run("3.5").status, 0);
    assert.deepEqual(snapshot(), before);
    fs.writeFileSync(path.join(root, "addon/bp/scripts/main.js"), 'const startup = "no version here";\n');
    const changed = snapshot();
    assert.notEqual(run("3.5.2").status, 0);
    assert.deepEqual(snapshot(), changed);
});
