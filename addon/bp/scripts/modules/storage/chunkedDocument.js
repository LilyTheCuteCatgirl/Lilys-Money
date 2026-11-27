import { world } from "@minecraft/server";

function cloneDocument(data) {
    return JSON.parse(JSON.stringify(data));
}

function readDocument(base, version) {
    const meta = world.getDynamicProperty(base + ":meta");
    const partPrefix = base + ":part_";
    const present = world.getDynamicPropertyIds().filter((key) => key.startsWith(partPrefix));
    let count = 0;
    if (meta !== undefined && meta !== "") {
        const parsed = JSON.parse(meta);
        if (
            (parsed?.v !== undefined && parsed.v !== version) ||
            !Number.isInteger(parsed?.parts) ||
            parsed.parts < 0 ||
            parsed.parts >= 300
        )
            throw new Error("Invalid chunk metadata.");
        count = parsed.parts;
    }

    const parts = [];

    for (let i = 0; i < count; i++) {
        const part = world.getDynamicProperty(partPrefix + i);
        if (typeof part !== "string" || !part.length) throw new Error("Missing chunk " + i);
        parts.push(part);
    }
    for (const key of present) {
        const index = Number(key.slice(partPrefix.length));
        if (Number.isInteger(index) && index >= 0 && index < count && key === partPrefix + index) continue;

        const value = world.getDynamicProperty(key);
        if (value !== undefined && value !== "") throw new Error("Unexpected chunk " + key);
    }
    if (count) return { meta, raw: parts.join(""), count };
    if (meta !== undefined && meta !== "") return { meta, raw: "", count };

    const legacy = world.getDynamicProperty(base);
    if (legacy !== undefined && typeof legacy !== "string") throw new Error("Invalid legacy document.");
    if ((meta === "" || legacy === "") && !legacy) throw new Error("Incomplete cleared database.");

    return { meta, raw: legacy || undefined, count };
}

function chunkDocument(text) {
    const parts = [];
    let part = "";
    let bytes = 0;

    for (const char of text) {
        const code = char.codePointAt(0);
        const size = code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
        if (bytes + size > 30000) {
            parts.push(part);
            part = "";
            bytes = 0;
        }
        part += char;
        bytes += size;
    }
    parts.push(part);
    if (parts.length >= 300) throw new Error("Document exceeds the existing chunk limit.");

    return parts;
}

// Refuse a rewrite if decoding would discard a field, price, quantity or record.
function checkPreserved(input, decoded) {
    if (input === null || typeof input !== "object") {
        if (input === decoded) return;
        if (typeof input === "string" && decoded === "minecraft:" + input) return;
        if (typeof decoded === "string" && typeof input === "number" && decoded === String(input)) return;
        throw new Error("Stored value cannot be preserved.");
    }
    if (!decoded || typeof decoded !== "object") throw new Error("Unsupported stored field.");
    if (Array.isArray(input) && (!Array.isArray(decoded) || input.length !== decoded.length))
        throw new Error("Stored record count changed.");
    for (const [key, value] of Object.entries(input)) {
        if (key === "id" && decoded.typeId && decoded.id === undefined) {
            checkPreserved(value, decoded.typeId);
            continue;
        }
        checkPreserved(value, decoded[key]);
    }
}

export function createDocumentStore(base, version, { initial, empty, decode, legacyVersions = [] }) {
    let cached;
    let source;
    let revision = 0;
    let blocked = false;
    const revisions = new WeakMap();
    function refresh() {
        if (blocked) throw new Error(base + " writes paused after rollback failure.");
        if (source) return;
        try {
            const snapshot = readDocument(base, version);
            if (snapshot.raw === undefined) cached = initial();
            else if (snapshot.raw === "") cached = empty();
            else {
                const parsed = JSON.parse(snapshot.raw);
                if (parsed?.v !== undefined && parsed.v !== version) {
                    if (snapshot.count !== 0 || !legacyVersions.includes(parsed.v)) throw new Error("Unsupported stored version.");
                    parsed.v = version;
                }
                cached = decode(parsed);
                checkPreserved(parsed, cached);
            }
            source = snapshot;
        } catch (error) {
            console.warn(`[${base}] Database unavailable: ${error}`);
            throw error;
        }
    }
    function load() {
        refresh();
        const draft = cloneDocument(cached);
        revisions.set(draft, revision);

        return draft;
    }
    function current(draft) {
        if (revisions.has(draft) && revisions.get(draft) !== revision) throw new Error("Data changed while the menu was open.");
    }
    function stage(draft) {
        refresh();
        current(draft);
        cached = cloneDocument(draft);
        revision++;
    }
    function save(draft) {
        const written = [];
        try {
            refresh();
            current(draft);
            // A menu revision only tracks local edits. Compare the saved bytes too before replacing them.
            const disk = readDocument(base, version);
            if (disk.raw !== source.raw || disk.meta !== source.meta) {
                source = undefined;
                revision++;
                throw new Error("Stored document changed. Reopen the menu.");
            }

            const clean = decode(draft);
            const raw = JSON.stringify(clean);
            const parts = chunkDocument(raw);
            function write(key, value) {
                const old = world.getDynamicProperty(key);
                if (old === value) return;
                world.setDynamicProperty(key, value);
                written.push([key, old]);
            }
            for (let i = 0; i < Math.max(parts.length, disk.count); i++) write(base + ":part_" + i, parts[i] ?? "");
            const meta = JSON.stringify({ v: version, parts: parts.length });
            write(base + ":meta", meta);
            cached = clean;
            source = { meta, raw, count: parts.length };
            revision++;

            return true;
        } catch (error) {
            for (const [key, value] of written.reverse()) {
                try {
                    world.setDynamicProperty(key, value);
                } catch (rollback) {
                    // A partial rollback leaves the stored document uncertain. Pause writes to preserve what remains.
                    blocked = true;
                    console.warn(`[${base}] Rollback failed for ${key}: ${rollback}`);
                }
            }
            console.warn(`[${base}] Save refused: ${error}`);

            return false;
        }
    }

    return { load, save, stage };
}
