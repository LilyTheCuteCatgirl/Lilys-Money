import { inflateRawSync } from "node:zlib";
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
        const expected = new Map();
        function collect(dir, prefix) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const source = path.join(dir, entry.name);
                const key = prefix + "/" + entry.name;
                if (entry.isDirectory()) collect(source, key);
                else if (entry.name !== ".gitkeep") expected.set(key, fs.readFileSync(source));
            }
        }
        collect(BP, "LilysMoneyBP");
        collect(RP, "LilysMoneyRP");
        assert.equal(files, expected.size);
        const archive = fs.readFileSync(output);
        assert.equal(archive.readUInt32LE(0), 0x04034b50);
        let offset = 0;
        while (archive.readUInt32LE(offset) === 0x04034b50) {
            const compressedSize = archive.readUInt32LE(offset + 18);
            const nameEnd = offset + 30 + archive.readUInt16LE(offset + 26);
            const name = archive.toString("utf8", offset + 30, nameEnd);
            const dataStart = nameEnd + archive.readUInt16LE(offset + 28);
            offset = dataStart + compressedSize;
            assert.ok(expected.has(name), `Unexpected or duplicate entry: ${name}`);
            assert.deepEqual(inflateRawSync(archive.subarray(dataStart, offset)), expected.get(name), name);
            expected.delete(name);
        }
        assert.deepEqual([...expected.keys()], []);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
