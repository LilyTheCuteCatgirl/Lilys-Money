// Gameplay callers supply event details. This module owns the logging switch, record format, checkpoints and shard recovery.

import { Player, StructureSaveMode, system, world } from "@minecraft/server";

import { CONFIG } from "../../config.js";

import { ensureMoneyObjectives, getBalanceCents } from "../economy/balance.js";

import { getAllSavedPlayerNameEntries } from "../players/nameDatabase.js";

const WORLD_ID_DP_KEY = "lilymoney:world_id";

const DB_FORMAT_VERSION = 1;
const RECORD_FORMAT_VERSION = 1;

// Earlier structure round trips retained 512 KB and 1 MB of entity properties. The smaller target leaves room for growth.
const SHARD_TARGET_BYTES = 256 * 1024;
const PAGE_CHARS = 30_000;

const STORAGE_TYPE = "lilymoney:money_storage";
const STORAGE_TAG = "lilymoney_moneylog_storage";
const ACTIVE_TAG = "lilymoney_moneylog_active";
const SEALED_TAG = "lilymoney_moneylog_sealed";

const STRUCTURE_PREFIX = "lilymoney:moneylog_";
const SHARD_DIGITS = 8;

// World properties track shard state and emergency recovery. Normal history lives on the active entity and in sealed structures.
const W_LAST_SEALED_RECORD_ID = "lilymoney:moneylog_last_sealed_record_v1";
const W_ACTIVE_OPEN = "lilymoney:moneylog_active_open_v1";
const W_ACTIVE_SHARD_INDEX = "lilymoney:moneylog_active_shard_v1";

const W_DEATH_RECOVERY_META = "lilymoney:moneylog_death_recovery_meta_v1";

const W_DEATH_RECOVERY_PAGE_PREFIX = "lilymoney:moneylog_death_recovery_page_";

const W_DEAD_ENTITY_QUARANTINE = "lilymoney:moneylog_dead_entity_quarantine_v1";

const E_DB_FORMAT = "lilymoney:db_format";
const E_RECORD_FORMAT = "lilymoney:record_format";
const E_KIND = "lilymoney:db_kind";
const E_WORLD_ID = "lilymoney:db_world_id";
const E_SHARD_INDEX = "lilymoney:shard_index";
const E_CREATED_AT = "lilymoney:created_at";
const E_SEALED_AT = "lilymoney:sealed_at";
const E_TARGET_BYTES = "lilymoney:target_bytes";
const E_RECORD_COUNT = "lilymoney:record_count";
const E_FIRST_RECORD_ID = "lilymoney:first_record_id";
const E_LAST_RECORD_ID = "lilymoney:last_record_id";
const E_FIRST_TIME = "lilymoney:first_time";
const E_LAST_TIME = "lilymoney:last_time";
const E_PAGE_COUNT = "lilymoney:page_count";
const E_CHECKSUM = "lilymoney:checksum_fnv1a32";
const E_SEALED = "lilymoney:sealed";
const E_PAGE_PREFIX = "lilymoney:page_";

const E_JOB_BATCH_STATE = "lilymoney:job_batch_state_v1";

const JOB_BATCH_WINDOW_MS = 30_000;

// Limit the number of reward types in one batch so the pending property stays small.
const JOB_BATCH_STATE_MAX_CHARS = 24_000;

// These event names are part of the saved history format.
export const MONEY_LOG_EVENT = Object.freeze({
    PAY: "PAY",
    SHOP_BUY: "SHOP_BUY",
    SHOP_SELL: "SHOP_SELL",
    AH_BUY: "AH_BUY",
    BUY_COMMAND: "BUY_COMMAND",
    SELL_COMMAND: "SELL_COMMAND",
    ADD_MONEY: "ADD_MONEY",
    REMOVE_MONEY: "REMOVE_MONEY",
    SET_MONEY: "SET_MONEY",
    JOB_REWARD: "JOB_REWARD",
    PLAYER_JOIN: "PLAYER_JOIN",
    PLAYER_LEAVE: "PLAYER_LEAVE",
    BALANCE_CHECKPOINT: "BALANCE_CHECKPOINT",
    FULL_BALANCE_CHECKPOINT: "FULL_BALANCE_CHECKPOINT",
    LOGGING_ENABLED: "LOGGING_ENABLED",
    LOGGING_DISABLED: "LOGGING_DISABLED",
});

let activeEntityCache = undefined;
let activeLocationCache = undefined;
let activeDimensionIdCache = undefined;

let safetyBlocked = false;
let deathRecoveryInProgress = false;
let bootCheckpointPending = false;
let startupRecoveryInProgress = false;

const quarantinedDeadStorageEntityIds = new Set();
let deadStorageQuarantineLoaded = false;

let loggingEnabledCache = undefined;

export function getMoneyLoggingEnabled() {
    if (typeof loggingEnabledCache === "boolean") {
        return loggingEnabledCache;
    }

    try {
        const key = CONFIG.TRANSACTION_LOGGING_DP_KEY;
        if (!key) {
            dbWarn("TRANSACTION_LOGGING_DP_KEY is missing from CONFIG.");
            return false;
        }

        const saved = world.getDynamicProperty(key);
        loggingEnabledCache = saved === undefined ? true : saved === true;
        return loggingEnabledCache;
    } catch (e) {
        dbWarn(`Failed to load money logging setting: ${errorText(e)}`);
        return false;
    }
}

function setSavedMoneyLoggingEnabled(enabled) {
    const value = enabled === true;

    try {
        const key = CONFIG.TRANSACTION_LOGGING_DP_KEY;
        if (!key) throw new Error("TRANSACTION_LOGGING_DP_KEY is missing from CONFIG.");

        world.setDynamicProperty(key, value);
        const saved = world.getDynamicProperty(key);

        if (saved !== value) {
            throw new Error(`Dynamic-property verification failed. Expected ${value}, got ${saved}`);
        }

        loggingEnabledCache = value;
        console.log(`[LilyMoney] Money logging setting saved: ${value ? "ON" : "OFF"}`);
        return true;
    } catch (e) {
        dbWarn(`FAILED to save money logging setting: ${errorText(e)}`);
        return false;
    }
}

function cleanText(value) {
    return String(value ?? "")
        .replace(/§./g, "")
        .replace(/[\r\n]+/g, " ")
        .trim();
}

function errorText(error) {
    const message = String(error?.message ?? "").trim();
    const stack = String(error?.stack ?? "").trim();

    // Some engine errors have stack frames without a message. Include both in the Content Log.
    if (message && stack && !stack.includes(message)) {
        return `${message} | ${stack}`;
    }
    return stack || message || String(error);
}

function dbInfo(message) {
    console.log(`[LilyMoney DB] ${message}`);
}

function dbWarn(message) {
    console.warn(`[LilyMoney DB] ${message}`);
}

function safeInteger(value, fallback = null) {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) return fallback;
    return n;
}

function actorInfo(value) {
    if (value instanceof Player) {
        return playerInfo(value);
    }

    try {
        const src = value?.initiator ?? value?.sourceEntity;
        if (src instanceof Player) return playerInfo(src);
        if (value?.sourceBlock) {
            return {
                identityId: "",
                name: "Command Block",
            };
        }
    } catch {}

    if (value && typeof value === "object") {
        const identityId = cleanText(value.identityId ?? value.id ?? "");
        const name = cleanText(value.name ?? value.playerName ?? "");

        if (identityId || name) {
            return {
                identityId,
                name: name || "Unknown",
            };
        }
    }

    if (typeof value === "string") {
        return {
            identityId: "",
            name: cleanText(value) || "Unknown",
        };
    }

    return {
        identityId: "",
        name: "Unknown",
    };
}

function playerInfo(player) {
    let identityId = "";
    let name = "Unknown";

    try {
        identityId = String(player?.scoreboardIdentity?.id ?? "");
    } catch {}

    try {
        name = cleanText(player?.name) || "Unknown";
    } catch {}

    return {
        identityId,
        name,
    };
}

function getAnchorPlayer(data = null) {
    const candidates = [data?.player, data?.actor, data?.source, data?.target, data?.buyer, data?.seller];

    for (const candidate of candidates) {
        if (candidate instanceof Player) return candidate;

        try {
            const src = candidate?.initiator ?? candidate?.sourceEntity;
            if (src instanceof Player) return src;
        } catch {}
    }

    return world.getAllPlayers()[0];
}

function getScoreMap(objective) {
    const map = new Map();
    if (!objective) return map;

    try {
        for (const info of objective.getScores()) {
            const identityId = info?.participant?.id;
            const score = info?.score;

            if (identityId === undefined || identityId === null) continue;
            if (typeof score !== "number") continue;

            map.set(String(identityId), score);
        }
    } catch {}

    return map;
}

function generateWorldId() {
    const timePart = Date.now().toString();
    const randomPart = Math.floor(Math.random() * 1_000_000_000)
        .toString()
        .padStart(9, "0");

    return `${timePart}${randomPart}`;
}

export function getLilyMoneyWorldId() {
    try {
        const existing = world.getDynamicProperty(WORLD_ID_DP_KEY);

        if (typeof existing === "string" && existing.length > 0) {
            return existing;
        }

        const worldId = generateWorldId();
        world.setDynamicProperty(WORLD_ID_DP_KEY, worldId);

        const saved = world.getDynamicProperty(WORLD_ID_DP_KEY);
        if (saved !== worldId) {
            throw new Error("World ID verification failed.");
        }

        console.log(`[LilyMoney] Created world ID: ${worldId}`);
        return worldId;
    } catch (e) {
        console.warn(`[LilyMoney] Failed to get/create world ID: ${errorText(e)}`);
        return null;
    }
}

function shardId(index) {
    return `${STRUCTURE_PREFIX}${String(index).padStart(SHARD_DIGITS, "0")}`;
}

function parseShardIndex(id) {
    const text = String(id ?? "");
    if (!text.startsWith(STRUCTURE_PREFIX)) return undefined;

    const suffix = text.slice(STRUCTURE_PREFIX.length);
    if (!/^\d+$/.test(suffix)) return undefined;

    const value = Number(suffix);
    return Number.isSafeInteger(value) ? value : undefined;
}

function savedShardInfos() {
    try {
        return world.structureManager
            .getWorldStructureIds()
            .map((id) => ({ id, index: parseShardIndex(id) }))
            .filter((row) => row.index !== undefined)
            .sort((a, b) => a.index - b.index);
    } catch {
        return [];
    }
}

function nextAvailableShardIndex() {
    const shards = savedShardInfos();
    if (!shards.length) return 0;
    return shards[shards.length - 1].index + 1;
}

function nextRecordIdForNewShard() {
    const last = world.getDynamicProperty(W_LAST_SEALED_RECORD_ID);
    if (typeof last === "number" && Number.isSafeInteger(last)) {
        return last + 1;
    }
    return 0;
}

function findSafeStorageLocation(dimension, position) {
    const p = position ?? { x: 0, y: 80, z: 0 };
    const baseX = Math.floor(p.x);
    const baseY = Math.floor(p.y);
    const baseZ = Math.floor(p.z);

    // Use air near a loaded player position for shard creation and capture. The last player to leave can supply the anchor.
    const verticalOffsets = [2, 3, 4, 5, 6, 1, 0, -1, -2, -3, -4, -5, -6];
    const horizontalOffsets = [
        [0, 0],
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
        [2, 0],
        [-2, 0],
        [0, 2],
        [0, -2],
    ];

    for (const [dx, dz] of horizontalOffsets) {
        for (const dy of verticalOffsets) {
            const x = baseX + dx;
            const y = baseY + dy;
            const z = baseZ + dz;

            try {
                const block = dimension.getBlock({ x, y, z });
                const typeId = block?.typeId;
                if (typeId === "minecraft:air" || typeId === "minecraft:cave_air" || typeId === "minecraft:void_air") {
                    return { x: x + 0.5, y: y + 0.5, z: z + 0.5 };
                }
            } catch {}
        }
    }

    // Fall back to the offset used by the recovery test when no air block was found.
    return { x: p.x, y: p.y + 6, z: p.z };
}

