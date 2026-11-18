import { system, world } from "@minecraft/server";
import { CONFIG } from "../../config.js";

const NAME_PROPERTY = "lilynames:nameDataBase";
const COUNT_PROPERTY = "lilynames:nameDataBaseCount";
const PAGE_BYTES = 30000;
const SAVE_DELAY_TICKS = 100;

let database;
let scheduled = false;
let lastWarning;
const pending = new Map();
const dirtyPages = new Map();

function warn(message) {
    if (message !== lastWarning) console.warn(`[LilyMoney names] ${message}`);
    lastWarning = message;
}

function pageKey(index) {
    return index === 1 ? NAME_PROPERTY : NAME_PROPERTY + index;
}

function validName(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function load() {
    if (database) return database;
    const names = new Map();
    const legacy = world.getDynamicProperty(CONFIG.NAME_CACHE_DP_KEY);
    if (typeof legacy === "string") {
        for (const line of legacy.split("\n")) {
            const tab = line.indexOf("\t");
            if (tab > 0 && validName(line.slice(tab + 1))) names.set(line.slice(0, tab), line.slice(tab + 1));
        }
    }

    const rawCount = world.getDynamicProperty(COUNT_PROPERTY);
    const count = Number(rawCount ?? 1);
    const validCount =
        (rawCount === undefined || typeof rawCount === "number" || typeof rawCount === "string") &&
        Number.isSafeInteger(count) &&
        count >= 1;
    let writable = validCount;
    // Enumerate existing keys so a damaged count cannot cause an unbounded read loop.
    const indexes = [];
    for (const key of world.getDynamicPropertyIds()) {
        if (key === NAME_PROPERTY) indexes.push(1);
        else if (key.startsWith(NAME_PROPERTY)) {
            const index = Number(key.slice(NAME_PROPERTY.length));
            if (Number.isSafeInteger(index) && index >= 2 && key === pageKey(index)) indexes.push(index);
        }
    }
    indexes.sort((a, b) => a - b);
    const empty = rawCount === undefined && indexes.length === 0;
    if (!empty && indexes.length !== count) writable = false;
    let tail = Object.create(null);
    for (const [position, index] of indexes.entries()) {
        if (index !== position + 1 || index > count) writable = false;
        if (index > count && validCount) continue;
        const raw = world.getDynamicProperty(pageKey(index));
        let page;
        try {
            page = JSON.parse(raw);
        } catch {
            writable = false;
            continue;
        }
        if (!page || typeof page !== "object" || Array.isArray(page)) {
            writable = false;
            continue;
        }
        for (const [id, name] of Object.entries(page)) {
            if (id && validName(name)) names.set(id, name);
            else writable = false;
        }
        if (index === count) tail = Object.assign(Object.create(null), page);
    }
    if (!writable)
        warn(
            "Incomplete or invalid name database. Valid names are available. Disk writes are paused until the data is repaired and scripts reload.",
        );
    database = { names, count, tail, writable };
    return database;
}

// Bedrock limits string properties by UTF-8 bytes. JSON.stringify escapes lone surrogates.
function utf8Bytes(text) {
    let bytes = 0;
    for (const char of text) {
        const cp = char.codePointAt(0);
        bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    }
    return bytes;
}

function scheduleSave() {
    if (scheduled || database?.writable === false) return;
    system.runTimeout(() => {
        scheduled = false;
        flushSavedPlayerNames();
    }, SAVE_DELAY_TICKS);
    scheduled = true;
}

export function flushSavedPlayerNames() {
    if (!pending.size && !dirtyPages.size) return;
    try {
        const db = load();
        if (!db.writable) return;

        let size = utf8Bytes(JSON.stringify(db.tail));
        // Earlier pages stay in place. A renamed identity in a later page wins on load.
        for (const [id, name] of pending) {
            const entrySize = utf8Bytes(JSON.stringify(id)) + 1 + utf8Bytes(JSON.stringify(name));
            const oldName = db.tail[id];
            let nextSize =
                oldName === undefined
                    ? size + entrySize + (size === 2 ? 0 : 1)
                    : size - utf8Bytes(JSON.stringify(oldName)) + utf8Bytes(JSON.stringify(name));
            if (nextSize > PAGE_BYTES) {
                nextSize = 2 + entrySize;
                if (nextSize > PAGE_BYTES) throw new Error("A single name exceeds the property limit.");
                db.count++;
                db.tail = Object.create(null);
            }
            db.tail[id] = name;
            size = nextSize;
            dirtyPages.set(db.count, db.tail);
            db.names.set(id, name);
            pending.delete(id);
        }
        for (const [index, page] of dirtyPages) world.setDynamicProperty(pageKey(index), JSON.stringify(page));
        world.setDynamicProperty(COUNT_PROPERTY, db.count);
        dirtyPages.clear();
        lastWarning = undefined;
    } catch (error) {
        warn(`Could not save player names. Retrying. ${error}`);
        scheduleSave();
    }
}

export function getSavedPlayerNameByIdentityId(identityId) {
    const key = String(identityId);
    if (pending.has(key)) return pending.get(key);
    try {
        return load().names.get(key) ?? null;
    } catch (error) {
        warn(`Could not read player names. ${error}`);
        return null;
    }
}

export function rememberPlayerName(player) {
    try {
        const id = player?.scoreboardIdentity?.id;
        const name = player?.name;
        if (id == null || !validName(name)) return false;
        if (getSavedPlayerNameByIdentityId(id) === name) return false;
        pending.set(String(id), name);
        scheduleSave();
        return true;
    } catch (error) {
        warn(`Could not record a player name. ${error}`);
        return false;
    }
}

export function getSavedPlayerNameFromParticipant(participant) {
    try {
        return participant ? (getSavedPlayerNameByIdentityId(participant.id) ?? participant.displayName ?? null) : null;
    } catch {
        return null;
    }
}

export function getAllSavedPlayerNameEntries() {
    let names;
    try {
        names = new Map(load().names);
    } catch (error) {
        warn(`Could not read player names. ${error}`);
        names = new Map();
    }
    for (const [id, name] of pending) names.set(id, name);
    return Array.from(names, ([identityId, name]) => ({ identityId, name }));
}
