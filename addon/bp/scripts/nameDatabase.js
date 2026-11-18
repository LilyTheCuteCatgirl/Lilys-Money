// BP/scripts/nameDatabase.js
import { system, world } from "@minecraft/server";

const NAME_DATABASE_PROPERTY = "lilynames:nameDataBase";
const NAME_DATABASE_COUNT_PROPERTY = "lilynames:nameDataBaseCount";
const NAME_DATABASE_MAX_CHARS = 30000;
const NAME_DATABASE_SAVE_DELAY_TICKS = 100; // 5 seconds, batches join bursts

let nameDatabase = null;
let saveRunId = null;
let dirty = false;

function safeJsonParse(jsonText, fallbackValue) {
    try {
        if (typeof jsonText !== "string" || jsonText.length === 0) return fallbackValue;
        return JSON.parse(jsonText);
    } catch {
        return fallbackValue;
    }
}

function getNameDatabaseChunkKey(index) {
    return index === 1 ? NAME_DATABASE_PROPERTY : `${NAME_DATABASE_PROPERTY}${index}`;
}

function loadNameDatabase() {
    const chunkCount = Number(world.getDynamicProperty(NAME_DATABASE_COUNT_PROPERTY));

    // Backwards compatibility with old single-property database.
    if (!Number.isFinite(chunkCount) || chunkCount < 1) {
        const singleChunk = safeJsonParse(world.getDynamicProperty(NAME_DATABASE_PROPERTY), {});
        return new Map(Object.entries(singleChunk ?? {}));
    }

    const merged = {};

    for (let i = 1; i <= chunkCount; i++) {
        const chunkData = safeJsonParse(world.getDynamicProperty(getNameDatabaseChunkKey(i)), {});

        if (chunkData && typeof chunkData === "object" && !Array.isArray(chunkData)) {
            Object.assign(merged, chunkData);
        }
    }

    return new Map(Object.entries(merged));
}

function getNameDatabase() {
    if (!nameDatabase) nameDatabase = loadNameDatabase();
    return nameDatabase;
}

function saveNameDatabaseNow(database = getNameDatabase()) {
    const previousChunkCount = Number(world.getDynamicProperty(NAME_DATABASE_COUNT_PROPERTY)) || 0;
    const entries = Object.entries(Object.fromEntries(database));
    const chunks = [];
    let currentChunk = {};

    for (const [key, value] of entries) {
        const testChunk = { ...currentChunk, [key]: value };
        const testString = JSON.stringify(testChunk);

        if (testString.length > NAME_DATABASE_MAX_CHARS && Object.keys(currentChunk).length > 0) {
            chunks.push(currentChunk);
            currentChunk = { [key]: value };
        } else {
            currentChunk[key] = value;
        }
    }

    if (Object.keys(currentChunk).length > 0 || chunks.length === 0) chunks.push(currentChunk);

    world.setDynamicProperty(NAME_DATABASE_COUNT_PROPERTY, chunks.length);

    for (let i = 0; i < chunks.length; i++) {
        world.setDynamicProperty(getNameDatabaseChunkKey(i + 1), JSON.stringify(chunks[i]));
    }

    for (let i = chunks.length + 1; i <= previousChunkCount; i++) {
        world.setDynamicProperty(getNameDatabaseChunkKey(i), undefined);
    }

    dirty = false;
}

function scheduleNameDatabaseSave() {
    dirty = true;
    if (saveRunId !== null) return;

    saveRunId = system.runTimeout(() => {
        saveRunId = null;
        if (!dirty) return;
        try {
            saveNameDatabaseNow();
        } catch {}
    }, NAME_DATABASE_SAVE_DELAY_TICKS);
}

export function rememberPlayerName(player) {
    try {
        const identity = player.scoreboardIdentity;
        if (!identity) return false;

        const database = getNameDatabase();
        const key = String(identity.id);
        const oldName = database.get(key);

        if (oldName === player.name) return false;

        database.set(key, player.name);
        scheduleNameDatabaseSave();

        return true;
    } catch {
        return false;
    }
}

export function getSavedPlayerNameByIdentityId(identityId) {
    try {
        const database = getNameDatabase();
        return database.get(String(identityId)) ?? null;
    } catch {
        return null;
    }
}

export function getSavedPlayerNameFromParticipant(participant) {
    if (!participant) return null;

    try {
        const savedName = getSavedPlayerNameByIdentityId(participant.id);
        if (savedName) return savedName;
    } catch {}

    return participant.displayName ?? null;
}

export function getAllSavedPlayerNames() {
    try {
        const database = getNameDatabase();
        return Array.from(database.values());
    } catch {
        return [];
    }
}

export function getAllSavedPlayerNameEntries() {
    try {
        const database = getNameDatabase();

        return Array.from(database.entries()).map(([identityId, name]) => ({
            identityId,
            name,
        }));
    } catch {
        return [];
    }
}

export function clearSavedPlayerNames() {
    try {
        const database = getNameDatabase();
        database.clear();
        saveNameDatabaseNow(database);
    } catch {}
}

// Optional helper for future admin tools/reloads.
export function flushSavedPlayerNames() {
    try {
        if (dirty) saveNameDatabaseNow();
    } catch {}
}