function storageLocation(player) {
    return findSafeStorageLocation(player.dimension, player.location);
}

function resolveSealAnchor(anchor) {
    if (anchor instanceof Player) {
        try {
            return {
                dimension: anchor.dimension,
                position: {
                    x: anchor.location.x,
                    y: anchor.location.y,
                    z: anchor.location.z,
                },
            };
        } catch {
            return undefined;
        }
    }

    if (!anchor || typeof anchor !== "object") return undefined;

    try {
        const dimension = anchor.dimension ?? world.getDimension(normalizeDimensionIdForLookup(anchor.dimensionId));
        const position = anchor.position ?? anchor.location;
        if (!dimension || !position) return undefined;

        return {
            dimension,
            position: {
                x: Number(position.x),
                y: Number(position.y),
                z: Number(position.z),
            },
        };
    } catch {
        return undefined;
    }
}

function relocateStorageForSeal(entity, anchor) {
    const resolved = resolveSealAnchor(anchor);
    if (!resolved || !entity?.isValid) return false;

    const target = findSafeStorageLocation(resolved.dimension, resolved.position);

    let oldDimensionId = "";
    let oldLocation;
    try {
        oldDimensionId = entity.dimension.id;
        const loc = entity.location;
        oldLocation = { x: loc.x, y: loc.y, z: loc.z };
    } catch {}

    const newDimensionId = resolved.dimension.id;
    const dx = oldLocation ? oldLocation.x - target.x : Infinity;
    const dy = oldLocation ? oldLocation.y - target.y : Infinity;
    const dz = oldLocation ? oldLocation.z - target.z : Infinity;
    const distanceSq = dx * dx + dy * dy + dz * dz;

    // Move the shard near the capture point only when needed. The player anchoring the save may be in another dimension.
    if (oldDimensionId === newDimensionId && distanceSq <= 32 * 32) {
        return false;
    }

    entity.teleport(target, {
        dimension: resolved.dimension,
        checkForBlocks: false,
        keepVelocity: false,
    });

    rememberActiveEntity(entity);
    return true;
}

function normalizeDimensionIdForLookup(id) {
    const raw = String(id ?? "");
    if (raw === "minecraft:overworld") return "overworld";
    if (raw === "minecraft:nether") return "nether";
    if (raw === "minecraft:the_end") return "the_end";
    return raw.replace(/^minecraft:/, "");
}

function rememberActiveEntity(entity) {
    activeEntityCache = entity;

    try {
        const loc = entity.location;
        activeLocationCache = { x: loc.x, y: loc.y, z: loc.z };
    } catch {
        activeLocationCache = undefined;
    }

    try {
        activeDimensionIdCache = entity.dimension.id;
    } catch {
        activeDimensionIdCache = undefined;
    }
}

function forgetActiveEntity() {
    activeEntityCache = undefined;
    activeLocationCache = undefined;
    activeDimensionIdCache = undefined;
}

function loadDeadStorageQuarantine() {
    if (deadStorageQuarantineLoaded) return;

    try {
        const raw = world.getDynamicProperty(W_DEAD_ENTITY_QUARANTINE);

        if (typeof raw === "string" && raw.length > 0) {
            const parsed = JSON.parse(raw);

            if (Array.isArray(parsed)) {
                for (const value of parsed) {
                    if (typeof value !== "string" || value.length === 0) continue;
                    quarantinedDeadStorageEntityIds.add(value);
                }
            }
        }

        deadStorageQuarantineLoaded = true;
    } catch (e) {
        // Leave discovery retryable when the world property is temporarily unavailable.
        dbWarn(`Could not load dead storage entity quarantine: ${errorText(e)}`);
    }
}

function saveDeadStorageQuarantine() {
    const values = [...quarantinedDeadStorageEntityIds];

    if (values.length === 0) {
        world.setDynamicProperty(W_DEAD_ENTITY_QUARANTINE, undefined);
        return;
    }

    world.setDynamicProperty(W_DEAD_ENTITY_QUARANTINE, JSON.stringify(values));
}

function quarantineDeadStorageEntityId(entityId) {
    const id = cleanText(entityId);
    if (!id) return false;

    loadDeadStorageQuarantine();

    if (quarantinedDeadStorageEntityIds.has(id)) {
        return true;
    }

    quarantinedDeadStorageEntityIds.add(id);

    try {
        saveDeadStorageQuarantine();
    } catch (e) {
        // Undo the local quarantine if its marker could not be saved. Recovery must be able to identify the same entity after restart.
        quarantinedDeadStorageEntityIds.delete(id);
        throw new Error(`Could not persist dead storage entity quarantine for ${id}: ${errorText(e)}`);
    }

    return true;
}

function releaseDeadStorageEntityId(entityId) {
    const id = cleanText(entityId);
    if (!id) return false;

    loadDeadStorageQuarantine();

    if (!quarantinedDeadStorageEntityIds.delete(id)) {
        return false;
    }

    try {
        saveDeadStorageQuarantine();
    } catch (e) {
        // Keep the ID quarantined if its removal cannot be persisted.
        quarantinedDeadStorageEntityIds.add(id);
        dbWarn(`Could not clear dead storage entity quarantine for ${id}: ${errorText(e)}`);
        return false;
    }

    return true;
}

function isDeadStorageEntityQuarantined(entity) {
    loadDeadStorageQuarantine();

    let entityId;
    try {
        entityId = entity?.id;
    } catch {
        return false;
    }

    return typeof entityId === "string" && quarantinedDeadStorageEntityIds.has(entityId);
}

function findLoadedStorageEntities() {
    const found = [];

    for (const dimensionId of ["overworld", "nether", "the_end"]) {
        try {
            const dimension = world.getDimension(dimensionId);
            const entities = dimension.getEntities({
                type: STORAGE_TYPE,
                tags: [STORAGE_TAG],
            });

            for (const entity of entities) {
                try {
                    // A dead storage entity can still appear in dimension queries. Ignore IDs recorded by the death handler.
                    if (isDeadStorageEntityQuarantined(entity)) continue;

                    if (entity.getDynamicProperty(E_KIND) !== "money_history") continue;
                    found.push(entity);
                } catch {}
            }
        } catch {}
    }

    return found;
}

function recoverLoadedStorageState() {
    if (activeEntityCache?.isValid) return activeEntityCache;

    const all = findLoadedStorageEntities();
    const worldStructures = new Set(world.structureManager.getWorldStructureIds());

    const active = [];

    for (const entity of all) {
        try {
            const index = entity.getDynamicProperty(E_SHARD_INDEX);
            const sealed = entity.getDynamicProperty(E_SEALED) === true;
            const id = typeof index === "number" ? shardId(index) : "";

            const lastId = entity.getDynamicProperty(E_LAST_RECORD_ID);
            const lastSealedId = world.getDynamicProperty(W_LAST_SEALED_RECORD_ID);

            if (
                !sealed &&
                id &&
                worldStructures.has(id) &&
                typeof lastId === "number" &&
                Number.isSafeInteger(lastId) &&
                typeof lastSealedId === "number" &&
                Number.isSafeInteger(lastSealedId) &&
                lastId <= lastSealedId
            ) {
                const verified = verifySavedShardRoundTrip(id, entity);

                if (!verified.ok) {
                    dbWarn(
                        `STALE ACTIVE NOT REMOVED: ${id} exists but failed archive verification: ` +
                            `${verified.error}. The live entity is being preserved.`,
                    );

                    active.push(entity);
                    continue;
                }

                dbWarn(
                    `STALE ACTIVE CLEANUP: removing unsealed entity for already-sealed ` +
                        `${id}; entity IDs end at ${lastId}, sealed history ends at ${lastSealedId}.`,
                );

                try {
                    entity.remove();
                } catch {}
                continue;
            }

            // A crash can leave the live entity behind after the structure was saved.
            if (sealed && id && worldStructures.has(id)) {
                const lastId = entity.getDynamicProperty(E_LAST_RECORD_ID);
                if (typeof lastId === "number" && Number.isSafeInteger(lastId)) {
                    const oldLast = world.getDynamicProperty(W_LAST_SEALED_RECORD_ID);
                    if (typeof oldLast !== "number" || lastId > oldLast) {
                        world.setDynamicProperty(W_LAST_SEALED_RECORD_ID, lastId);
                    }
                }

                try {
                    entity.remove();
                } catch {}
                continue;
            }

            // If sealing was interrupted before a structure was created, reopen the original entity for writes.
            if (sealed && (!id || !worldStructures.has(id))) {
                entity.setDynamicProperty(E_SEALED, false);
                entity.setDynamicProperty(E_CHECKSUM, undefined);
                entity.setDynamicProperty(E_SEALED_AT, undefined);
                try {
                    entity.removeTag(SEALED_TAG);
                } catch {}
                try {
                    entity.addTag(ACTIVE_TAG);
                } catch {}
            }

            if (entity.getDynamicProperty(E_SEALED) !== true) {
                active.push(entity);
            }
        } catch {}
    }
    if (active.length > 1) {
        safetyBlocked = true;
        forgetActiveEntity();

        dbWarn(
            `DATA SAFETY STOP: found ${active.length} loaded active money-log entities. ` +
                "No new records will be written until the duplicate state is resolved.",
        );

        for (let i = 0; i < active.length; i++) {
            const entity = active[i];

            try {
                const loc = entity.location;

                dbWarn(
                    `DUPLICATE ACTIVE ${i + 1}/${active.length}: ` +
                        `runtimeId=${entity.id}, ` +
                        `shard=${entity.getDynamicProperty(E_SHARD_INDEX)}, ` +
                        `records=${entity.getDynamicProperty(E_RECORD_COUNT)}, ` +
                        `pages=${entity.getDynamicProperty(E_PAGE_COUNT)}, ` +
                        `IDs=${entity.getDynamicProperty(E_FIRST_RECORD_ID)}..${entity.getDynamicProperty(E_LAST_RECORD_ID)}, ` +
                        `created=${entity.getDynamicProperty(E_CREATED_AT)}, ` +
                        `worldId=${entity.getDynamicProperty(E_WORLD_ID)}, ` +
                        `dimension=${entity.dimension.id}, ` +
                        `location=${Math.floor(loc.x)},${Math.floor(loc.y)},${Math.floor(loc.z)}`,
                );
            } catch (e) {
                dbWarn(`Could not inspect duplicate active entity ${i + 1}: ${errorText(e)}`);
            }
        }

        return undefined;
    }

    if (active.length === 1) {
        rememberActiveEntity(active[0]);
        safetyBlocked = false;

        try {
            world.setDynamicProperty(W_ACTIVE_OPEN, true);
            world.setDynamicProperty(W_ACTIVE_SHARD_INDEX, active[0].getDynamicProperty(E_SHARD_INDEX));
        } catch {}

        return active[0];
    }

    forgetActiveEntity();
    return undefined;
}

