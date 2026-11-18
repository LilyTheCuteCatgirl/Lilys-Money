import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BP, RP, validateProject } from "../project.mjs";
import { validate } from "../validate.mjs";
import { writeAddonZip } from "../zip.mjs";

test("both complete manifests point to the included scripts and to each other", () => {
    const { version, entry } = validateProject();
    assert.equal(version, "3.4.0");
    assert.equal(entry, "scripts/main.js");
    assert.ok(fs.statSync(path.join(BP, entry)).size > 100);
    assert.ok(fs.existsSync(path.join(RP, "ui", "server_form.json")));
    validate();
});

test("build packages both complete packs and includes their manifests and scripts", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lilys-money-build-"));
    try {
        const output = path.join(directory, "addon.mcaddon");
        const files = writeAddonZip(output, [
            [BP, "LilysMoneyBP"],
            [RP, "LilysMoneyRP"],
        ]);
        assert.equal(files, 73);
        const archive = fs.readFileSync(output);
        assert.equal(archive.readUInt32LE(0), 0x04034b50);
        for (const filename of [
            "LilysMoneyBP/manifest.json",
            "LilysMoneyBP/scripts/main.js",
            "LilysMoneyBP/scripts/commands/pay.js",
            "LilysMoneyRP/manifest.json",
            "LilysMoneyRP/ui/server_form.json",
        ]) {
            assert.ok(archive.includes(Buffer.from(filename)), `Missing ${filename}`);
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
