import { niceIdName } from "../items/identifiers.js";
import { CONFIG } from "../../config.js";
import { system, world, Player } from "@minecraft/server";
import { DP_MAX, getCompiledJob, protectsBreak } from "./storage.js";
import { ensureMoneyObjectives, getBalanceCents, setBalanceFromTotalCents } from "../economy/balance.js";
import { playMoneySound } from "../players/preferences.js";
import { logMoneyEvent } from "../logging/moneylogging.js";

const JOB_PLACED_BLOCK_CLEANUP_INTERVAL_TICKS = Math.max(1, Math.floor(Number(CONFIG.JOB_PLACED_BLOCK_CLEANUP_INTERVAL_TICKS ?? 200)));
const JOB_TAG_PREFIX = "job:";
const JOB_STATS_DP_KEY = `lilymoney:job_stats_v1`;
const JOB_STATS_FLUSH_INTERVAL_TICKS = Math.max(1, Math.floor(Number(CONFIG.JOB_STATS_FLUSH_INTERVAL_TICKS ?? 400)));
const PLACED_TTL_TICKS = 20 * 60 * 30;
const _placedBlocks = new Map();

function _posKey(dimId, loc) {
    const x = Math.floor(loc.x);
    const y = Math.floor(loc.y);
    const z = Math.floor(loc.z);
    return `${dimId}|${x}|${y}|${z}`;
}

function _markPlaced(dimId, loc) {
    const now = system.currentTick;
    const key = _posKey(dimId, loc);

    // Reinsert the position so its new expiry follows all older entries.
    _placedBlocks.delete(key);

    _placedBlocks.set(key, now + PLACED_TTL_TICKS);
}

function _wasPlaced(dimId, loc) {
    const key = _posKey(dimId, loc);
    const exp = _placedBlocks.get(key);
    if (exp === undefined) return false;

    const now = system.currentTick;
    if (now >= exp) {
        _placedBlocks.delete(key);
        return false;
    }
    return true;
}
function _consumePlaced(dimId, loc) {
    _placedBlocks.delete(_posKey(dimId, loc));
}

system.runInterval(() => {
    const now = system.currentTick;
    let removed = 0;

    for (const [key, exp] of _placedBlocks) {
        // The map is ordered by expiry, so the first unexpired entry ends the scan.
        if (exp > now) break;

        _placedBlocks.delete(key);
        removed++;

        // Spread large cleanups across ticks.
        if (removed >= 2000) break;
    }
}, JOB_PLACED_BLOCK_CLEANUP_INTERVAL_TICKS);

// These crops only earn break rewards at full maturity.
const MATURE_RULES = {
    "minecraft:wheat": { state: "growth", max: 7 },
    "minecraft:carrots": { state: "growth", max: 7 },
    "minecraft:potatoes": { state: "growth", max: 7 },
    "minecraft:beetroot": { state: "growth", max: 3 },
    "minecraft:nether_wart": { state: "growth", max: 3 },
    "minecraft:cocoa": { state: "age", max: 2 },
};

function isMatureEnough(blockId, permutation) {
    const rule = MATURE_RULES[blockId];
    if (!rule) return true;
    try {
        const v = permutation?.getState(rule.state);
        return typeof v === "number" && v >= rule.max;
    } catch {
        return false;
    }
}

// Cache job tags because block events can fire repeatedly for the same player.
const _jobIdCacheByPlayerId = new Map();

export function getCurrentJobId(player) {
    const key = player?.id;
    if (key && _jobIdCacheByPlayerId.has(key)) return _jobIdCacheByPlayerId.get(key);

    const tags = player.getTags();
    const jobTags = tags.filter((t) => t.startsWith(JOB_TAG_PREFIX));

    if (jobTags.length === 0) {
        if (key) _jobIdCacheByPlayerId.set(key, null);
        return null;
    }

    const keep = jobTags[0].slice(JOB_TAG_PREFIX.length) || null;
    for (let i = 1; i < jobTags.length; i++) {
        try {
            player.removeTag(jobTags[i]);
        } catch {}
    }

    if (key) _jobIdCacheByPlayerId.set(key, keep);
    return keep;
}

export function setJob(player, jobIdOrNull) {
    for (const t of player.getTags()) {
        if (t.startsWith(JOB_TAG_PREFIX)) {
            try {
                player.removeTag(t);
            } catch {}
        }
    }
    if (jobIdOrNull) {
        try {
            player.addTag(`${JOB_TAG_PREFIX}${jobIdOrNull}`);
        } catch {}
    }

    if (player?.id) _jobIdCacheByPlayerId.set(player.id, jobIdOrNull || null);
}

try {
    world.afterEvents.playerSpawn.subscribe((ev) => {
        if (ev.initialSpawn && ev.player?.id) _jobIdCacheByPlayerId.delete(ev.player.id);
    });
} catch {}

try {
    world.afterEvents.playerLeave.subscribe((ev) => {
        const id = ev?.playerId ?? ev?.player?.id;
        if (id) _jobIdCacheByPlayerId.delete(id);
    });
} catch {}

// Buffer player statistics between saves.
let _statsBuffer = {};
let _statsDirty = false;

function loadStats() {
    const raw = world.getDynamicProperty(JOB_STATS_DP_KEY);
    if (raw === undefined) return { v: 1, players: {} };
    const parsed = JSON.parse(raw);
    if (parsed?.v !== 1 || !parsed.players || typeof parsed.players !== "object" || Array.isArray(parsed.players))
        throw new Error("Invalid saved job statistics.");
    return parsed;
}