function createActiveShard(player) {
    if (!(player instanceof Player)) {
        throw new Error("Cannot create an active money-log shard without a player anchor.");
    }

    const index = nextAvailableShardIndex();
    const firstRecordId = nextRecordIdForNewShard();
    const worldId = getLilyMoneyWorldId() ?? "UNKNOWN";

    const entity = player.dimension.spawnEntity(STORAGE_TYPE, storageLocation(player));

    entity.addTag(STORAGE_TAG);
    entity.addTag(ACTIVE_TAG);

    // Keep the storage entity invisible if a client supplies a renderer.
    try {
        entity.addEffect("invisibility", 20_000_000, {
            amplifier: 0,
            showParticles: false,
        });
    } catch {}

    try {
        entity.nameTag = "";
    } catch {}

    entity.setDynamicProperty(E_DB_FORMAT, DB_FORMAT_VERSION);
    entity.setDynamicProperty(E_RECORD_FORMAT, RECORD_FORMAT_VERSION);
    entity.setDynamicProperty(E_KIND, "money_history");
    entity.setDynamicProperty(E_WORLD_ID, worldId);
    entity.setDynamicProperty(E_SHARD_INDEX, index);
    entity.setDynamicProperty(E_CREATED_AT, Date.now().toString());
    entity.setDynamicProperty(E_TARGET_BYTES, SHARD_TARGET_BYTES);
    entity.setDynamicProperty(E_RECORD_COUNT, 0);
    entity.setDynamicProperty(E_FIRST_RECORD_ID, firstRecordId);
    entity.setDynamicProperty(E_LAST_RECORD_ID, firstRecordId - 1);
    entity.setDynamicProperty(E_PAGE_COUNT, 0);
    entity.setDynamicProperty(E_JOB_BATCH_STATE, undefined);
    entity.setDynamicProperty(E_SEALED, false);

    world.setDynamicProperty(W_ACTIVE_OPEN, true);
    world.setDynamicProperty(W_ACTIVE_SHARD_INDEX, index);

    rememberActiveEntity(entity);
    safetyBlocked = false;

    dbInfo(
        `Active shard ${index} created. First record ID=${firstRecordId}; ` + `rotate target=${SHARD_TARGET_BYTES.toLocaleString()} bytes.`,
    );

    return entity;
}

function ensureActiveShard(anchorPlayer = null) {
    if (!getMoneyLoggingEnabled()) return undefined;
    if (safetyBlocked || deathRecoveryInProgress || startupRecoveryInProgress) {
        return undefined;
    }

    const entity = recoverLoadedStorageState();
    if (entity?.isValid) return entity;

    // Creating a replacement here could split history if the original entity is merely unloaded.
    if (world.getDynamicProperty(W_ACTIVE_OPEN) === true) {
        safetyBlocked = true;
        dbWarn(
            "DATA SAFETY STOP: the world says an active money-log shard exists, " +
                "but it is not loaded. Refusing to create a second active shard.",
        );
        return undefined;
    }

    const player = anchorPlayer instanceof Player ? anchorPlayer : world.getAllPlayers()[0];

    if (!(player instanceof Player)) return undefined;
    return createActiveShard(player);
}

function pageKey(index) {
    return `${E_PAGE_PREFIX}${index}`;
}

function appendLine(entity, line) {
    if (line.length > PAGE_CHARS) {
        throw new Error(`One money-log record is ${line.length} chars; max is ${PAGE_CHARS}.`);
    }

    let pageCount = entity.getDynamicProperty(E_PAGE_COUNT);
    if (typeof pageCount !== "number" || pageCount < 0) pageCount = 0;

    let pageIndex = Math.max(0, Math.floor(pageCount) - 1);
    let page = "";

    if (pageCount > 0) {
        const existing = entity.getDynamicProperty(pageKey(pageIndex));
        page = typeof existing === "string" ? existing : "";
    }

    if (page.length > 0 && page.length + line.length > PAGE_CHARS) {
        pageIndex++;
        page = "";
        pageCount = pageIndex + 1;
    } else if (pageCount === 0) {
        pageCount = 1;
    }

    entity.setDynamicProperty(pageKey(pageIndex), page + line);
    entity.setDynamicProperty(E_PAGE_COUNT, pageCount);
}

function readPages(entity) {
    const pageCount = entity.getDynamicProperty(E_PAGE_COUNT);
    if (typeof pageCount !== "number" || pageCount < 0) {
        throw new Error(`Invalid money-log page_count: ${pageCount}`);
    }

    const pages = [];
    for (let i = 0; i < pageCount; i++) {
        const value = entity.getDynamicProperty(pageKey(i));
        if (typeof value !== "string") {
            throw new Error(`Missing/non-string money-log page ${i}.`);
        }
        pages.push(value);
    }
    return pages;
}

function fnv1a32Strings(strings) {
    let hash = 0x811c9dc5;

    for (const text of strings) {
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
        }
    }

    return (hash >>> 0).toString(16).padStart(8, "0");
}

function verifySavedShardRoundTrip(structureId, sourceEntity) {
    if (!sourceEntity?.isValid) {
        return { ok: false, error: "source entity is invalid" };
    }

    let dimension;
    let location;

    try {
        dimension = sourceEntity.dimension;
        location = sourceEntity.location;
    } catch (e) {
        return { ok: false, error: errorText(e) };
    }

    let sourceChecksum;

    try {
        sourceChecksum = fnv1a32Strings(readPages(sourceEntity));
    } catch (e) {
        return { ok: false, error: `source pages invalid: ${errorText(e)}` };
    }

    const expected = {
        kind: sourceEntity.getDynamicProperty(E_KIND),
        worldId: sourceEntity.getDynamicProperty(E_WORLD_ID),
        shardIndex: sourceEntity.getDynamicProperty(E_SHARD_INDEX),
        recordCount: sourceEntity.getDynamicProperty(E_RECORD_COUNT),
        firstId: sourceEntity.getDynamicProperty(E_FIRST_RECORD_ID),
        lastId: sourceEntity.getDynamicProperty(E_LAST_RECORD_ID),
        pageCount: sourceEntity.getDynamicProperty(E_PAGE_COUNT),
    };

    const beforeIds = new Set();

    try {
        for (const entity of dimension.getEntities({ type: STORAGE_TYPE })) {
            try {
                beforeIds.add(entity.id);
            } catch {}
        }
    } catch (e) {
        return { ok: false, error: `could not scan before placement: ${errorText(e)}` };
    }

    const placeAt = {
        x: Math.floor(location.x) + 8,
        y: Math.floor(location.y),
        z: Math.floor(location.z),
    };

    try {
        world.structureManager.place(structureId, dimension, placeAt, {
            includeBlocks: false,
            includeEntities: true,
        });
    } catch (e) {
        return { ok: false, error: `structure placement failed: ${errorText(e)}` };
    }

    const placed = [];

    try {
        for (const entity of dimension.getEntities({ type: STORAGE_TYPE })) {
            try {
                if (!beforeIds.has(entity.id)) {
                    placed.push(entity);
                }
            } catch {}
        }

        if (placed.length !== 1) {
            return {
                ok: false,
                error: `expected 1 stored entity after placement, found ${placed.length}`,
            };
        }

        const copy = placed[0];

        const copyChecksum = fnv1a32Strings(readPages(copy));

        if (
            copy.getDynamicProperty(E_KIND) !== expected.kind ||
            copy.getDynamicProperty(E_WORLD_ID) !== expected.worldId ||
            copy.getDynamicProperty(E_SHARD_INDEX) !== expected.shardIndex ||
            copy.getDynamicProperty(E_RECORD_COUNT) !== expected.recordCount ||
            copy.getDynamicProperty(E_FIRST_RECORD_ID) !== expected.firstId ||
            copy.getDynamicProperty(E_LAST_RECORD_ID) !== expected.lastId ||
            copy.getDynamicProperty(E_PAGE_COUNT) !== expected.pageCount ||
            copy.getDynamicProperty(E_SEALED) !== true ||
            copy.getDynamicProperty(E_CHECKSUM) !== sourceChecksum ||
            copyChecksum !== sourceChecksum
        ) {
            return {
                ok: false,
                error: "stored entity metadata/pages did not match the source shard",
            };
        }

        return { ok: true };
    } catch (e) {
        return { ok: false, error: errorText(e) };
    } finally {
        for (const entity of placed) {
            try {
                entity.remove();
            } catch {}
        }
    }
}

function emergencyRecoveryPageKey(index) {
    return `${W_DEATH_RECOVERY_PAGE_PREFIX}${index}`;
}

function clearEmergencyDeathSnapshot() {
    let pageCount = 0;

    try {
        const raw = world.getDynamicProperty(W_DEATH_RECOVERY_META);

        if (typeof raw === "string" && raw) {
            try {
                const meta = JSON.parse(raw);

                if (Number.isSafeInteger(meta?.pageCount) && meta.pageCount >= 0) {
                    pageCount = meta.pageCount;
                }
            } catch {}
        }
    } catch {}

    for (let i = 0; i < pageCount; i++) {
        try {
            world.setDynamicProperty(emergencyRecoveryPageKey(i), undefined);
        } catch {}
    }

    try {
        world.setDynamicProperty(W_DEATH_RECOVERY_META, undefined);
    } catch {}
}

function persistEmergencyDeathSnapshot(snapshot) {
    if (!snapshot) {
        throw new Error("Cannot persist an empty death-recovery snapshot.");
    }

    if (
        !Number.isSafeInteger(snapshot.shardIndex) ||
        !Number.isSafeInteger(snapshot.recordCount) ||
        !Number.isSafeInteger(snapshot.pageCount)
    ) {
        throw new Error("Death-recovery snapshot metadata is invalid.");
    }

    if (!Array.isArray(snapshot.pages) || snapshot.pages.length !== snapshot.pageCount) {
        throw new Error("Death-recovery snapshot page count does not match captured pages.");
    }

    // Keep page data in separate world properties so the metadata does not duplicate the whole shard.
    const metadataProperties = [];

    for (const [key, value] of snapshot.properties ?? []) {
        if (typeof key === "string" && key.startsWith(E_PAGE_PREFIX)) {
            continue;
        }

        metadataProperties.push([key, value]);
    }

    // Publish the recovery metadata last. It marks the backup as ready after all pages have been written.
    for (let i = 0; i < snapshot.pages.length; i++) {
        const page = snapshot.pages[i];

        if (typeof page !== "string") {
            throw new Error(`Death-recovery page ${i} is not a string.`);
        }

        world.setDynamicProperty(emergencyRecoveryPageKey(i), page);
    }

    const meta = {
        version: 1,

        shardIndex: snapshot.shardIndex,

        recordCount: snapshot.recordCount,

        pageCount: snapshot.pageCount,

        checksum: snapshot.checksum,

        reportedBytes: snapshot.reportedBytes,

        location: snapshot.location,

        dimensionId: snapshot.dimensionId,

        deadEntityId: typeof snapshot.deadEntityId === "string" ? snapshot.deadEntityId : null,

        properties: metadataProperties,

        capturedAt: Date.now(),
    };

    const raw = JSON.stringify(meta);

    world.setDynamicProperty(W_DEATH_RECOVERY_META, raw);

    dbInfo(
        `Emergency death snapshot persisted: shard=${snapshot.shardIndex}, ` +
            `records=${snapshot.recordCount.toLocaleString()}, ` +
            `pages=${snapshot.pageCount}, checksum=${snapshot.checksum}.`,
    );

    return true;
}

