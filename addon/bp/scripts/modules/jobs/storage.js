import { CONFIG } from "../../config.js";
import { DEFAULT_JOBS, JOB_ICON_PRESETS } from "../defaults/jobs.js";
import { system, world } from "@minecraft/server";

const JOBS_DP_KEY_V2 = `lilymoney:jobs_v2`;
const JOBS_DP_KEY_V1 = `lilymoney:jobs_v1`; // Read older worlds from this key.

export const DP_MAX = 32767;

const JOBS_INIT_RETRY_INTERVAL_TICKS = Math.max(1, Math.floor(Number(CONFIG.JOBS_INIT_RETRY_INTERVAL_TICKS ?? 20)));
const JOBS_INIT_MAX_TRIES = Math.max(1, Math.floor(Number(CONFIG.JOBS_INIT_MAX_TRIES ?? 60)));

let _protectedBreakIds = new Set();

let JOBS_CACHE = null;
let COMPILED = null;

export function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

export function shortId(id) {
    const s = String(id ?? "");
    if (s.startsWith("minecraft:")) return s.slice("minecraft:".length);
    const i = s.indexOf(":");
    return i !== -1 ? s.slice(i + 1) : s;
}

export function tell(player, text) {
    try {
        player.sendMessage("§r<§dLily's Money§r> §r" + text);
    } catch {}
}

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
            icon: cleanJobTexturePath(j?.icon),
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
        if (j.allowPlacedBreak === true) continue;

        const br = j.rules?.break ?? {};
        for (const id of Object.keys(br)) set.add(id);
    }

    _protectedBreakIds = set;
}

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
    try {
        const raw2 = world.getDynamicProperty(JOBS_DP_KEY_V2);
        if (typeof raw2 === "string" && raw2.length) {
            const parsed = JSON.parse(raw2);
            JOBS_CACHE = sanitizeJobs(parsed, true);
            COMPILED = compileJobs(JOBS_CACHE);
            rebuildProtectedBreakIds(JOBS_CACHE);
            return true;
        }
    } catch (error) {
        console.warn(`[Jobs] Cannot read v2 jobs: ${error}`);
        return false;
    }

    // Load the older format only when the current property has no saved text.
    try {
        const raw1 = world.getDynamicProperty(JOBS_DP_KEY_V1);
        if (typeof raw1 === "string" && raw1.length) {
            const parsed = JSON.parse(raw1);
            JOBS_CACHE = sanitizeJobs(parsed, true);
            COMPILED = compileJobs(JOBS_CACHE);
            rebuildProtectedBreakIds(JOBS_CACHE);
            saveJobs(JOBS_CACHE); // Save the migrated jobs under the current key.
            return true;
        }
    } catch {}

    return false;
}

function initJobsStorageWithRetry() {
    if (_jobsInitStarted) return;
    _jobsInitStarted = true;

    let tries = 0;
    const maxTries = JOBS_INIT_MAX_TRIES;

    _jobsInitIntervalId = system.runInterval(() => {
        tries++;

        if (tryLoadJobsFromDP()) {
            clearJobsInitInterval();
            return;
        }

        if (tries >= maxTries) {
            // Write defaults only after confirming that neither storage key exists.
            let ids = [];
            try {
                ids = world.getDynamicPropertyIds();
            } catch (error) {
                console.warn(`[Jobs] Cannot verify empty storage: ${error}`);
                return;
            }
            if (ids.includes(JOBS_DP_KEY_V2) || ids.includes(JOBS_DP_KEY_V1)) {
                clearJobsInitInterval();
                return;
            }

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

export function loadJobs() {
    if (JOBS_CACHE) return JOBS_CACHE;

    initJobsStorageWithRetry();

    // Use defaults in memory until the retry loop can check for saved jobs.
    JOBS_CACHE = deepClone(DEFAULT_JOBS);
    COMPILED = compileJobs(JOBS_CACHE);
    rebuildProtectedBreakIds(JOBS_CACHE);
    return JOBS_CACHE;
}

function saveJobs(jobsObj) {
    // Stop startup retries before saving so they cannot replace these edits.
    _jobsInitStarted = true;
    clearJobsInitInterval();

    try {
        const clean = sanitizeJobs(jobsObj);
        const json = JSON.stringify(clean);
        if (json.length > DP_MAX) return false;

        world.setDynamicProperty(JOBS_DP_KEY_V2, json);

        // Report a read-back mismatch in the Content Log.
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

export function saveJobsOrWarn(player, jobsObj) {
    const ok = saveJobs(jobsObj);
    if (!ok) tell(player, "§cFailed to save jobs (dynamic properties may be failing or data too large).");
    return ok;
}

const DEFAULT_JOB_ICON = "textures/items/book_writable";

function cleanJobTexturePath(raw) {
    const s = String(raw ?? "").trim();
    if (!s) return DEFAULT_JOB_ICON;

    return s.replace(/\.png$/i, "");
}

export function getJobIcon(job) {
    return cleanJobTexturePath(job?.icon);
}

export function getJobIconOptions() {
    return JOB_ICON_PRESETS.map((p) => p.name);
}

export function getJobIconByPresetIndex(index) {
    const i = Math.floor(Number(index));
    return cleanJobTexturePath(JOB_ICON_PRESETS[i]?.texture ?? DEFAULT_JOB_ICON);
}

export function getJobIconPresetIndex(texture) {
    const clean = cleanJobTexturePath(texture);

    const index = JOB_ICON_PRESETS.findIndex((p) => cleanJobTexturePath(p.texture) === clean);
    return index >= 0 ? index : 0;
}

system.run(() => {
    initJobsStorageWithRetry();
});

export function saveJobsAllowEmptyOrWarn(player, jobsObj) {
    const ok = saveJobsAllowEmpty(jobsObj);
    if (!ok) tell(player, "§cFailed to save jobs (dynamic properties may be failing or data too large).");
    return ok;
}

function saveJobsAllowEmpty(jobsObj) {
    _jobsInitStarted = true;
    clearJobsInitInterval();

    try {
        const clean = sanitizeJobs(jobsObj, true); // Allow a deliberately empty job list.
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

export function getCompiledJob(id) {
    const jobs = loadJobs();
    COMPILED ??= compileJobs(jobs);
    return COMPILED.get(id);
}

export function protectsBreak(id) {
    return _protectedBreakIds.has(id);
}