function markEarn(player, jobId, kind, id, centsEarned, count = 1) {
    const name = player.name;

    if (!_statsBuffer[name]) {
        _statsBuffer[name] = { totalEarnedCents: 0, jobs: {} };
    }
    const p = _statsBuffer[name];
    p.totalEarnedCents += centsEarned;

    if (!p.jobs[jobId]) {
        p.jobs[jobId] = { earnedCents: 0, breakCount: 0, placeCount: 0, killCount: 0, pickupCount: 0 };
    }
    const j = p.jobs[jobId];
    j.earnedCents += centsEarned;

    if (kind === "break") j.breakCount += count;
    if (kind === "place") j.placeCount += count;
    if (kind === "kill") j.killCount += count;
    if (kind === "pickup") j.pickupCount += count;

    _statsDirty = true;
}

system.runInterval(() => {
    if (!_statsDirty) return;

    try {
        const base = loadStats();

        for (const [playerName, data] of Object.entries(_statsBuffer)) {
            if (!base.players[playerName]) base.players[playerName] = { totalEarnedCents: 0, jobs: {} };
            base.players[playerName].totalEarnedCents += data.totalEarnedCents;

            for (const [jobId, jd] of Object.entries(data.jobs)) {
                if (!base.players[playerName].jobs[jobId]) {
                    base.players[playerName].jobs[jobId] = { earnedCents: 0, breakCount: 0, placeCount: 0, killCount: 0, pickupCount: 0 };
                }
                const dst = base.players[playerName].jobs[jobId];
                dst.earnedCents += jd.earnedCents;
                dst.breakCount += jd.breakCount;
                dst.placeCount += jd.placeCount;
                dst.killCount += jd.killCount;
                dst.pickupCount += jd.pickupCount;
            }
        }

        const json = JSON.stringify(base);
        if (json.length > DP_MAX) throw new Error("Job statistics exceed the property limit.");
        world.setDynamicProperty(JOB_STATS_DP_KEY, json);
    } catch (error) {
        console.warn(`[Jobs] Statistics flush deferred: ${error}`);
        return;
    }

    _statsBuffer = {};
    _statsDirty = false;
}, JOB_STATS_FLUSH_INTERVAL_TICKS);

function payout(player, centsEarned, kind, id) {
    const { dollarsObj, centsObj } = ensureMoneyObjectives();
    const bal = getBalanceCents(dollarsObj, centsObj, player);
    const next = bal + centsEarned;
    const verb = { break: "Mined", place: "Placed", kill: "Killed", pickup: "Picked up" }[kind];
    setBalanceFromTotalCents(dollarsObj, centsObj, player, next, `${verb} ${niceIdName(id)}`.toLowerCase(), `job:${kind}:${id}`);

    playMoneySound(player);

    return next;
}

function handleReward(player, kind, id, count = 1) {
    if (!(player instanceof Player)) return;
    if (!id) return;
    if (count <= 0) return;

    const jobId = getCurrentJobId(player);
    if (!jobId) return;

    const job = getCompiledJob(jobId);
    if (!job || !job.enabled) return;

    const map = job[kind];
    if (!map) return;

    const per = map.get(id);
    if (!per || per <= 0) return;

    const total = per * count;
    if (!Number.isSafeInteger(total)) return;

    const balanceAfter = payout(player, total, kind, id);
    markEarn(player, jobId, kind, id, total, count);

    logMoneyEvent("JOB_REWARD", {
        player,
        jobId,
        kind,
        sourceId: id,
        quantity: count,
        amountCents: total,
        balanceAfter,
    });
}

if (world.afterEvents?.playerBreakBlock?.subscribe) {
    world.afterEvents.playerBreakBlock.subscribe((ev) => {
        try {
            const blockId =
                ev?.brokenBlockPermutation?.type?.id ?? ev?.block?.typeId ?? ev?.block?.type?.id ?? ev?.blockPermutation?.type?.id ?? null;

            if (!blockId) return;

            const perm = ev?.brokenBlockPermutation ?? ev?.blockPermutation ?? null;

            const rule = MATURE_RULES[blockId];
            const needsMature = !!rule;
            const mature = isMatureEnough(blockId, perm);

            if (protectsBreak(blockId)) {
                const dimId = ev.block.dimension.id;
                const loc = ev.block.location;

                if (_wasPlaced(dimId, loc)) {
                    _consumePlaced(dimId, loc);

                    // Placed non-crop blocks covered by this rule cannot earn a break reward.
                    if (!needsMature) return;

                    if (!mature) return;
                } else {
                    // The maturity rule also applies to naturally grown crops.
                    if (needsMature && !mature) return;
                }
            } else {
                if (needsMature && !mature) return;
            }

            handleReward(ev.player, "break", blockId, 1);
        } catch {}
    });
}

if (world.afterEvents?.playerPlaceBlock?.subscribe) {
    world.afterEvents.playerPlaceBlock.subscribe((ev) => {
        try {
            const blockId =
                ev?.block?.typeId ?? ev?.block?.type?.id ?? ev?.placedBlockPermutation?.type?.id ?? ev?.blockPermutation?.type?.id ?? null;

            if (blockId && protectsBreak(blockId)) {
                const dimId = ev.block.dimension.id;
                const loc = ev.block.location;
                _markPlaced(dimId, loc);
            }

            handleReward(ev.player, "place", blockId, 1);
        } catch {}
    });
}

if (world.afterEvents?.entityDie?.subscribe) {
    world.afterEvents.entityDie.subscribe((ev) => {
        try {
            const dead = ev?.deadEntity;
            const killer = ev?.damageSource?.damagingEntity;
            if (!(killer instanceof Player)) return;

            const typeId = dead?.typeId ?? dead?.type?.id ?? null;
            handleReward(killer, "kill", typeId, 1);
        } catch {}
    });
}