function loadEmergencyDeathSnapshot() {
    const raw = world.getDynamicProperty(W_DEATH_RECOVERY_META);

    if (typeof raw !== "string" || raw.length === 0) {
        return undefined;
    }

    let meta;

    try {
        meta = JSON.parse(raw);
    } catch {
        throw new Error("Emergency death snapshot metadata JSON is invalid.");
    }

    if (
        meta?.version !== 1 ||
        !Number.isSafeInteger(meta.shardIndex) ||
        !Number.isSafeInteger(meta.recordCount) ||
        !Number.isSafeInteger(meta.pageCount) ||
        meta.pageCount < 0 ||
        typeof meta.checksum !== "string" ||
        !Array.isArray(meta.properties) ||
        !meta.location ||
        typeof meta.dimensionId !== "string"
    ) {
        throw new Error("Emergency death snapshot metadata is invalid.");
    }

    const pages = [];

    for (let i = 0; i < meta.pageCount; i++) {
        const value = world.getDynamicProperty(emergencyRecoveryPageKey(i));

        if (typeof value !== "string") {
            throw new Error(`Emergency death snapshot page ${i} is missing.`);
        }

        pages.push(value);
    }

    const checksum = fnv1a32Strings(pages);

    if (checksum !== meta.checksum) {
        throw new Error(`Emergency death snapshot checksum mismatch: ` + `expected ${meta.checksum}, got ${checksum}.`);
    }

    // Restore the property list expected by the shard recovery code.
    const properties = [...meta.properties];

    for (let i = 0; i < pages.length; i++) {
        properties.push([pageKey(i), pages[i]]);
    }

    return {
        shardIndex: meta.shardIndex,

        recordCount: meta.recordCount,

        pageCount: meta.pageCount,

        properties,

        pages,

        checksum,

        reportedBytes: meta.reportedBytes,

        location: {
            x: Number(meta.location.x),
            y: Number(meta.location.y),
            z: Number(meta.location.z),
        },

        dimensionId: meta.dimensionId,

        deadEntityId: typeof meta.deadEntityId === "string" ? meta.deadEntityId : undefined,
    };
}

function primeDeadStorageQuarantineFromEmergencySnapshot() {
    const raw = world.getDynamicProperty(W_DEATH_RECOVERY_META);

    if (typeof raw !== "string" || raw.length === 0) {
        return true;
    }

    const snapshot = loadEmergencyDeathSnapshot();

    if (typeof snapshot?.deadEntityId === "string" && snapshot.deadEntityId.length > 0) {
        quarantineDeadStorageEntityId(snapshot.deadEntityId);
    }

    return true;
}

function cleanStaleEmergencySnapshotIfSafe() {
    try {
        const raw = world.getDynamicProperty(W_DEATH_RECOVERY_META);
        if (typeof raw !== "string" || raw.length === 0) return;

        // Once the shard is closed, its emergency backup is stale even if cleanup was interrupted.
        if (world.getDynamicProperty(W_ACTIVE_OPEN) !== true) {
            clearEmergencyDeathSnapshot();
            dbInfo("Removed stale emergency death snapshot because no active shard is open.");
            return;
        }

        let meta;
        try {
            meta = JSON.parse(raw);
        } catch {
            // Preserve malformed backup data while an active shard is expected so recovery can report the damage.
            return;
        }

        if (!Number.isSafeInteger(meta?.shardIndex)) return;

        const structureId = shardId(meta.shardIndex);
        if (world.structureManager.getWorldStructureIds().includes(structureId)) {
            clearEmergencyDeathSnapshot();
            dbInfo(`Removed stale emergency death snapshot because ${structureId} is already archived.`);
        }
    } catch {
        // Leave questionable backups for recovery to validate without interrupting startup cleanup.
    }
}

function captureDeadActiveShard(deadEntity) {
    // Read the dying entity's properties inside its death event while the snapshot is still accessible.
    const kind = deadEntity.getDynamicProperty(E_KIND);
    const sealed = deadEntity.getDynamicProperty(E_SEALED) === true;

    if (kind !== "money_history" || sealed) return undefined;

    const shardIndex = deadEntity.getDynamicProperty(E_SHARD_INDEX);
    const recordCount = deadEntity.getDynamicProperty(E_RECORD_COUNT);
    const pageCount = deadEntity.getDynamicProperty(E_PAGE_COUNT);

    if (typeof shardIndex !== "number" || typeof recordCount !== "number" || typeof pageCount !== "number") {
        throw new Error(`Dead money shard metadata invalid: shard=${shardIndex}, records=${recordCount}, pages=${pageCount}`);
    }

    // Read the known shard properties explicitly instead of relying on property enumeration after death.
    const metadataKeys = [
        E_DB_FORMAT,
        E_RECORD_FORMAT,
        E_KIND,
        E_WORLD_ID,
        E_SHARD_INDEX,
        E_CREATED_AT,
        E_SEALED_AT,
        E_TARGET_BYTES,
        E_RECORD_COUNT,
        E_FIRST_RECORD_ID,
        E_LAST_RECORD_ID,
        E_FIRST_TIME,
        E_LAST_TIME,
        E_PAGE_COUNT,
        E_JOB_BATCH_STATE,
        E_CHECKSUM,
        E_SEALED,
    ];

    const properties = [];
    for (const key of metadataKeys) {
        const value = deadEntity.getDynamicProperty(key);
        if (value !== undefined) properties.push([key, value]);
    }

    const pages = [];
    for (let i = 0; i < pageCount; i++) {
        const key = pageKey(i);
        const value = deadEntity.getDynamicProperty(key);
        if (typeof value !== "string") {
            throw new Error(`Dead money shard page ${i} was not readable.`);
        }
        pages.push(value);

        // Include page properties in the restore list as well as the checksum input. Recovery needs the actual page contents.
        properties.push([key, value]);
    }

    let reportedBytes;
    try {
        reportedBytes = deadEntity.getDynamicPropertyTotalByteCount();
    } catch {
        reportedBytes = undefined;
    }

    let deadEntityId;
    try {
        deadEntityId = deadEntity.id;
    } catch {
        deadEntityId = undefined;
    }

    let location = activeLocationCache;
    let dimensionId = activeDimensionIdCache;

    try {
        const loc = deadEntity.location;
        location = { x: loc.x, y: loc.y, z: loc.z };
    } catch {}

    try {
        dimensionId = deadEntity.dimension.id;
    } catch {}

    if (!location || !dimensionId) {
        throw new Error("Dead money shard location/dimension could not be captured.");
    }

    return {
        shardIndex: Math.floor(shardIndex),
        recordCount: Math.floor(recordCount),
        pageCount: Math.floor(pageCount),
        properties,
        pages,
        checksum: fnv1a32Strings(pages),
        reportedBytes,
        location: { ...location },
        dimensionId,
        deadEntityId,
    };
}

function verifyRecoveredActiveShard(entity, snapshot) {
    const errors = [];

    if (entity.getDynamicProperty(E_SHARD_INDEX) !== snapshot.shardIndex) {
        errors.push("shard_index mismatch");
    }

    if (entity.getDynamicProperty(E_RECORD_COUNT) !== snapshot.recordCount) {
        errors.push("record_count mismatch");
    }

    if (entity.getDynamicProperty(E_PAGE_COUNT) !== snapshot.pageCount) {
        errors.push("page_count mismatch");
    }

    const checksum = fnv1a32Strings(readPages(entity));
    if (checksum !== snapshot.checksum) {
        errors.push(`checksum expected ${snapshot.checksum}, got ${checksum}`);
    }

    for (const [key, expected] of snapshot.properties) {
        // Reopen the recovered copy for verification and sealing.
        if (key === E_CHECKSUM || key === E_SEALED_AT || key === E_SEALED) continue;

        const actual = entity.getDynamicProperty(key);

        if (typeof expected === "object" && expected !== null) {
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                errors.push(`${key} object mismatch`);
            }
        } else if (actual !== expected) {
            errors.push(`${key} mismatch`);
        }

        if (errors.length >= 12) break;
    }

    if (entity.getDynamicProperty(E_SEALED) !== false) {
        errors.push("recovered entity is not marked active/unsealed");
    }

    return {
        ok: errors.length === 0,
        errors,
        checksum,
        reportedBytes: entity.getDynamicPropertyTotalByteCount(),
    };
}

function restoreDeadActiveShard(snapshot, onSuccess = null) {
    let recoveryEntity;

    try {
        // Death and removal are separate events. Quarantine the dead runtime ID so discovery can still detect a different live shard.
        const existing = findLoadedStorageEntities().filter((entity) => {
            try {
                return entity.getDynamicProperty(E_SEALED) !== true;
            } catch {
                return false;
            }
        });

        if (existing.length > 0) {
            throw new Error(
                `Refusing death recovery because ${existing.length} ` +
                    `different active money storage entity/entities are already loaded.`,
            );
        }

        let dimension = world.getDimension(normalizeDimensionIdForLookup(snapshot.dimensionId));
        let restoreLocation = snapshot.location;

        // Prefer air near a player so the replacement avoids the hazard that killed the original entity.
        const recoveryAnchor = world.getAllPlayers()[0];
        if (recoveryAnchor instanceof Player) {
            dimension = recoveryAnchor.dimension;
            restoreLocation = storageLocation(recoveryAnchor);
        }

        const entity = dimension.spawnEntity(STORAGE_TYPE, restoreLocation);
        recoveryEntity = entity;
        entity.addTag(STORAGE_TAG);
        entity.addTag(ACTIVE_TAG);

        try {
            entity.addEffect("invisibility", 20_000_000, {
                amplifier: 0,
                showParticles: false,
            });
        } catch {}

        try {
            entity.nameTag = "";
        } catch {}

        for (const [key, value] of snapshot.properties) {
            entity.setDynamicProperty(key, value);
        }

        entity.setDynamicProperty(E_SEALED, false);
        entity.setDynamicProperty(E_CHECKSUM, undefined);
        entity.setDynamicProperty(E_SEALED_AT, undefined);
        try {
            entity.removeTag(SEALED_TAG);
        } catch {}
        try {
            entity.addTag(ACTIVE_TAG);
        } catch {}

        world.setDynamicProperty(W_ACTIVE_OPEN, true);
        world.setDynamicProperty(W_ACTIVE_SHARD_INDEX, snapshot.shardIndex);
        rememberActiveEntity(entity);

        const verify = verifyRecoveredActiveShard(entity, snapshot);
        if (!verify.ok) {
            throw new Error(`verification failed: ${verify.errors.join("; ")}`);
        }

        dbInfo(
            `DEATH RECOVERY PASS: shard=${snapshot.shardIndex}, ` +
                `records=${snapshot.recordCount.toLocaleString()}, pages=${snapshot.pageCount}, ` +
                `checksum=${verify.checksum}, DP bytes=${verify.reportedBytes.toLocaleString()}.`,
        );

        // Seal the recovered shard immediately. Sealing flushes pending job rewards before capturing the structure.
        const sealed = sealActiveShard(entity, false, null);

        // Release the backup only after the recovered shard has been archived or handled as empty.
        clearEmergencyDeathSnapshot();

        dbInfo(`DEATH RECOVERY SEALED: recovered shard ${snapshot.shardIndex} archived as ` + `${sealed.structureId ?? "empty"}.`);

        deathRecoveryInProgress = false;
        safetyBlocked = false;

        const player = world.getAllPlayers()[0];
        if (player instanceof Player && getMoneyLoggingEnabled()) {
            createActiveShard(player);
            flushPendingPlayerJoins(player);
            dbInfo("Death recovery complete; recording continued on a fresh shard.");
        } else {
            dbInfo(
                "Death recovery complete; no player is currently available. " + "The next money event will create the fresh active shard.",
            );
        }

        if (typeof onSuccess === "function") {
            try {
                onSuccess();
            } catch (e) {
                bootCheckpointPending = true;
                dbWarn(
                    `Post-recovery startup continuation failed: ${errorText(e)}. ` +
                        "The recovered shard is safe; the world-load checkpoint will be retried later.",
                );
            }
        }

        return "success";
    } catch (e) {
        // Remove the partial reconstruction so its death cannot trigger a second recovery. Keep the missing shard open and block writes.
        try {
            if (recoveryEntity?.isValid) recoveryEntity.remove();
        } catch {}

        forgetActiveEntity();
        deathRecoveryInProgress = false;
        safetyBlocked = true;
        dbWarn(`DEATH RECOVERY FAIL: ${errorText(e)}. ` + "Persistent writes are safety-blocked; logging history will not silently fork.");
        return "failed";
    }
}

