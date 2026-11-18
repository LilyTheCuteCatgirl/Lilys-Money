// BP/scripts/commands/job.js
import { CommandPermissionLevel, CustomCommandStatus, Player, system, world } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";

import { CONFIG } from "../config.js";
import {
    ensureMoneyObjectives,
    getBalanceCents,
    setBalanceFromTotalCents,
    parseFloatToCents,
    formatCents,
    getCommandSource,
    isAdmin,
    setActionbarToast,
} from "../jsfunctions.js";

import { DEFAULT_JOBS, JOB_ICON_PRESETS } from "../defaults.js";
import { playMoneySound } from "../jsfunctions.js";

import { logMoneyEvent } from "../moneylogging.js";
import { getItemIconFromId } from "../ui/itemIcons.js";

function getRewardRuleIcon(type, id) {
    if (type === "kill") {
        return getItemIconFromId(`minecraft:${shortId(id)}_spawn_egg`);
    }

    return getItemIconFromId(id);
}

/* =========================================================
   Persistent storage
========================================================= */
const JOBS_DP_KEY_V2 = `lilymoney:jobs_v2`;
const JOBS_DP_KEY_V1 = `lilymoney:jobs_v1`; // migration read
const JOB_STATS_DP_KEY = `lilymoney:job_stats_v1`;
const DP_MAX = 32767;

const JOB_TAG_PREFIX = "job:";
const MAX_TOAST_TICKS = 40;

const JOB_PLACED_BLOCK_CLEANUP_INTERVAL_TICKS = Math.max(1, Math.floor(Number(CONFIG.JOB_PLACED_BLOCK_CLEANUP_INTERVAL_TICKS ?? 200)));

const JOBS_INIT_RETRY_INTERVAL_TICKS = Math.max(1, Math.floor(Number(CONFIG.JOBS_INIT_RETRY_INTERVAL_TICKS ?? 20)));
const JOBS_INIT_MAX_TRIES = Math.max(1, Math.floor(Number(CONFIG.JOBS_INIT_MAX_TRIES ?? 60)));
const JOB_STATS_FLUSH_INTERVAL_TICKS = Math.max(1, Math.floor(Number(CONFIG.JOB_STATS_FLUSH_INTERVAL_TICKS ?? 400)));

/* =========================================================
   Anti-exploit: player-placed blocks -> no BREAK payout
========================================================= */
const PLACED_TTL_TICKS = 20 * 60 * 30; // 30 minutes
const _placedBlocks = new Map(); // key -> expiresTick
let _protectedBreakIds = new Set(); // break-reward blocks that should not pay if placed by player

function _posKey(dimId, loc) {
    const x = Math.floor(loc.x);
    const y = Math.floor(loc.y);
    const z = Math.floor(loc.z);
    return `${dimId}|${x}|${y}|${z}`;
}

function _markPlaced(dimId, loc) {
    const now = system.currentTick;
    const key = _posKey(dimId, loc);

    // If this position was already tracked, remove the old entry first.
    // Map.set() on an existing key does NOT move it to the end,
    // and we want the Map ordered by expiration time.
    _placedBlocks.delete(key);

    // Newest expiration is always inserted at the end.
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

// cleanup
system.runInterval(() => {
    const now = system.currentTick;
    let removed = 0;

    for (const [key, exp] of _placedBlocks) {
        // Entries are ordered from oldest expiration to newest.
        // Once the oldest remaining entry has not expired,
        // none of the entries after it can be expired either.
        if (exp > now) break;

        _placedBlocks.delete(key);
        removed++;

        // Prevent a very large cleanup from happening in one tick.
        if (removed >= 2000) break;
    }
}, JOB_PLACED_BLOCK_CLEANUP_INTERVAL_TICKS);

/* =========================================================
   State
========================================================= */
let JOBS_CACHE = null;
let COMPILED = null;

/* =========================================================
   Helpers
========================================================= */
function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function shortId(id) {
    const s = String(id ?? "");
    if (s.startsWith("minecraft:")) return s.slice("minecraft:".length);
    const i = s.indexOf(":");
    return i !== -1 ? s.slice(i + 1) : s;
}

function tell(player, text) {
    try {
        player.sendMessage("§r<§d§lLilys Money§r> §r" + text);
    } catch {}
}

// Crops that must be fully grown to pay money (prevents plant->break exploits)
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
    if (!rule) return true; // no maturity requirement for this block
    try {
        const v = permutation?.getState(rule.state);
        return typeof v === "number" && v >= rule.max;
    } catch {
        return false;
    }
}

/* =========================================================
   Sanitizing + compile
========================================================= */
function toCentsMap(obj) {
    const out = {};
    if (!obj || typeof obj !== "object") return out;

    for (const [k, v] of Object.entries(obj)) {
        const id = String(k).trim();
        const n = Number(v);
        if (!id || !Number.isFinite(n)) continue;
        const c = Math.floor(n);
        if (c <= 0) continue;
        out[id] = c;
    }
    return out;
}

function sanitizeJobs(obj, allowEmpty = false) {
    if (!obj || !Array.isArray(obj.jobs)) return deepClone(DEFAULT_JOBS);

    const out = { v: 2, jobs: [] };
    const seen = new Set();

    for (const j of obj.jobs) {
        const id = String(j?.id ?? "")
            .trim()
            .toLowerCase();
        const name = String(j?.name ?? "").trim();
        if (!id || !name) continue;
        if (seen.has(id)) continue;
        seen.add(id);

        const rules = j?.rules ?? {};
        out.jobs.push({
            id,
            name,
            description: String(j?.description ?? "").trim(),
            icon: cleanTexturePath(j?.icon),
            enabled: j?.enabled !== false,
            allowPlacedBreak: j?.allowPlacedBreak === true,
            rules: {
                break: toCentsMap(rules.break),
                place: toCentsMap(rules.place),
                kill: toCentsMap(rules.kill),
            },
        });
    }

    if (out.jobs.length === 0) {
        return allowEmpty ? out : deepClone(DEFAULT_JOBS);
    }
    return out;
}

function compileJobs(jobsObj) {
    const out = new Map();
    for (const j of jobsObj.jobs) {
        out.set(j.id, {
            id: j.id,
            name: j.name,
            description: j.description,
            icon: getJobIcon(j),
            enabled: j.enabled !== false,
            allowPlacedBreak: j.allowPlacedBreak === true,
            break: new Map(Object.entries(j.rules.break ?? {})),
            place: new Map(Object.entries(j.rules.place ?? {})),
            kill: new Map(Object.entries(j.rules.kill ?? {})),
        });
    }
    return out;
}

function rebuildProtectedBreakIds(jobsObj) {
    const set = new Set();
    if (!jobsObj || !Array.isArray(jobsObj.jobs)) {
        _protectedBreakIds = set;
        return;
    }

    for (const j of jobsObj.jobs) {
        // if allowPlacedBreak is TRUE, do NOT protect those blocks
        if (j.allowPlacedBreak === true) continue;

        const br = j.rules?.break ?? {};
        for (const id of Object.keys(br)) set.add(id);
    }

    _protectedBreakIds = set;
}

/* =========================================================
   Load / Save jobs (retry-safe)
========================================================= */
let _jobsInitStarted = false;
let _jobsInitIntervalId = null;

function clearJobsInitInterval() {
    const id = _jobsInitIntervalId;
    _jobsInitIntervalId = null;

    if (typeof id === "number") {
        try {
            system.clearRun(id);
        } catch {}
    }
}

function tryLoadJobsFromDP() {
    // v2
    try {
        const raw2 = world.getDynamicProperty(JOBS_DP_KEY_V2);
        if (typeof raw2 === "string" && raw2.length) {
            const parsed = JSON.parse(raw2);
            JOBS_CACHE = sanitizeJobs(parsed, true);
            COMPILED = compileJobs(JOBS_CACHE);
            rebuildProtectedBreakIds(JOBS_CACHE);
            return true;
        }
    } catch {}

    // migrate from v1
    try {
        const raw1 = world.getDynamicProperty(JOBS_DP_KEY_V1);
        if (typeof raw1 === "string" && raw1.length) {
            const parsed = JSON.parse(raw1);
            JOBS_CACHE = sanitizeJobs(parsed, true);
            COMPILED = compileJobs(JOBS_CACHE);
            rebuildProtectedBreakIds(JOBS_CACHE);
            saveJobs(JOBS_CACHE); // write to v2 once
            return true;
        }
    } catch {}

    return false;
}

function initJobsStorageWithRetry() {
    if (_jobsInitStarted) return;
    _jobsInitStarted = true;

    let tries = 0;
    const maxTries = JOBS_INIT_MAX_TRIES; // ~60s at 20 ticks per try

    _jobsInitIntervalId = system.runInterval(() => {
        tries++;

        if (tryLoadJobsFromDP()) {
            clearJobsInitInterval();
            return;
        }

        if (tries >= maxTries) {
            // Safety: if keys exist, DO NOT overwrite with defaults
            let ids = [];
            try {
                ids = world.getDynamicPropertyIds?.() ?? [];
            } catch {}
            if (ids.includes(JOBS_DP_KEY_V2) || ids.includes(JOBS_DP_KEY_V1)) {
                clearJobsInitInterval();
                return;
            }

            // No saved data detected -> save defaults once
            if (!JOBS_CACHE) {
                JOBS_CACHE = deepClone(DEFAULT_JOBS);
                COMPILED = compileJobs(JOBS_CACHE);
                rebuildProtectedBreakIds(JOBS_CACHE);
            }
            saveJobs(JOBS_CACHE);

            clearJobsInitInterval();
        }
    }, JOBS_INIT_RETRY_INTERVAL_TICKS);
}