function sealActiveShard(entity, continueRecording = false, anchorPlayer = null, options = {}) {
    if (!entity?.isValid) {
        throw new Error("Active money-log entity is not valid.");
    }

    // Flush pending job rewards before archiving so they are included in the saved history.
    if (options.skipJobBatchFlush !== true) {
        const flushed = flushPendingJobBatches(entity, anchorPlayer, "before_seal", { rotateAfter: false });

        if (!flushed) {
            throw new Error("Could not flush pending JOB_REWARD batches before sealing.");
        }
    }

    const recordCount = entity.getDynamicProperty(E_RECORD_COUNT);
    const shardIndex = entity.getDynamicProperty(E_SHARD_INDEX);

    if (typeof recordCount !== "number" || typeof shardIndex !== "number") {
        throw new Error("Active shard metadata is invalid.");
    }

    if (recordCount <= 0) {
        entity.remove();
        forgetActiveEntity();
        world.setDynamicProperty(W_ACTIVE_OPEN, false);
        world.setDynamicProperty(W_ACTIVE_SHARD_INDEX, undefined);

        if (continueRecording) {
            const player = anchorPlayer instanceof Player ? anchorPlayer : world.getAllPlayers()[0];
            if (player instanceof Player) createActiveShard(player);
        }

        return { empty: true, saved: false };
    }

    // Structure capture reads the entity at its current position. Move it near the current anchor in case its original area has unloaded.
    try {
        const movedForSeal = relocateStorageForSeal(entity, anchorPlayer);
        if (movedForSeal) {
            dbInfo(`Active shard ${Math.floor(shardIndex)} relocated beside a loaded anchor before sealing.`);
        }
    } catch (e) {
        throw new Error(`Could not relocate active shard into a loaded seal area: ${errorText(e)}`);
    }

    const pages = readPages(entity);
    const checksum = fnv1a32Strings(pages);
    const structureId = shardId(shardIndex);

    if (world.structureManager.getWorldStructureIds().includes(structureId)) {
        throw new Error(`Refusing to overwrite existing structure ${structureId}.`);
    }

    entity.setDynamicProperty(E_CHECKSUM, checksum);
    entity.setDynamicProperty(E_SEALED_AT, Date.now().toString());
    entity.setDynamicProperty(E_SEALED, true);
    try {
        entity.removeTag(ACTIVE_TAG);
    } catch {}
    try {
        entity.addTag(SEALED_TAG);
    } catch {}

    const loc = entity.location;
    const from = {
        x: Math.floor(loc.x) - 1,
        y: Math.floor(loc.y) - 1,
        z: Math.floor(loc.z) - 1,
    };
    const to = {
        x: Math.floor(loc.x) + 1,
        y: Math.floor(loc.y) + 2,
        z: Math.floor(loc.z) + 1,
    };

    const started = Date.now();

    try {
        world.structureManager.createFromWorld(structureId, entity.dimension, from, to, {
            includeBlocks: false,
            includeEntities: true,
            saveMode: StructureSaveMode.World,
        });
    } catch (e) {
        // Leave the original shard writable if structure creation fails.
        try {
            entity.setDynamicProperty(E_SEALED, false);
            entity.setDynamicProperty(E_CHECKSUM, undefined);
            entity.setDynamicProperty(E_SEALED_AT, undefined);
            entity.removeTag(SEALED_TAG);
            entity.addTag(ACTIVE_TAG);
        } catch {}
        throw e;
    }

    if (!world.structureManager.getWorldStructureIds().includes(structureId)) {
        try {
            entity.setDynamicProperty(E_SEALED, false);
            entity.setDynamicProperty(E_CHECKSUM, undefined);
            entity.setDynamicProperty(E_SEALED_AT, undefined);
            entity.removeTag(SEALED_TAG);
            entity.addTag(ACTIVE_TAG);
        } catch {}

        throw new Error(`Structure ${structureId} was not enumerable after save. Original entity was NOT removed.`);
    }

    const verified = verifySavedShardRoundTrip(structureId, entity);

    if (!verified.ok) {
        try {
            world.structureManager.delete(structureId);
        } catch {}

        try {
            entity.setDynamicProperty(E_SEALED, false);
            entity.setDynamicProperty(E_CHECKSUM, undefined);
            entity.setDynamicProperty(E_SEALED_AT, undefined);
            entity.removeTag(SEALED_TAG);
            entity.addTag(ACTIVE_TAG);
        } catch {}

        throw new Error(
            `Structure ${structureId} failed round-trip verification: ` + `${verified.error}. Original entity was NOT removed.`,
        );
    }

    const saveMs = Date.now() - started;
    const bytes = entity.getDynamicPropertyTotalByteCount();
    const firstId = entity.getDynamicProperty(E_FIRST_RECORD_ID);
    const lastId = entity.getDynamicProperty(E_LAST_RECORD_ID);

    // Advance the world metadata only after the structure exists.
    if (typeof lastId === "number" && Number.isSafeInteger(lastId)) {
        world.setDynamicProperty(W_LAST_SEALED_RECORD_ID, lastId);
    }

    world.setDynamicProperty(W_ACTIVE_OPEN, false);
    world.setDynamicProperty(W_ACTIVE_SHARD_INDEX, undefined);

    entity.remove();
    forgetActiveEntity();

    dbInfo(
        `SEALED ${structureId}: ${recordCount.toLocaleString()} records, ` +
            `${bytes.toLocaleString()} DP bytes, IDs ${firstId}..${lastId}, ` +
            `checksum=${checksum}, save=${saveMs} ms.`,
    );

    if (continueRecording) {
        const player = anchorPlayer instanceof Player ? anchorPlayer : world.getAllPlayers()[0];

        if (player instanceof Player && getMoneyLoggingEnabled()) {
            createActiveShard(player);
        }
    }

    return {
        empty: false,
        saved: true,
        structureId,
        recordCount,
        bytes,
        firstId,
        lastId,
        checksum,
        saveMs,
    };
}

function emptyJobBatchState() {
    return {
        version: 1,
        players: [],
    };
}

function loadJobBatchState(entity) {
    const raw = entity.getDynamicProperty(E_JOB_BATCH_STATE);

    if (raw === undefined || raw === "") {
        return emptyJobBatchState();
    }

    if (typeof raw !== "string") {
        throw new Error("JOB_REWARD batch state is not a string.");
    }

    let state;

    try {
        state = JSON.parse(raw);
    } catch {
        throw new Error("JOB_REWARD batch state JSON is invalid.");
    }

    if (!state || state.version !== 1 || !Array.isArray(state.players)) {
        throw new Error("JOB_REWARD batch state schema is invalid.");
    }

    return state;
}

function hasPendingJobBatches(state) {
    return Array.isArray(state?.players) && state.players.some((player) => Array.isArray(player?.rewards) && player.rewards.length > 0);
}

function nextJobBatchId(entity, timestamp = Date.now()) {
    const shardIndex = safeInteger(entity.getDynamicProperty(E_SHARD_INDEX), 0);

    const timePart = safeInteger(timestamp, Date.now()).toString(36);

    const randomPart = Math.floor(Math.random() * 0x1_0000_0000)
        .toString(36)
        .padStart(7, "0");

    // A crash could persist a history page ahead of a sequence counter. Avoid reusing a batch ID on restart.
    return `${shardIndex.toString(36)}:${timePart}:${randomPart}`;
}

function persistedJobBatchIds(entity) {
    const ids = new Set();

    for (const page of readPages(entity)) {
        for (const line of page.split("\n")) {
            if (!line) continue;

            let record;

            try {
                record = JSON.parse(line);
            } catch {
                throw new Error("Could not parse an existing record while checking JOB batch IDs.");
            }

            if (!Array.isArray(record) || record[2] !== MONEY_LOG_EVENT.JOB_REWARD) {
                continue;
            }

            const payload = record[3];

            // Payload order: identity, name, job, action, source, quantity, amount, balanceAfter, batchStartedAt, batchEndedAt, batchId.
            const batchId = Array.isArray(payload) ? payload[10] : undefined;

            if (typeof batchId === "string" && batchId.length > 0) {
                ids.add(batchId);
            }
        }
    }

    return ids;
}

function oldestPendingJobBatchStart(state) {
    let oldest;

    for (const player of state?.players ?? []) {
        const startedAt = safeInteger(player?.windowStartedAt, null);

        if (startedAt === null) continue;

        if (oldest === undefined || startedAt < oldest) {
            oldest = startedAt;
        }
    }

    return oldest;
}

function buildJobBatchFlushPlan(state) {
    const planned = [];

    for (const player of state.players) {
        if (!player || !Array.isArray(player.rewards) || player.rewards.length === 0) {
            continue;
        }

        const baseBalance = safeInteger(player.baseBalance, null);

        const finalBalance = safeInteger(player.finalBalance, null);

        if (baseBalance === null || finalBalance === null) {
            throw new Error(`JOB_REWARD batch balance metadata is invalid for ${player.name ?? "Unknown"}.`);
        }

        // Within a player's batch, order each reward source by the time of its last payout.
        const rewards = [...player.rewards].sort((a, b) => {
            const byEnd = safeInteger(a?.updatedAt, 0) - safeInteger(b?.updatedAt, 0);

            if (byEnd !== 0) return byEnd;

            return String(a?.batchId ?? "").localeCompare(String(b?.batchId ?? ""));
        });

        let runningBalance = baseBalance;

        for (const reward of rewards) {
            const quantity = safeInteger(reward.quantity, null);

            const amountCents = safeInteger(reward.amountCents, null);

            const startedAt = safeInteger(reward.startedAt, null);

            const updatedAt = safeInteger(reward.updatedAt, null);

            if (
                quantity === null ||
                quantity <= 0 ||
                amountCents === null ||
                startedAt === null ||
                updatedAt === null ||
                typeof reward.batchId !== "string" ||
                !reward.batchId
            ) {
                throw new Error("JOB_REWARD batch row contains invalid data.");
            }

            runningBalance += amountCents;

            if (!Number.isSafeInteger(runningBalance)) {
                throw new Error("JOB_REWARD batch running balance exceeded safe integer range.");
            }

            // The first eight fields preserve the DB-v1 layout for existing viewers. The three trailing fields describe the batch.
            const payload = [
                cleanText(player.identityId),
                cleanText(player.name),
                cleanText(reward.jobId).toUpperCase(),
                cleanText(reward.kind).toUpperCase(),
                cleanText(reward.sourceId),

                quantity,
                amountCents,
                runningBalance,

                startedAt,
                updatedAt,
                reward.batchId,
            ];

            planned.push({
                timestamp: updatedAt,
                batchId: reward.batchId,
                payload,
            });
        }

        if (runningBalance !== finalBalance) {
            throw new Error(
                `JOB_REWARD batch balance mismatch for ${player.name ?? "Unknown"}: computed ${runningBalance}, expected ${finalBalance}.`,
            );
        }
    }

    // Keep timestamps ordered across players as well as within each player's batch.
    planned.sort((a, b) => {
        const byTime = a.timestamp - b.timestamp;

        if (byTime !== 0) {
            return byTime;
        }

        return a.batchId.localeCompare(b.batchId);
    });

    return planned;
}

function appendPersistentRecordToEntity(entity, type, payload, options = {}) {
    const countRaw = entity.getDynamicProperty(E_RECORD_COUNT);

    const firstIdRaw = entity.getDynamicProperty(E_FIRST_RECORD_ID);

    if (typeof countRaw !== "number" || typeof firstIdRaw !== "number") {
        throw new Error("Active shard record metadata is invalid.");
    }

    const recordCount = Math.floor(countRaw);

    const recordId = Math.floor(firstIdRaw) + recordCount;

    const timestamp = safeInteger(options.timestamp, Date.now());

    const record = [recordId, timestamp, type, payload];

    const line = JSON.stringify(record) + "\n";

    appendLine(entity, line);

    const nextCount = recordCount + 1;

    entity.setDynamicProperty(E_RECORD_COUNT, nextCount);

    entity.setDynamicProperty(E_LAST_RECORD_ID, recordId);

    entity.setDynamicProperty(E_LAST_TIME, String(timestamp));

    if (nextCount === 1) {
        entity.setDynamicProperty(E_FIRST_TIME, String(timestamp));
    }

    if (options.deferRotation === true) {
        return true;
    }

    const bytes = entity.getDynamicPropertyTotalByteCount();

    const targetRaw = entity.getDynamicProperty(E_TARGET_BYTES);

    const targetBytes = typeof targetRaw === "number" ? targetRaw : SHARD_TARGET_BYTES;

    if (bytes >= targetBytes) {
        const nextAnchor = options.anchorPlayer instanceof Player ? options.anchorPlayer : world.getAllPlayers()[0];

        sealActiveShard(entity, nextAnchor instanceof Player, nextAnchor, {
            skipJobBatchFlush: true,
        });
    }

    return true;
}

function flushPendingJobBatches(entity, anchorPlayer = null, _reason = "manual", options = {}) {
    if (!entity?.isValid) {
        return false;
    }

    const state = loadJobBatchState(entity);

    if (!hasPendingJobBatches(state)) {
        return true;
    }

    const plan = buildJobBatchFlushPlan(state);

    const existingIds = persistedJobBatchIds(entity);

    // Keep the pending state until all records are written. After a crash, batch IDs identify rows already added to history.
    for (const row of plan) {
        if (existingIds.has(row.batchId)) {
            continue;
        }

        appendPersistentRecordToEntity(entity, MONEY_LOG_EVENT.JOB_REWARD, row.payload, {
            timestamp: row.timestamp,
            anchorPlayer,
            deferRotation: true,
        });

        existingIds.add(row.batchId);
    }

    entity.setDynamicProperty(E_JOB_BATCH_STATE, undefined);

    if (options.rotateAfter !== false) {
        const bytes = entity.getDynamicPropertyTotalByteCount();

        const targetRaw = entity.getDynamicProperty(E_TARGET_BYTES);

        const targetBytes = typeof targetRaw === "number" ? targetRaw : SHARD_TARGET_BYTES;

        if (bytes >= targetBytes) {
            const nextAnchor = anchorPlayer instanceof Player ? anchorPlayer : world.getAllPlayers()[0];

            sealActiveShard(entity, nextAnchor instanceof Player, nextAnchor, {
                skipJobBatchFlush: true,
            });
        }
    }

    return true;
}

function addJobRewardToState(entity, state, payload, timestamp) {
    const [identityId, name, jobId, kind, sourceId, quantity, amountCents, balanceAfter] = payload;

    if (
        !identityId ||
        !Number.isSafeInteger(quantity) ||
        quantity <= 0 ||
        !Number.isSafeInteger(amountCents) ||
        !Number.isSafeInteger(balanceAfter)
    ) {
        throw new Error("JOB_REWARD cannot be batched because its normalized payload is invalid.");
    }

    let player = state.players.find((row) => row?.identityId === identityId);

    if (!player) {
        const baseBalance = balanceAfter - amountCents;

        if (!Number.isSafeInteger(baseBalance)) {
            throw new Error("JOB_REWARD batch base balance exceeded safe integer range.");
        }

        player = {
            identityId,
            name,

            windowStartedAt: timestamp,

            // Capture the balance before the first reward in this window.
            baseBalance,

            finalBalance: balanceAfter,

            lastUpdatedAt: timestamp,

            rewards: [],
        };

        state.players.push(player);
    } else {
        // A score change outside the job system breaks the expected balance chain. Keep the gap visible in history.
        const previousBalance = safeInteger(player.finalBalance, null);

        if (previousBalance === null || previousBalance + amountCents !== balanceAfter) {
            return {
                balanceDiscontinuity: true,
            };
        }

        player.name = name;
        player.finalBalance = balanceAfter;
        player.lastUpdatedAt = timestamp;
    }

    let reward = player.rewards.find((row) => row?.jobId === jobId && row?.kind === kind && row?.sourceId === sourceId);

    if (!reward) {
        reward = {
            batchId: nextJobBatchId(entity, timestamp),

            jobId,
            kind,
            sourceId,

            quantity: 0,
            amountCents: 0,

            startedAt: timestamp,
            updatedAt: timestamp,
        };

        player.rewards.push(reward);
    }

    const nextQuantity = reward.quantity + quantity;

    const nextAmount = reward.amountCents + amountCents;

    if (!Number.isSafeInteger(nextQuantity) || !Number.isSafeInteger(nextAmount)) {
        throw new Error("JOB_REWARD batch totals exceeded safe integer range.");
    }

    reward.quantity = nextQuantity;
    reward.amountCents = nextAmount;
    reward.updatedAt = timestamp;

    return {
        balanceDiscontinuity: false,
    };
}

function queuePersistentJobReward(payload, options = {}) {
    if (!getMoneyLoggingEnabled()) {
        return false;
    }

    if (safetyBlocked) {
        return false;
    }

    const anchor = options.anchorPlayer instanceof Player ? options.anchorPlayer : getAnchorPlayer(options.data);

    const entity = ensureActiveShard(anchor);

    if (!entity) {
        dbWarn("Could not write JOB_REWARD: no safe active shard is available.");
        return false;
    }

    try {
        const timestamp = safeInteger(options.timestamp, Date.now());

        let state = loadJobBatchState(entity);

        // The oldest pending player's reward sets the deadline for the whole batch.
        const oldest = oldestPendingJobBatchStart(state);

        if (oldest !== undefined && timestamp - oldest >= JOB_BATCH_WINDOW_MS) {
            flushPendingJobBatches(entity, anchor, "30_second_window", {
                rotateAfter: false,
            });

            state = emptyJobBatchState();
        }

        let result = addJobRewardToState(entity, state, payload, timestamp);

        // Close the old batch before recording the new balance so the intervening change stays visible.
        if (result.balanceDiscontinuity) {
            flushPendingJobBatches(entity, anchor, "balance_discontinuity", {
                rotateAfter: false,
            });

            state = emptyJobBatchState();

            result = addJobRewardToState(entity, state, payload, timestamp);

            if (result.balanceDiscontinuity) {
                throw new Error("Fresh JOB_REWARD batch unexpectedly contains a balance discontinuity.");
            }
        }

        let raw = JSON.stringify(state);

        // The oversized edit exists only in memory. Flush the previously saved state before starting a smaller batch.
        if (raw.length > JOB_BATCH_STATE_MAX_CHARS) {
            const previousState = loadJobBatchState(entity);

            if (hasPendingJobBatches(previousState)) {
                flushPendingJobBatches(entity, anchor, "batch_state_size", {
                    rotateAfter: false,
                });
            }

            state = emptyJobBatchState();

            result = addJobRewardToState(entity, state, payload, timestamp);

            if (result.balanceDiscontinuity) {
                throw new Error("Fresh JOB_REWARD batch unexpectedly contains a balance discontinuity.");
            }

            raw = JSON.stringify(state);

            if (raw.length > JOB_BATCH_STATE_MAX_CHARS) {
                throw new Error(`One JOB_REWARD pending state is too large (${raw.length} chars).`);
            }
        }

        // Persist the compact pending state on each reward so a block break does not need its own history row.
        entity.setDynamicProperty(E_JOB_BATCH_STATE, raw);

        // Count the pending property toward the shard size limit.
        const bytes = entity.getDynamicPropertyTotalByteCount();

        const targetRaw = entity.getDynamicProperty(E_TARGET_BYTES);

        const targetBytes = typeof targetRaw === "number" ? targetRaw : SHARD_TARGET_BYTES;

        if (bytes >= targetBytes) {
            flushPendingJobBatches(entity, anchor, "shard_target", {
                rotateAfter: false,
            });

            if (entity?.isValid && entity.getDynamicPropertyTotalByteCount() >= targetBytes) {
                sealActiveShard(entity, anchor instanceof Player, anchor, {
                    skipJobBatchFlush: true,
                });
            }
        }

        return true;
    } catch (e) {
        safetyBlocked = true;

        dbWarn(`WRITE ERROR for JOB_REWARD batch: ${errorText(e)}. ` + "Persistent writes are safety-blocked to prevent a history fork.");

        return false;
    }
}

function appendPersistentRecord(type, payload, options = {}) {
    if (!getMoneyLoggingEnabled()) {
        return false;
    }

    if (safetyBlocked) {
        return false;
    }

    const anchor = options.anchorPlayer instanceof Player ? options.anchorPlayer : getAnchorPlayer(options.data);

    const entity = ensureActiveShard(anchor);

    if (!entity) {
        dbWarn(`Could not write ${type}: no safe active shard is available.`);

        return false;
    }

    try {
        // Flush job summaries before a transfer, session record or checkpoint so history retains the order of events.
        if (type !== MONEY_LOG_EVENT.JOB_REWARD) {
            flushPendingJobBatches(entity, anchor, `before_${type}`, {
                rotateAfter: false,
            });
        }

        return appendPersistentRecordToEntity(entity, type, payload, {
            ...options,
            anchorPlayer: anchor,
        });
    } catch (e) {
        safetyBlocked = true;

        dbWarn(`WRITE ERROR for ${type}: ${errorText(e)}. ` + "Persistent writes are safety-blocked to prevent a history fork.");

        return false;
    }
}

function normalizeMoneyEvent(type, data) {
    const amount = safeInteger(data?.amountCents, null);
    const quantity = safeInteger(data?.quantity, null);
    const balanceAfter = safeInteger(data?.balanceAfter, null);

    switch (type) {
        case MONEY_LOG_EVENT.PAY: {
            const actor = actorInfo(data?.actor ?? data?.source);
            const target = actorInfo(data?.target);
            return [
                actor.identityId,
                actor.name,
                target.identityId,
                target.name,
                amount,
                safeInteger(data?.actorBalanceAfter, null),
                safeInteger(data?.targetBalanceAfter, null),
            ];
        }

        case MONEY_LOG_EVENT.SHOP_BUY:
        case MONEY_LOG_EVENT.SHOP_SELL: {
            const player = actorInfo(data?.player ?? data?.actor);
            return [
                player.identityId,
                player.name,
                cleanText(data?.itemId ?? ""),
                cleanText(data?.itemName ?? data?.item ?? ""),
                quantity,
                amount,
                balanceAfter,
            ];
        }

        case MONEY_LOG_EVENT.AH_BUY: {
            const buyer = actorInfo(data?.buyer ?? data?.player ?? data?.actor);
            const seller = actorInfo(
                data?.seller ?? {
                    identityId: data?.sellerIdentityId,
                    name: data?.sellerName,
                },
            );

            return [
                buyer.identityId,
                buyer.name,
                seller.identityId,
                seller.name,
                cleanText(data?.itemId ?? ""),
                cleanText(data?.itemName ?? data?.item ?? ""),
                quantity,
                amount,
                safeInteger(data?.buyerBalanceAfter ?? data?.balanceAfter, null),
                safeInteger(data?.sellerBalanceAfter, null),
            ];
        }

        case MONEY_LOG_EVENT.BUY_COMMAND:
        case MONEY_LOG_EVENT.SELL_COMMAND: {
            const actor = actorInfo(data?.actor);
            const target = actorInfo(data?.target ?? data?.player);

            return [
                actor.identityId,
                actor.name,
                target.identityId,
                target.name,
                cleanText(data?.itemId ?? data?.item ?? ""),
                quantity,
                amount,
                balanceAfter,
            ];
        }

        case MONEY_LOG_EVENT.ADD_MONEY:
        case MONEY_LOG_EVENT.REMOVE_MONEY:
        case MONEY_LOG_EVENT.SET_MONEY: {
            const actor = actorInfo(data?.actor);
            const target = actorInfo(data?.target ?? data?.player);

            return [actor.identityId, actor.name, target.identityId, target.name, amount, balanceAfter];
        }

        case MONEY_LOG_EVENT.JOB_REWARD: {
            const player = actorInfo(data?.player ?? data?.actor);

            return [
                player.identityId,
                player.name,
                cleanText(data?.jobId).toUpperCase(),
                cleanText(data?.kind).toUpperCase(),
                cleanText(data?.sourceId ?? data?.id),
                quantity,
                amount,
                balanceAfter,
            ];
        }

        default:
            throw new Error(`Unsupported money event type: ${type}`);
    }
}