function loadJobs() {
    if (JOBS_CACHE) return JOBS_CACHE;

    initJobsStorageWithRetry();

    // Use defaults in-memory while waiting (DO NOT save here)
    JOBS_CACHE = deepClone(DEFAULT_JOBS);
    COMPILED = compileJobs(JOBS_CACHE);
    rebuildProtectedBreakIds(JOBS_CACHE);
    return JOBS_CACHE;
}

function saveJobs(jobsObj) {
    // IMPORTANT: once we save, never let the retry-init overwrite anything
    _jobsInitStarted = true;
    clearJobsInitInterval();

    try {
        const clean = sanitizeJobs(jobsObj);
        const json = JSON.stringify(clean);
        if (json.length > DP_MAX) return false;

        world.setDynamicProperty(JOBS_DP_KEY_V2, json);

        // verify read-back (debug protection)
        try {
            const back = world.getDynamicProperty(JOBS_DP_KEY_V2);
            if (back !== json) {
                console.warn("[Jobs] DP read-back mismatch. Jobs may not persist.");
            }
        } catch {}

        JOBS_CACHE = clean;
        COMPILED = compileJobs(clean);
        rebuildProtectedBreakIds(clean);
        return true;
    } catch {
        return false;
    }
}

function saveJobsOrWarn(player, jobsObj) {
    const ok = saveJobs(jobsObj);
    if (!ok) tell(player, "§cFailed to save jobs (dynamic properties may be failing or data too large).");
    return ok;
}

const DEFAULT_JOB_ICON = "textures/items/book_writable";

function cleanTexturePath(raw) {
    const s = String(raw ?? "").trim();
    if (!s) return DEFAULT_JOB_ICON;

    // Keep it simple: texture paths should not include .png
    return s.replace(/\.png$/i, "");
}

function getJobIcon(job) {
    return cleanTexturePath(job?.icon);
}

function getJobIconOptions() {
    return JOB_ICON_PRESETS.map((p) => p.name);
}

function getJobIconByPresetIndex(index) {
    const i = Math.floor(Number(index));
    return cleanTexturePath(JOB_ICON_PRESETS[i]?.texture ?? DEFAULT_JOB_ICON);
}

function getJobIconPresetIndex(texture) {
    const clean = cleanTexturePath(texture);

    const index = JOB_ICON_PRESETS.findIndex((p) => cleanTexturePath(p.texture) === clean);
    return index >= 0 ? index : 0;
}

/* =========================================================
   Player job tags
   Cached because break/place/pickup events can fire a LOT on SMPs.
========================================================= */
const _jobIdCacheByPlayerId = new Map();

function getCurrentJobId(player) {
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

function setJob(player, jobIdOrNull) {
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

/* =========================================================
   Stats (DP, buffered)
========================================================= */
let _statsBuffer = {};
let _statsDirty = false;

function loadStats() {
    try {
        const raw = world.getDynamicProperty(JOB_STATS_DP_KEY);
        if (typeof raw === "string" && raw.length) {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.v === 1 && typeof parsed.players === "object") return parsed;
        }
    } catch {}
    return { v: 1, players: {} };
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

    try {
        const json = JSON.stringify(base);
        if (json.length <= DP_MAX) world.setDynamicProperty(JOB_STATS_DP_KEY, json);
    } catch {}

    _statsBuffer = {};
    _statsDirty = false;
}, JOB_STATS_FLUSH_INTERVAL_TICKS);

/* =========================================================
   Payout
========================================================= */
function payout(player, centsEarned, toastText) {
    const { dollarsObj, centsObj } = ensureMoneyObjectives();
    const bal = getBalanceCents(dollarsObj, centsObj, player);
    const next = bal + centsEarned;
    setBalanceFromTotalCents(dollarsObj, centsObj, player, next);

    setActionbarToast(player, `${toastText} §2+${formatCents(centsEarned)}`, MAX_TOAST_TICKS);
    playMoneySound(player);

    return next;
}