export function logMoneyEvent(type, data = {}) {
    if (!getMoneyLoggingEnabled()) {
        return false;
    }

    let payload;

    try {
        payload = normalizeMoneyEvent(type, data);
    } catch (e) {
        dbWarn(`Rejected ${type}: ${errorText(e)}`);

        return false;
    }

    const anchor = getAnchorPlayer(data);

    if (type === MONEY_LOG_EVENT.JOB_REWARD) {
        return queuePersistentJobReward(payload, {
            anchorPlayer: anchor,
            data,
        });
    }

    return appendPersistentRecord(type, payload, {
        anchorPlayer: anchor,
        data,
    });
}

function getAllKnownBalanceRows() {
    const { dollarsObj, centsObj } = ensureMoneyObjectives();
    if (!dollarsObj || !centsObj) return [];

    const dollarScores = getScoreMap(dollarsObj);
    const centScores = getScoreMap(centsObj);
    const knownPlayers = getAllSavedPlayerNameEntries();
    const rows = [];

    for (const entry of knownPlayers) {
        const identityId = String(entry?.identityId ?? "");
        if (!identityId) continue;

        const hasDollars = dollarScores.has(identityId);
        const hasCents = centScores.has(identityId);

        if (!hasDollars && !hasCents) {
            rows.push([identityId, null]);
            continue;
        }

        rows.push([identityId, (dollarScores.get(identityId) ?? 0) * 100 + (centScores.get(identityId) ?? 0)]);
    }

    return rows;
}

export function logBalanceCheckpoint(player, reason = "manual") {
    if (!getMoneyLoggingEnabled()) return false;
    if (!(player instanceof Player)) return false;

    try {
        const { dollarsObj, centsObj } = ensureMoneyObjectives();
        if (!dollarsObj || !centsObj) return false;

        const p = playerInfo(player);
        const balance = getBalanceCents(dollarsObj, centsObj, player);

        return appendPersistentRecord(MONEY_LOG_EVENT.BALANCE_CHECKPOINT, [p.identityId, p.name, balance, cleanText(reason)], {
            anchorPlayer: player,
        });
    } catch (e) {
        dbWarn(`BALANCE_CHECKPOINT failed: ${errorText(e)}`);
        return false;
    }
}

export function logFullBalanceCheckpoint(reason = "manual", anchorPlayer = null) {
    if (!getMoneyLoggingEnabled()) return false;

    try {
        const rows = getAllKnownBalanceRows();
        const anchor = anchorPlayer instanceof Player ? anchorPlayer : world.getAllPlayers()[0];

        if (!(anchor instanceof Player)) {
            bootCheckpointPending = true;
            return false;
        }

        // Checkpoints store scoreboard identity IDs and balances in cents. Names are stored separately in the name database.
        const payload = [cleanText(reason), rows.length, rows];

        const ok = appendPersistentRecord(MONEY_LOG_EVENT.FULL_BALANCE_CHECKPOINT, payload, { anchorPlayer: anchor });

        if (ok) bootCheckpointPending = false;
        return ok;
    } catch (e) {
        dbWarn(`FULL_BALANCE_CHECKPOINT failed: ${errorText(e)}`);
        return false;
    }
}

try {
    world.afterEvents.entityDie.subscribe((event) => {
        const deadEntity = event.deadEntity;

        try {
            if (!deadEntity) return;

            let typeId = "";
            try {
                typeId = deadEntity.typeId;
            } catch {
                return;
            }
            if (typeId !== STORAGE_TYPE) return;

            const kind = deadEntity.getDynamicProperty(E_KIND);
            const sealed = deadEntity.getDynamicProperty(E_SEALED) === true;
            if (kind !== "money_history" || sealed) return;

            const deadShardIndex = deadEntity.getDynamicProperty(E_SHARD_INDEX);
            const expectedShardIndex = world.getDynamicProperty(W_ACTIVE_SHARD_INDEX);

            if (typeof expectedShardIndex === "number" && typeof deadShardIndex === "number" && expectedShardIndex !== deadShardIndex) {
                safetyBlocked = true;
                dbWarn(
                    `DATA SAFETY STOP: money storage entity for shard ${deadShardIndex} died, ` +
                        `but world metadata expected active shard ${expectedShardIndex}.`,
                );
                return;
            }

            if (!getMoneyLoggingEnabled()) {
                forgetActiveEntity();
                world.setDynamicProperty(W_ACTIVE_OPEN, false);
                world.setDynamicProperty(W_ACTIVE_SHARD_INDEX, undefined);
                return;
            }

            if (deathRecoveryInProgress) {
                let deadEntityId;

                try {
                    deadEntityId = deadEntity.id;
                } catch {}

                if (typeof deadEntityId === "string" && deadEntityId.length > 0) {
                    try {
                        quarantineDeadStorageEntityId(deadEntityId);
                    } catch (e) {
                        dbWarn(`Could not quarantine second dead money storage entity: ${errorText(e)}`);
                    }
                }

                safetyBlocked = true;
                forgetActiveEntity();

                dbWarn("DATA SAFETY STOP: a second active money storage entity died while death recovery was already in progress.");
                return;
            }

            deathRecoveryInProgress = true;

            const snapshot = captureDeadActiveShard(deadEntity);

            if (!snapshot) {
                deathRecoveryInProgress = false;
                return;
            }

            // Persist the dead entity's runtime ID before recovery so discovery still ignores it after a restart.
            if (typeof snapshot.deadEntityId === "string" && snapshot.deadEntityId.length > 0) {
                quarantineDeadStorageEntityId(snapshot.deadEntityId);
            }

            // Save the emergency snapshot before spawning a replacement. Startup can then retry if reconstruction fails.
            try {
                persistEmergencyDeathSnapshot(snapshot);
            } catch (e) {
                deathRecoveryInProgress = false;
                safetyBlocked = true;

                dbWarn(
                    `DEATH RECOVERY SAFETY STOP: captured the dead shard, ` +
                        `but could not persist its emergency backup: ${errorText(e)}.`,
                );

                return;
            }

            forgetActiveEntity();

            let deathCause = "unknown";
            try {
                deathCause = String(event.damageSource?.cause ?? "unknown");
            } catch {}

            dbInfo(
                `DEATH CAPTURE PASS: deadEntity DPs were readable. cause=${deathCause}, ` +
                    `shard=${snapshot.shardIndex}, records=${snapshot.recordCount.toLocaleString()}, ` +
                    `pages=${snapshot.pageCount}, checksum=${snapshot.checksum}, ` +
                    `DP bytes=${snapshot.reportedBytes?.toLocaleString?.() ?? "unavailable"}.`,
            );

            // Rebuild next tick so a replacement cannot be caught in the same /kill command.
            system.run(() => restoreDeadActiveShard(snapshot));
        } catch (e) {
            deathRecoveryInProgress = false;
            safetyBlocked = true;
            forgetActiveEntity();
            dbWarn(
                `DEATH CAPTURE FAIL: could not read the dead money storage entity: ${errorText(e)}. ` +
                    "Persistent writes are safety-blocked.",
            );
        }
    });
} catch (e) {
    dbWarn(`Could not subscribe to entityDie recovery: ${errorText(e)}`);
}

// Keep the runtime ID quarantined until the removal event confirms the dead entity is gone.
try {
    world.afterEvents.entityRemove.subscribe((event) => {
        try {
            const removedId = cleanText(event?.removedEntityId);

            if (!removedId) return;

            if (releaseDeadStorageEntityId(removedId)) {
                dbInfo(`Dead storage entity quarantine cleared after entityRemove: ${removedId}.`);
            }
        } catch (e) {
            dbWarn(`Could not process entityRemove quarantine cleanup: ${errorText(e)}`);
        }
    });
} catch (e) {
    dbWarn(`Could not subscribe to entityRemove quarantine cleanup: ${errorText(e)}`);
}

const pendingJoins = [];
const MAX_PENDING_JOINS = 128;

function queuePlayerJoinSnapshot(snapshot) {
    if (!snapshot) return;

    // Bound the queue of join snapshots held while storage is recovering.
    if (pendingJoins.length >= MAX_PENDING_JOINS) {
        pendingJoins.shift();
        dbWarn("PLAYER_JOIN pending queue was full; oldest queued join was dropped.");
    }
    pendingJoins.push(snapshot);
}

function flushPendingPlayerJoins(anchorPlayer = null) {
    if (!getMoneyLoggingEnabled()) {
        pendingJoins.length = 0;
        return true;
    }
    if (safetyBlocked || startupRecoveryInProgress || deathRecoveryInProgress || pendingJoins.length === 0) {
        return false;
    }

    const anchor = anchorPlayer instanceof Player ? anchorPlayer : world.getAllPlayers()[0];
    if (!(anchor instanceof Player)) return false;

    const queuedCount = pendingJoins.length;

    while (pendingJoins.length > 0) {
        const snapshot = pendingJoins[0];
        const ok = appendPersistentRecord(MONEY_LOG_EVENT.PLAYER_JOIN, [snapshot.identityId, snapshot.name, snapshot.balance], {
            timestamp: snapshot.timestamp,
            anchorPlayer: anchor,
        });

        if (!ok) return false;
        pendingJoins.shift();
    }

    if (queuedCount > 0) {
        dbInfo(`Flushed ${queuedCount} queued PLAYER_JOIN record(s) after database recovery.`);
    }
    return true;
}

export function logPlayerJoin(player) {
    if (!getMoneyLoggingEnabled()) return false;
    if (!(player instanceof Player)) return false;

    try {
        const { dollarsObj, centsObj } = ensureMoneyObjectives();
        if (!dollarsObj || !centsObj) return false;

        const p = playerInfo(player);
        const snapshot = {
            identityId: p.identityId,
            name: p.name,
            balance: getBalanceCents(dollarsObj, centsObj, player),
            timestamp: Date.now(),
        };

        // Capture the player's balance and identity at join time, even if recovery delays the write.
        if (startupRecoveryInProgress || deathRecoveryInProgress) {
            queuePlayerJoinSnapshot(snapshot);
            return true;
        }

        // A join and startup discovery can share a tick. Give the expected shard time to load before treating it as missing.
        if (world.getDynamicProperty(W_ACTIVE_OPEN) === true) {
            const loaded = recoverLoadedStorageState();
            if (!loaded?.isValid) {
                queuePlayerJoinSnapshot(snapshot);
                if (!safetyBlocked && !startupRecoveryInProgress) {
                    startupRecoveryInProgress = true;
                    retryStartupActiveShard(player, 0);
                }
                return true;
            }
        }

        if (bootCheckpointPending) {
            const checkpointOk = logFullBalanceCheckpoint("world_load", player);
            if (!checkpointOk) {
                if (!safetyBlocked) {
                    queuePlayerJoinSnapshot(snapshot);
                    return true;
                }
                return false;
            }
        }

        const ok = appendPersistentRecord(MONEY_LOG_EVENT.PLAYER_JOIN, [snapshot.identityId, snapshot.name, snapshot.balance], {
            timestamp: snapshot.timestamp,
            anchorPlayer: player,
        });

        if (!ok && !safetyBlocked) {
            queuePlayerJoinSnapshot(snapshot);
            return true;
        }

        return ok;
    } catch (e) {
        dbWarn(`PLAYER_JOIN failed: ${errorText(e)}`);
        return false;
    }
}