/* =========================================================
   Events: break/place/kill
========================================================= */
function handleReward(player, kind, id, count = 1) {
    if (!(player instanceof Player)) return;
    if (!id) return;
    if (count <= 0) return;

    const jobId = getCurrentJobId(player);
    if (!jobId) return;

    const jobs = loadJobs();
    if (!COMPILED) COMPILED = compileJobs(jobs);

    const job = COMPILED.get(jobId);
    if (!job || !job.enabled) return;

    const map = job[kind];
    if (!map) return;

    const per = map.get(id);
    if (!per || per <= 0) return;

    const total = per * count;
    if (!Number.isSafeInteger(total)) return;

    const label = kind === "break" ? "§8Broke" : kind === "place" ? "§8Placed" : kind === "kill" ? "§8Killed" : "§8Got";

    const toast = `${label} §f${shortId(id)}${count > 1 ? ` §8x§f${count}` : ""}`;

    const balanceAfter = payout(player, total, toast);
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

// Break block (+ anti exploit)
// Break block (+ anti exploit + mature crops)
if (world.afterEvents?.playerBreakBlock?.subscribe) {
    world.afterEvents.playerBreakBlock.subscribe((ev) => {
        try {
            const blockId =
                ev?.brokenBlockPermutation?.type?.id ?? ev?.block?.typeId ?? ev?.block?.type?.id ?? ev?.blockPermutation?.type?.id ?? null;

            if (!blockId) return;

            const perm = ev?.brokenBlockPermutation ?? ev?.blockPermutation ?? null;

            // crop maturity rules
            const rule = MATURE_RULES[blockId]; // undefined for logs/ores/etc.
            const needsMature = !!rule;
            const mature = isMatureEnough(blockId, perm);

            // anti-exploit for protected break reward blocks
            if (_protectedBreakIds.has(blockId)) {
                const dimId = ev.block.dimension.id;
                const loc = ev.block.location;

                if (_wasPlaced(dimId, loc)) {
                    _consumePlaced(dimId, loc);

                    // If it's NOT a crop (no maturity rule), placed blocks NEVER pay
                    if (!needsMature) return;

                    // If it IS a crop, it must be mature to pay
                    if (!mature) return;
                    // mature crop: allow payout
                } else {
                    // Naturally generated crops must also be mature
                    if (needsMature && !mature) return;
                }
            } else {
                // not protected, but crops still must be mature
                if (needsMature && !mature) return;
            }

            handleReward(ev.player, "break", blockId, 1);
        } catch {}
    });
}

// Place block (mark if it would be protected on break)
if (world.afterEvents?.playerPlaceBlock?.subscribe) {
    world.afterEvents.playerPlaceBlock.subscribe((ev) => {
        try {
            const blockId =
                ev?.block?.typeId ?? ev?.block?.type?.id ?? ev?.placedBlockPermutation?.type?.id ?? ev?.blockPermutation?.type?.id ?? null;

            if (blockId && _protectedBreakIds.has(blockId)) {
                const dimId = ev.block.dimension.id;
                const loc = ev.block.location;
                _markPlaced(dimId, loc);
            }

            handleReward(ev.player, "place", blockId, 1);
        } catch {}
    });
}

// Kill (entity die)
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

/* =========================================================
   Kick off DP init AFTER script loads (don’t force defaults)
========================================================= */
system.run(() => {
    initJobsStorageWithRetry();
});

/* =========================================================
   Command: /job UI (player + admin editor)
========================================================= */
export function registerJobCommand(customCommandRegistry) {
    customCommandRegistry.registerCommand(
        {
            name: `lilymoney:job`,
            description: "Open job UI",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const src = getCommandSource(origin);
            if (!(src instanceof Player)) {
                return { status: CustomCommandStatus.Failure, message: "Only players can use /job." };
            }
            system.run(() => openJobRoot(src).catch((e) => console.warn(`[Job] UI error: ${e?.stack ?? e}`)));
            return { status: CustomCommandStatus.Success };
        },
    );

    // optional chat shortcut "/job"
    try {
        world.beforeEvents.chatSend.subscribe((ev) => {
            const m = String(ev.message ?? "").trim();
            if (m === "/job") {
                ev.cancel = true;
                system.run(() => openJobRoot(ev.sender).catch(() => {}));
            }
        });
    } catch {}
}

/* =========================================================
   UI: Player root
========================================================= */
/* =========================================================
   UI: Player root
========================================================= */
/* =========================================================
   UI: Player root
========================================================= */
async function openJobRoot(player) {
    const jobs = loadJobs();
    const admin = isAdmin(player);

    const currentId = getCurrentJobId(player);
    const currentJob = currentId ? jobs.jobs.find((j) => j.id === currentId) : null;

    const visible = jobs.jobs.filter((j) => j.enabled !== false);

    const form = new ActionFormData()
        .title("§d§lJobs§r")
        .body(`§8Current job: §f${currentJob ? currentJob.name : "None"}\n§8Pick a job to view its rewards.\n`);

    if (admin) {
        form.button("§6§lEdit Jobs", "textures/ui/settings_glyph_color_2x");
    }

    for (const j of visible) {
        form.button(`§f§l${j.name}\n§r§8${j.description || "View rewards"}`, getJobIcon(j));
    }

    form.button(currentJob ? "§c§lLeave Job" : "§c§lClose", currentJob ? "textures/ui/cancel" : "textures/ui/cancel");

    const res = await form.show(player);
    if (res.canceled) return;

    if (admin && res.selection === 0) return openAdminJobsMenu(player);

    const offset = admin ? 1 : 0;
    const leaveIndex = offset + visible.length;

    if (res.selection === leaveIndex) {
        if (currentJob) {
            setJob(player, null);
            tell(player, "§aYou left your job.");
        }
        return;
    }

    const picked = visible[res.selection - offset];
    if (!picked) return;

    return openJobDetails(player, picked.id);
}

async function openJobDetails(player, jobId) {
    const jobs = loadJobs();

    const job = jobs.jobs.find((j) => j.id === jobId && j.enabled !== false);
    if (!job) return openJobRoot(player);

    const currentId = getCurrentJobId(player);
    const alreadyCurrent = currentId === job.id;

    const form = new ActionFormData()
        .title(`${job.name}§r`)
        .body(buildJobDetailsBody(job, currentId))
        .button(alreadyCurrent ? "§2§lAlready Your Job" : "§2§lJoin Job", alreadyCurrent ? "textures/ui/confirm" : getJobIcon(job))
        .button("§8§lBack", "textures/ui/arrow_left");

    const res = await form.show(player);
    if (res.canceled) return openJobRoot(player);

    if (res.selection === 0) {
        if (!alreadyCurrent) {
            setJob(player, job.id);
            tell(player, `§aYou are now a §f${job.name}§a.`);
        }
        return;
    }

    return openJobRoot(player);
}

/* =========================================================
   UI: Admin editor
========================================================= */
async function openAdminJobsMenu(player) {
    const form = new ActionFormData()
        .title("§6§lJob Editor§r")
        .body("§8Manage jobs and rewards (saved per-world).")
        .button("§2§lAdd Job", "textures/ui/color_plus")
        .button("§e§lEdit Existing Job", "textures/ui/editIcon")
        .button("§c§lReset to Defaults", "textures/ui/refresh_light")
        .button("§4§lClear ALL Jobs", "textures/ui/trash")
        .button("§8§lBack", "textures/ui/arrow_left");

    const res = await form.show(player);
    if (res.canceled) return;

    if (res.selection === 0) return openAddJob(player);
    if (res.selection === 1) return openPickJobToEdit(player);
    if (res.selection === 2) return openResetJobsConfirm(player);
    if (res.selection === 3) return openClearJobsConfirm(player);
    return openJobRoot(player);
}

async function openClearJobsConfirm(player) {
    const form = new ActionFormData()
        .use8CrafterLayout("long")
        .title("§4§lClear ALL Jobs?")
        .body("§cThis will delete ALL jobs.\n" + "§8Players will have no jobs until you add new ones.\n\n" + "§8This cannot be undone.")
        .button("§c§lCancel", "textures/ui/cancel")
        .button("§4§lClear ALL Jobs", "textures/ui/trash");

    const res = await form.show(player);

    if (res.canceled || res.selection === 0) {
        return openAdminJobsMenu(player);
    }

    const empty = { v: 2, jobs: [] };

    saveJobsAllowEmptyOrWarn(player, empty);
    tell(player, "§aAll jobs cleared.");

    return openAdminJobsMenu(player);
}

function saveJobsAllowEmptyOrWarn(player, jobsObj) {
    const ok = saveJobsAllowEmpty(jobsObj);
    if (!ok) tell(player, "§cFailed to save jobs (dynamic properties may be failing or data too large).");
    return ok;
}

function saveJobsAllowEmpty(jobsObj) {
    _jobsInitStarted = true;
    clearJobsInitInterval();

    try {
        const clean = sanitizeJobs(jobsObj, true); // <-- allowEmpty = true
        const json = JSON.stringify(clean);
        if (json.length > DP_MAX) return false;

        world.setDynamicProperty(JOBS_DP_KEY_V2, json);

        JOBS_CACHE = clean;
        COMPILED = compileJobs(clean);
        rebuildProtectedBreakIds(clean);
        return true;
    } catch {
        return false;
    }
}

async function openAddJob(player) {
    const form = new ModalFormData()
        .title("Add Job")
        .textField("Job ID (no spaces)", "ex: fisher", { defaultValue: "" })
        .textField("Job Name", "ex: Fisher", { defaultValue: "" })
        .textField("Description", "shown in UI", { defaultValue: "" })
        .dropdown("Job icon", getJobIconOptions(), { defaultValueIndex: 0 })
        .toggle("Allow placed blocks for BREAK rewards", { defaultValue: false });

    const res = await form.show(player);
    if (res.canceled) return openAdminJobsMenu(player);

    const id = String(res.formValues?.[0] ?? "")
        .trim()
        .toLowerCase();
    const name = String(res.formValues?.[1] ?? "").trim();
    const desc = String(res.formValues?.[2] ?? "").trim();
    const icon = getJobIconByPresetIndex(res.formValues?.[3]);
    const allowPlacedBreak = !!res.formValues?.[4];

    if (!id || !/^[a-z0-9_\-]+$/.test(id)) {
        tell(player, "§cInvalid ID. Use letters/numbers/_/- only.");
        return openAdminJobsMenu(player);
    }

    if (!name) {
        tell(player, "§cName cannot be empty.");
        return openAdminJobsMenu(player);
    }

    const jobs = loadJobs();

    if (jobs.jobs.some((j) => j.id === id)) {
        tell(player, "§cA job with that ID already exists.");
        return openAdminJobsMenu(player);
    }

    jobs.jobs.push({
        id,
        name,
        description: desc,
        icon,
        enabled: true,
        allowPlacedBreak,
        rules: { break: {}, place: {}, kill: {} },
    });

    if (!saveJobsOrWarn(player, jobs)) {
        jobs.jobs.pop();
        return openAdminJobsMenu(player);
    }

    tell(player, "§aJob added.");
    return openAdminJobsMenu(player);
}

async function openPickJobToEdit(player) {
    const jobs = loadJobs();

    const form = new ActionFormData().title("Edit Job").body("§8Pick a job:").button("§8§lBack", "textures/ui/arrow_left");

    for (const j of jobs.jobs) {
        form.button(`§f§l${j.name} §r§8(${j.id})`, getJobIcon(j));
    }

    const res = await form.show(player);
    if (res.canceled || res.selection === 0) return openAdminJobsMenu(player);

    const job = jobs.jobs[res.selection - 1];
    if (!job) return openAdminJobsMenu(player);

    return openEditJob(player, job.id);
}

async function openEditJob(player, jobId) {
    const jobs = loadJobs();
    const job = jobs.jobs.find((j) => j.id === jobId);
    if (!job) return openAdminJobsMenu(player);

    const form = new ActionFormData()
        .title(`Edit: ${job.name}`)
        .body(
            `§8${job.description || ""}\n` +
                `§8Enabled: ${job.enabled ? "§2Yes" : "§cNo"}\n` +
                `§8Icon: §f${getJobIcon(job)}\n` +
                `§8Allow placed BREAK: ${job.allowPlacedBreak ? "§2Yes" : "§cNo"}`,
        )
        .button("§e§lEdit Info / Icon / PlacedBreak", "textures/ui/editIcon")
        .button(job.enabled ? "§c§lDisable Job" : "§2§lEnable Job", job.enabled ? "textures/ui/cancel" : "textures/ui/confirm")
        .button("§b§lEdit Break Rewards", "textures/items/iron_pickaxe")
        .button("§b§lEdit Place Rewards", "textures/blocks/grass_side_carried")
        .button("§b§lEdit Kill Rewards", "textures/items/iron_sword")
        .button("§c§lDelete Job", "textures/ui/trash")
        .button("§8§lBack", "textures/ui/arrow_left");

    const res = await form.show(player);
    if (res.canceled) return openPickJobToEdit(player);

    if (res.selection === 0) return openEditJobMeta(player, jobId);

    if (res.selection === 1) {
        job.enabled = !job.enabled;
        saveJobsOrWarn(player, jobs);
        return openEditJob(player, jobId);
    }

    if (res.selection === 2) return openEditRewards(player, jobId, "break", "Block ID");
    if (res.selection === 3) return openEditRewards(player, jobId, "place", "Block ID");
    if (res.selection === 4) return openEditRewards(player, jobId, "kill", "Entity ID");
    if (res.selection === 5) return openDeleteJobConfirm(player, jobId);

    return openPickJobToEdit(player);
}

function cleanRewardName(id) {
    return String(id ?? "")
        .replace(/^minecraft:/, "")
        .split("_")
        .map((p) => (p.length ? p[0].toUpperCase() + p.slice(1) : p))
        .join(" ");
}

function formatRewardList(title, rewards) {
    const entries = Object.entries(rewards ?? {})
        .filter(([, cents]) => Number.isInteger(cents) && cents > 0)
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

    if (entries.length === 0) return "";

    const lines = [`§d${title}:`];

    for (const [id, cents] of entries) {
        lines.push(`§8- §f${cleanRewardName(id)} §8= §2${formatCents(cents)}`);
    }

    return lines.join("\n");
}

function buildJobDetailsBody(job, currentJobId) {
    const sections = [];

    sections.push(`§8Job: §f${job.name}`);
    if (job.description) sections.push(`§8${job.description}`);
    sections.push("");

    if (job.id === currentJobId) {
        sections.push("§2You already have this job.");
        sections.push("");
    }

    const breakRewards = formatRewardList("Break rewards", job.rules?.break);
    const placeRewards = formatRewardList("Place rewards", job.rules?.place);
    const killRewards = formatRewardList("Kill rewards", job.rules?.kill);

    if (breakRewards) sections.push(breakRewards, "");
    if (placeRewards) sections.push(placeRewards, "");
    if (killRewards) sections.push(killRewards, "");

    if (!breakRewards && !placeRewards && !killRewards) {
        sections.push("§cThis job has no rewards configured yet.");
    }

    return sections.join("\n").trim();
}

async function openEditJobMeta(player, jobId) {
    const jobs = loadJobs();
    const job = jobs.jobs.find((j) => j.id === jobId);
    if (!job) return openAdminJobsMenu(player);

    const form = new ModalFormData()
        .title("Edit Job Info")
        .textField("Name", "ex: Miner", { defaultValue: job.name })
        .textField("Description", "shown in UI", { defaultValue: job.description || "" })
        .dropdown("Job icon", getJobIconOptions(), { defaultValueIndex: getJobIconPresetIndex(job.icon) })
        .toggle("Allow placed blocks for BREAK rewards", { defaultValue: !!job.allowPlacedBreak });

    const res = await form.show(player);
    if (res.canceled) return openEditJob(player, jobId);

    const name = String(res.formValues?.[0] ?? "").trim();
    const desc = String(res.formValues?.[1] ?? "").trim();
    const icon = getJobIconByPresetIndex(res.formValues?.[2]);
    const allowPlacedBreak = !!res.formValues?.[3];

    if (!name) {
        tell(player, "§cName cannot be empty.");
        return openEditJob(player, jobId);
    }

    job.name = name;
    job.description = desc;
    job.icon = icon;
    job.allowPlacedBreak = allowPlacedBreak;

    saveJobsOrWarn(player, jobs);
    return openEditJob(player, jobId);
}

async function openEditRewards(player, jobId, type, idLabel) {
    const jobs = loadJobs();
    const job = jobs.jobs.find((j) => j.id === jobId);
    if (!job) return openAdminJobsMenu(player);

    if (!job.rules[type]) job.rules[type] = {};
    const entries = Object.entries(job.rules[type]);

    const form = new ActionFormData()
        .title(`${job.name} - ${type} rewards`)
        .body("§8Pick a rule to edit/remove, or add a new one.")
        .button("§2§lAdd Rule", "textures/ui/color_plus")
        .button("§8§lBack", "textures/ui/arrow_left");

    for (const [id, c] of entries) {
        form.button(`§f§l${shortId(id)}\n§r§e${formatCents(c)}`, getRewardRuleIcon(type, id));
    }

    const res = await form.show(player);
    if (res.canceled) return openEditJob(player, jobId);

    if (res.selection === 0) return openAddRule(player, jobId, type, idLabel);
    if (res.selection === 1) return openEditJob(player, jobId);

    const idx = res.selection - 2;
    const picked = entries[idx];
    if (!picked) return openEditRewards(player, jobId, type, idLabel);

    return openRuleActions(player, jobId, type, idLabel, picked[0]);
}

async function openAddRule(player, jobId, type, idLabel) {
    const form = new ModalFormData()
        .title(`Add ${type} rule`)
        .textField(idLabel, "ex: minecraft:oak_log", { defaultValue: "" })
        .textField("Reward (each)", "ex: 5 or 0.25", { defaultValue: "1" });

    const res = await form.show(player);
    if (res.canceled) return openEditRewards(player, jobId, type, idLabel);

    const id = String(res.formValues?.[0] ?? "").trim();
    const parsed = parseUiMoneyToCents(res.formValues?.[1]);
    if (!id || !parsed.ok || parsed.cents <= 0) {
        tell(player, "§cInvalid id or reward.");
        return openEditRewards(player, jobId, type, idLabel);
    }

    const jobs = loadJobs();
    const job = jobs.jobs.find((j) => j.id === jobId);
    if (!job) return openAdminJobsMenu(player);

    if (!job.rules[type]) job.rules[type] = {};
    job.rules[type][id] = parsed.cents;

    saveJobsOrWarn(player, jobs);
    tell(player, "§aRule added.");
    return openEditRewards(player, jobId, type, idLabel);
}

async function openRuleActions(player, jobId, type, idLabel, id) {
    const form = new ActionFormData()
        .title(`${type} rule`)
        .body(`§8${id}`)
        .button("§e§lEdit Reward", "textures/ui/editIcon")
        .button("§c§lRemove Rule", "textures/ui/trash")
        .button("§8§lBack", "textures/ui/arrow_left");

    const res = await form.show(player);
    if (res.canceled) return openEditRewards(player, jobId, type, idLabel);

    if (res.selection === 0) return openEditRuleReward(player, jobId, type, idLabel, id);
    if (res.selection === 1) return openRemoveRuleConfirm(player, jobId, type, idLabel, id);
    return openEditRewards(player, jobId, type, idLabel);
}

async function openEditRuleReward(player, jobId, type, idLabel, id) {
    const jobs = loadJobs();
    const job = jobs.jobs.find((j) => j.id === jobId);
    if (!job) return openAdminJobsMenu(player);

    const current = job.rules?.[type]?.[id] ?? 0;

    const form = new ModalFormData()
        .title("Edit Reward")
        .textField("Reward (each)", "ex: 5 or 0.25", { defaultValue: String(current / 100) });

    const res = await form.show(player);
    if (res.canceled) return openEditRewards(player, jobId, type, idLabel);

    const parsed = parseUiMoneyToCents(res.formValues?.[0]);
    if (!parsed.ok || parsed.cents <= 0) {
        tell(player, "§cInvalid reward.");
        return openEditRewards(player, jobId, type, idLabel);
    }

    job.rules[type][id] = parsed.cents;
    saveJobsOrWarn(player, jobs);
    tell(player, "§aReward updated.");
    return openEditRewards(player, jobId, type, idLabel);
}

async function openRemoveRuleConfirm(player, jobId, type, idLabel, id) {
    const form = new ActionFormData()
        .use8CrafterLayout("long")
        .title("§c§lRemove Rule?")
        .body(`§cRemove reward rule for:\n§f${id}\n\n` + "§8This cannot be undone.")
        .button("§c§lCancel", "textures/ui/cancel")
        .button("§c§lRemove Rule", "textures/ui/trash");

    const res = await form.show(player);

    if (res.canceled || res.selection === 0) {
        return openEditRewards(player, jobId, type, idLabel);
    }

    const jobs = loadJobs();
    const job = jobs.jobs.find((j) => j.id === jobId);

    if (!job) {
        return openAdminJobsMenu(player);
    }

    if (job.rules?.[type]) {
        delete job.rules[type][id];
    }

    saveJobsOrWarn(player, jobs);
    tell(player, "§aRule removed.");

    return openEditRewards(player, jobId, type, idLabel);
}

async function openDeleteJobConfirm(player, jobId) {
    const jobs = loadJobs();
    const job = jobs.jobs.find((j) => j.id === jobId);

    if (!job) {
        return openAdminJobsMenu(player);
    }

    const form = new ActionFormData()
        .use8CrafterLayout("long")
        .title("§c§lDelete Job?")
        .body(`§cDelete job §f${job.name}§c?\n\n` + "§8This cannot be undone.")
        .button("§c§lCancel", "textures/ui/cancel")
        .button("§c§lDelete Job", "textures/ui/trash");

    const res = await form.show(player);

    if (res.canceled || res.selection === 0) {
        return openEditJob(player, jobId);
    }

    jobs.jobs = jobs.jobs.filter((j) => j.id !== jobId);

    saveJobsOrWarn(player, jobs);
    tell(player, "§aJob deleted.");

    return openAdminJobsMenu(player);
}

async function openResetJobsConfirm(player) {
    const form = new ActionFormData()
        .use8CrafterLayout("long")
        .title("§c§lRestore Default Jobs?")
        .body(
            "§cThis will restore the default jobs.\n" +
                "§8Your current custom jobs and rewards will be overwritten.\n\n" +
                "§8This cannot be undone.",
        )
        .button("§c§lCancel", "textures/ui/cancel")
        .button("§c§lRestore Defaults", "textures/ui/refresh_light");

    const res = await form.show(player);

    if (res.canceled || res.selection === 0) {
        return openAdminJobsMenu(player);
    }

    saveJobsOrWarn(player, deepClone(DEFAULT_JOBS));
    tell(player, "§aJobs reset to defaults.");

    return openAdminJobsMenu(player);
}

function parseUiMoneyToCents(text) {
    const s = String(text ?? "").trim();
    const num = Number(s.replace(",", "."));
    if (!Number.isFinite(num)) return { ok: false, error: "Invalid number." };
    return parseFloatToCents(num, false);
}