const pendingLeaves = new Map();

function captureLeavingPlayer(player) {
    if (!getMoneyLoggingEnabled()) return;
    if (!(player instanceof Player)) return;

    try {
        const { dollarsObj, centsObj } = ensureMoneyObjectives();
        if (!dollarsObj || !centsObj) return;

        const p = playerInfo(player);
        const balance = getBalanceCents(dollarsObj, centsObj, player);
        const playerRuntimeId = String(player.id ?? p.identityId ?? p.name);

        let leaveLocation;
        let leaveDimensionId = "";
        try {
            const loc = player.location;
            leaveLocation = { x: loc.x, y: loc.y, z: loc.z };
            leaveDimensionId = player.dimension.id;
        } catch {}

        pendingLeaves.set(playerRuntimeId, {
            identityId: p.identityId,
            name: p.name,
            balance,
            timestamp: Date.now(),
            location: leaveLocation,
            dimensionId: leaveDimensionId,
        });
    } catch {}
}

try {
    world.beforeEvents.playerLeave.subscribe((event) => {
        try {
            captureLeavingPlayer(event.player);
        } catch {}
    });
} catch {}

try {
    world.afterEvents.playerLeave.subscribe((event) => {
        if (!getMoneyLoggingEnabled()) {
            pendingLeaves.delete(String(event.playerId ?? ""));
            return;
        }

        const runtimeId = String(event.playerId ?? "");
        const pending = pendingLeaves.get(runtimeId);
        if (pending) pendingLeaves.delete(runtimeId);

        if (pending) {
            appendPersistentRecord(MONEY_LOG_EVENT.PLAYER_LEAVE, [pending.identityId, pending.name, pending.balance], {
                timestamp: pending.timestamp,
                anchorPlayer: world.getAllPlayers()[0],
            });
        } else {
            // When the player object is gone, record the session boundary without guessing its balance.
            appendPersistentRecord(MONEY_LOG_EVENT.PLAYER_LEAVE, ["", cleanText(event.playerName), null], {
                anchorPlayer: world.getAllPlayers()[0],
            });
        }

        // When the last player leaves, try to seal the partial shard before its area unloads.
        if (world.getAllPlayers().length === 0) {
            const entity = recoverLoadedStorageState();
            if (entity?.isValid) {
                try {
                    const leaveSealAnchor =
                        pending?.location && pending?.dimensionId
                            ? {
                                  location: pending.location,
                                  dimensionId: pending.dimensionId,
                              }
                            : null;
                    sealActiveShard(entity, false, leaveSealAnchor);
                } catch (e) {
                    dbWarn(`Last-player-leave seal failed: ${errorText(e)}`);
                }
            }
        }
    });
} catch {}

export function setMoneyLoggingEnabled(enabled, changedBy = null) {
    const next = enabled === true;
    const current = getMoneyLoggingEnabled();

    if (current === next) return true;

    const anchor = changedBy instanceof Player ? changedBy : getAnchorPlayer({ actor: changedBy });

    if (!next) {
        // Record the closing boundary while logging is still enabled.
        if (!(anchor instanceof Player)) {
            dbWarn("Cannot safely disable money logging without a player anchor.");
            return false;
        }

        const checkpointOk = logFullBalanceCheckpoint("logging_disabled", anchor);
        if (!checkpointOk) {
            dbWarn("Logging was NOT disabled because the final full checkpoint failed.");
            return false;
        }

        const actor = actorInfo(changedBy);
        const disabledAt = Date.now();
        const markerOk = appendPersistentRecord(MONEY_LOG_EVENT.LOGGING_DISABLED, [actor.identityId, actor.name], {
            timestamp: disabledAt,
            anchorPlayer: anchor,
        });

        if (!markerOk) {
            dbWarn("Logging was NOT disabled because the LOGGING_DISABLED marker failed.");
            return false;
        }

        const entity = recoverLoadedStorageState();
        if (entity?.isValid) {
            try {
                sealActiveShard(entity, false, anchor);
            } catch (e) {
                dbWarn(`Logging was NOT disabled because final shard sealing failed: ${errorText(e)}`);
                return false;
            }
        }

        if (!setSavedMoneyLoggingEnabled(false)) {
            dbWarn("Failed to persist the OFF setting after sealing the database.");
            return false;
        }

        return true;
    }

    // Enable writes before creating the first records after the gap.
    if (!setSavedMoneyLoggingEnabled(true)) return false;

    try {
        if (!(anchor instanceof Player)) {
            throw new Error("Cannot enable money logging without a player anchor.");
        }

        safetyBlocked = false;
        deathRecoveryInProgress = false;
        startupRecoveryInProgress = false;
        forgetActiveEntity();
        world.setDynamicProperty(W_ACTIVE_OPEN, false);
        world.setDynamicProperty(W_ACTIVE_SHARD_INDEX, undefined);
        cleanStaleEmergencySnapshotIfSafe();

        const actor = actorInfo(changedBy);
        const enabledAt = Date.now();

        const markerOk = appendPersistentRecord(MONEY_LOG_EVENT.LOGGING_ENABLED, [actor.identityId, actor.name], {
            timestamp: enabledAt,
            anchorPlayer: anchor,
        });

        const checkpointOk = markerOk && logFullBalanceCheckpoint("logging_enabled", anchor);

        if (!markerOk || !checkpointOk) {
            throw new Error("Could not write the enable marker/checkpoint.");
        }

        return true;
    } catch (e) {
        dbWarn(`Enable failed: ${errorText(e)}. Reverting the saved setting to OFF.`);
        try {
            setSavedMoneyLoggingEnabled(false);
        } catch {}
        return false;
    }
}

try {
    system.runInterval(() => {
        try {
            if (!getMoneyLoggingEnabled()) {
                return;
            }

            if (safetyBlocked || startupRecoveryInProgress || deathRecoveryInProgress) {
                return;
            }

            const entity = recoverLoadedStorageState();

            if (!entity?.isValid) {
                return;
            }

            const state = loadJobBatchState(entity);

            const oldest = oldestPendingJobBatchStart(state);

            if (oldest === undefined) {
                return;
            }

            if (Date.now() - oldest < JOB_BATCH_WINDOW_MS) {
                return;
            }

            const anchor = world.getAllPlayers()[0];

            flushPendingJobBatches(entity, anchor, "30_second_timer", {
                rotateAfter: true,
            });
        } catch (e) {
            safetyBlocked = true;

            dbWarn(`JOB_REWARD batch timer failed: ${errorText(e)}. ` + "Persistent writes are safety-blocked to prevent a history fork.");
        }
    }, 20);
} catch (e) {
    dbWarn(`Could not start JOB_REWARD batch timer: ${errorText(e)}`);
}

function finishStartupMoneyLogging(anchor) {
    startupRecoveryInProgress = false;

    const entity = ensureActiveShard(anchor);
    if (!entity) {
        bootCheckpointPending = true;
        return false;
    }

    logFullBalanceCheckpoint("world_load", anchor);
    flushPendingPlayerJoins(anchor);
    return true;
}

function retryStartupActiveShard(anchor, attempt = 0) {
    if (!getMoneyLoggingEnabled()) {
        startupRecoveryInProgress = false;
        return;
    }

    // The active entity may take several ticks to appear in a world query.
    const loaded = recoverLoadedStorageState();

    if (loaded?.isValid) {
        startupRecoveryInProgress = false;
        safetyBlocked = false;

        logFullBalanceCheckpoint("world_load", anchor);

        flushPendingPlayerJoins(anchor);
        return;
    }

    if (world.getDynamicProperty(W_ACTIVE_OPEN) !== true) {
        startupRecoveryInProgress = false;
        finishStartupMoneyLogging(anchor);
        return;
    }

    // Retry for about ten seconds at normal tick speed before starting missing-shard recovery.
    if (attempt < 40) {
        system.runTimeout(() => retryStartupActiveShard(anchor, attempt + 1), 5);

        return;
    }

    // Reconstruct a missing shard only from a death snapshot. An unloaded shard could otherwise reappear alongside its replacement.
    try {
        const snapshot = loadEmergencyDeathSnapshot();

        if (snapshot) {
            const expectedShardRaw = world.getDynamicProperty(W_ACTIVE_SHARD_INDEX);

            if (typeof expectedShardRaw !== "number" || !Number.isSafeInteger(Math.floor(expectedShardRaw))) {
                throw new Error(`World metadata contains an invalid active shard index: ${expectedShardRaw}.`);
            }

            const expectedShard = Math.floor(expectedShardRaw);

            if (expectedShard !== snapshot.shardIndex) {
                throw new Error(
                    `Emergency death snapshot belongs to shard ${snapshot.shardIndex}, ` +
                        `but world metadata expects active shard ${expectedShard}.`,
                );
            }

            dbWarn(
                `Active shard ${snapshot.shardIndex} did not become queryable after startup retries, ` +
                    `but a valid persisted death-recovery snapshot exists. ` +
                    `Attempting automatic reconstruction.`,
            );

            startupRecoveryInProgress = false;
            deathRecoveryInProgress = true;
            safetyBlocked = false;

            // Run the startup checkpoint only after reconstruction, verification, sealing and creation of the next shard succeed.
            restoreDeadActiveShard(snapshot, () => {
                const checkpointAnchor = anchor instanceof Player ? anchor : world.getAllPlayers()[0];

                if (checkpointAnchor instanceof Player) {
                    const checkpointOk = logFullBalanceCheckpoint("world_load", checkpointAnchor);

                    if (!checkpointOk) {
                        bootCheckpointPending = true;
                    }

                    flushPendingPlayerJoins(checkpointAnchor);
                } else {
                    bootCheckpointPending = true;
                }
            });

            return;
        }
    } catch (e) {
        startupRecoveryInProgress = false;
        deathRecoveryInProgress = false;
        safetyBlocked = true;
        bootCheckpointPending = true;

        dbWarn(
            `DATA SAFETY STOP: active shard is missing and its emergency ` +
                `death snapshot could not be validated: ${errorText(e)}. ` +
                `No new history will be written.`,
        );

        return;
    }

    startupRecoveryInProgress = false;
    deathRecoveryInProgress = false;
    safetyBlocked = true;
    bootCheckpointPending = true;

    dbWarn(
        "DATA SAFETY STOP: logging metadata says an active shard exists, " +
            "but the tick-world storage entity did not become queryable after " +
            "startup retries and no valid emergency death snapshot exists. " +
            "Persistent writes remain blocked to prevent a history fork.",
    );
}

export function initializeMoneyLogging() {
    if (!getMoneyLoggingEnabled()) return false;

    cleanStaleEmergencySnapshotIfSafe();

    try {
        // Quarantine the runtime ID from any saved death snapshot before the first startup query can find the dead entity.
        primeDeadStorageQuarantineFromEmergencySnapshot();
    } catch (e) {
        safetyBlocked = true;
        bootCheckpointPending = true;

        dbWarn(`DATA SAFETY STOP: could not initialize dead-entity quarantine from ` + `the emergency recovery snapshot: ${errorText(e)}.`);

        return false;
    }

    const anchor = world.getAllPlayers()[0];
    if (!(anchor instanceof Player)) {
        bootCheckpointPending = true;
        return false;
    }

    if (world.getDynamicProperty(W_ACTIVE_OPEN) === true) {
        startupRecoveryInProgress = true;
        retryStartupActiveShard(anchor, 0);
        return true;
    }

    return finishStartupMoneyLogging(anchor);
}
