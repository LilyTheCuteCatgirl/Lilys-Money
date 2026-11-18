// BP/scripts/jsfunctions.js
import { world, Player, ItemTypes, ItemStack } from "@minecraft/server";
import { CONFIG } from "./config.js";

import { DisplaySlotId } from "@minecraft/server";
import { system } from "@minecraft/server";

const MONEY_MIN_TOTAL_CENTS = -2147483647 * 100;
const MONEY_MAX_TOTAL_CENTS = 2147483647 * 100 + 99;

let _personalDefaultsCache = null;

export function getMoneyPersonalDefaults() {
    if (_personalDefaultsCache) return _personalDefaultsCache;

    const def = {
        actionbar: true,
        sound: true,
        compact: false,
    };

    try {
        const raw = world.getDynamicProperty(CONFIG.MONEY_PERSONAL_DEFAULTS_DP_KEY);
        if (typeof raw === "string" && raw.length) {
            const parsed = JSON.parse(raw);

            _personalDefaultsCache = {
                actionbar: typeof parsed?.actionbar === "boolean" ? parsed.actionbar : def.actionbar,
                sound: typeof parsed?.sound === "boolean" ? parsed.sound : def.sound,
                compact: typeof parsed?.compact === "boolean" ? parsed.compact : def.compact,
            };

            return _personalDefaultsCache;
        }
    } catch {}

    _personalDefaultsCache = def;
    return def;
}

export function setMoneyPersonalDefaults(next) {
    const cur = getMoneyPersonalDefaults();

    const merged = {
        actionbar: typeof next?.actionbar === "boolean" ? next.actionbar : cur.actionbar,
        sound: typeof next?.sound === "boolean" ? next.sound : cur.sound,
        compact: typeof next?.compact === "boolean" ? next.compact : cur.compact,
    };

    _personalDefaultsCache = merged;

    try {
        world.setDynamicProperty(CONFIG.MONEY_PERSONAL_DEFAULTS_DP_KEY, JSON.stringify(merged));
    } catch {}

    return merged;
}

function _tag(name, fallback) {
    return CONFIG[name] ?? `lilymoney:${fallback}`;
}

/* =========================================================
   OBJECTIVES / SCOREBOARD
========================================================= */
export function safeGetObjective(name) {
    try {
        return world.scoreboard.getObjective(name);
    } catch {
        return null;
    }
}

export function safeAddObjective(name, displayName) {
    try {
        return world.scoreboard.addObjective(name, displayName ?? name);
    } catch {
        return null;
    }
}

export function ensureMoneyObjectives() {
    let dollarsObj = safeGetObjective(CONFIG.MONEY_DOLLAR_OBJECTIVE);
    if (!dollarsObj) dollarsObj = safeAddObjective(CONFIG.MONEY_DOLLAR_OBJECTIVE, CONFIG.MONEY_DOLLAR_DISPLAY);

    let centsObj = safeGetObjective(CONFIG.MONEY_CENT_OBJECTIVE);
    if (!centsObj) centsObj = safeAddObjective(CONFIG.MONEY_CENT_OBJECTIVE, CONFIG.MONEY_CENT_DISPLAY);

    return { dollarsObj, centsObj };
}

export function getScoreSafe(obj, identityOrPlayer) {
    const id = identityOrPlayer?.scoreboardIdentity ?? identityOrPlayer;
    if (!id) return 0;
    try {
        const v = obj.getScore(id);
        return typeof v === "number" ? v : 0;
    } catch {
        return 0;
    }
}

/* =========================================================
   MONEY MATH (total cents)
========================================================= */

export function clampTotalCents(totalCents) {
    const total = Math.floor(Number(totalCents) || 0);
    if (total < MONEY_MIN_TOTAL_CENTS) return MONEY_MIN_TOTAL_CENTS;
    if (total > MONEY_MAX_TOTAL_CENTS) return MONEY_MAX_TOTAL_CENTS;
    return total;
}

export function getBalanceCents(dollarsObj, centsObj, player) {
    const d = getScoreSafe(dollarsObj, player);
    const c = getScoreSafe(centsObj, player);
    return d * 100 + c;
}

export function setBalanceFromTotalCents(dollarsObj, centsObj, player, totalCents) {
    totalCents = clampTotalCents(totalCents);

    const id = player?.scoreboardIdentity;
    if (!id) return;

    const dollars = Math.floor(totalCents / 100);
    const cents = totalCents - dollars * 100; // 0..99 even for negatives

    try {
        dollarsObj.setScore(id, dollars);
    } catch {}
    try {
        centsObj.setScore(id, cents);
    } catch {}
}

export function normalizePlayerIfNeeded(dollarsObj, centsObj, player) {
    const id = player?.scoreboardIdentity;
    if (!id) return;

    const cents = getScoreSafe(centsObj, id);
    if (cents >= 0 && cents <= 99) return;

    const dollars = getScoreSafe(dollarsObj, id);
    const total = dollars * 100 + cents;
    setBalanceFromTotalCents(dollarsObj, centsObj, player, total);
}

// =========================================================
// NAME CACHE (for offline /topmoney)
// Stores: scoreboardIdentity.id -> last known player name
// =========================================================
let _nameCache = null; // Map<string, string>

function _loadNameCache() {
    if (_nameCache) return _nameCache;
    _nameCache = new Map();

    try {
        const raw = world.getDynamicProperty(CONFIG.NAME_CACHE_DP_KEY);
        if (typeof raw === "string" && raw.length) {
            const lines = raw.split("\n");
            for (const line of lines) {
                if (!line) continue;
                const tab = line.indexOf("\t");
                if (tab === -1) continue;
                const id = line.slice(0, tab);
                const name = line.slice(tab + 1);
                if (id && name) _nameCache.set(id, name);
            }
        }
    } catch {}

    return _nameCache;
}

function _saveNameCache() {
    if (!_nameCache) return;

    // serialize
    let raw = "";
    for (const [id, name] of _nameCache) raw += `${id}\t${name}\n`;

    // if too big, drop oldest entries until it fits
    while (raw.length > CONFIG.NAME_CACHE_MAX_CHARS && _nameCache.size > 0) {
        const firstKey = _nameCache.keys().next().value;
        _nameCache.delete(firstKey);

        raw = "";
        for (const [id, name] of _nameCache) raw += `${id}\t${name}\n`;
    }

    try {
        world.setDynamicProperty(CONFIG.NAME_CACHE_DP_KEY, raw);
    } catch {}
}

export function cachePlayerName(player) {
    const idObj = player?.scoreboardIdentity;
    if (!idObj || idObj.id === undefined || idObj.id === null) return;

    const id = String(idObj.id);
    const name = String(player.name ?? "").trim();
    if (!name) return;

    const map = _loadNameCache();
    const prev = map.get(id);

    if (prev === name) return;

    // refresh order (move to end)
    if (prev !== undefined) map.delete(id);
    map.set(id, name);

    _saveNameCache();
}

export function getCachedNameForIdentity(identity) {
    const map = _loadNameCache();

    const key = identity?.id !== undefined && identity?.id !== null ? String(identity.id) : null;
    if (key && map.has(key)) return map.get(key);

    // fallback (may be disconnected)
    const dn = identity?.displayName;
    if (typeof dn === "string" && dn.length) return dn;

    return "Unknown";
}

export function getStartMoneyCents() {
    try {
        const v = world.getDynamicProperty(CONFIG.START_MONEY_CENTS_DP_KEY);
        if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v));
        if (typeof v === "string" && v.length) return Math.max(0, Math.floor(Number(v)));
    } catch {}
    return 0;
}

export function setStartMoneyCents(cents) {
    const c = Math.max(0, Math.floor(Number(cents) || 0));
    try {
        // store as number (works fine)
        world.setDynamicProperty(CONFIG.START_MONEY_CENTS_DP_KEY, c);
    } catch {}
    return c;
}

export function playMoneySound(player) {
    try {
        if (!hasMoneySound(player)) return;

        // Prefer the Script API sound call. Commands are noticeably heavier on SMPs.
        try {
            if (typeof player.playSound === "function") {
                player.playSound("random.orb", { volume: 1, pitch: 1 });
                return;
            }
        } catch {}

        const name = player.name.replace(/"/g, '\\"');
        player.dimension.runCommand(`playsound random.orb "${name}" ~ ~ ~ 1 1 2`);
    } catch {}
}

/* =========================================================
   HARD INIT (like "scoreboard players add ... 0")
========================================================= */
export function addZero(obj, player) {
    const id = player?.scoreboardIdentity;
    if (!id) return false;

    // Read current if it exists (keep it), otherwise default to 0
    let cur = 0;
    try {
        const v = obj.getScore(id);
        if (typeof v === "number") cur = v;
    } catch {
        cur = 0;
    }

    // IMPORTANT: setScore creates the participant even when score is 0
    try {
        obj.setScore(id, cur);
        return true;
    } catch {
        return false;
    }
}

export function initMoneyForAllOnlinePlayers() {
    const { dollarsObj, centsObj } = ensureMoneyObjectives();
    if (!dollarsObj || !centsObj) return false;

    const players = world.getAllPlayers();
    if (players.length === 0) return false;

    for (const p of players) {
        addZero(dollarsObj, p);
        addZero(centsObj, p);
    }
    return true;
}

/* =========================================================
   MONEY PARSE + FORMAT (Float -> cents)
========================================================= */
export function parseFloatToCents(value, allowNegative = false) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, error: "Invalid number." };
    }
    if (!allowNegative && value < 0) {
        return { ok: false, error: "Negative amounts not allowed here." };
    }

    const scaled = value * 100;
    const rounded = Math.round(scaled);

    if (Math.abs(scaled - rounded) > 0.01) {
        return { ok: false, error: "Use at most 2 decimals." };
    }

    return { ok: true, cents: rounded };
}

export function formatCents(totalCents) {
    const sign = totalCents < 0 ? "-" : "";
    const abs = Math.abs(totalCents);
    const d = Math.floor(abs / 100);
    const c = abs % 100;
    return `${sign}$${d}.${String(c).padStart(2, "0")}`;
}

export function formatCentsCompact(totalCents) {
    const sign = totalCents < 0 ? "-" : "";
    const absDollars = Math.abs(totalCents) / 100;

    // under 1000: keep normal formatting (keeps cents)
    if (absDollars < 1000) return formatCents(totalCents);

    const units = [
        { v: 1e12, s: "t" },
        { v: 1e9, s: "b" },
        { v: 1e6, s: "m" },
        { v: 1e3, s: "k" },
    ];

    let unit = units[units.length - 1];
    for (const u of units) {
        if (absDollars >= u.v) {
            unit = u;
            break;
        }
    }

    let scaled = absDollars / unit.v;
    let rounded = Math.round(scaled * 10) / 10; // 1 decimal

    // handle edge like 999.95k => 1000.0k -> 1.0m
    if (rounded >= 1000 && unit.s !== "t") {
        const nextIndex = units.findIndex((u) => u.s === unit.s) - 1;
        if (nextIndex >= 0) {
            unit = units[nextIndex];
            scaled = absDollars / unit.v;
            rounded = Math.round(scaled * 10) / 10;
        }
    }

    let num = rounded.toFixed(1).replace(/\.0$/, ""); // remove trailing .0
    return `${sign}$${num}${unit.s}`;
}

export function formatMoneyForPlayer(player, totalCents) {
    return hasCompactMoney(player) ? formatCentsCompact(totalCents) : formatCents(totalCents);
}

/* =========================================================
   PERMISSIONS + CHAT
========================================================= */
export function getCommandSource(origin) {
    return origin?.initiator ?? origin?.sourceEntity ?? null;
}

export function isCommandBlock(origin) {
    return !!origin?.sourceBlock;
}

export function isAdmin(player) {
    return player instanceof Player && player.hasTag(CONFIG.ADMIN_TAG);
}

export function isAdminOrCommandBlock(origin) {
    const src = getCommandSource(origin);
    return isCommandBlock(origin) || isAdmin(src);
}

export function reply(originOrPlayer, text) {
    const p = originOrPlayer instanceof Player ? originOrPlayer : getCommandSource(originOrPlayer);
    if (p instanceof Player) p.sendMessage("§r<§d§lLilys Money§r> §r" + text);
}

/* =========================================================
   INVENTORY HELPERS (prepared for buy/sell later)
========================================================= */
export function getInventoryContainer(player) {
    return player?.getComponent("minecraft:inventory")?.container ?? null;
}

export function getMaxStack(itemId) {
    const itemType = ItemTypes.get(itemId);
    if (!itemType) return 64;
    const probe = new ItemStack(itemType, 1);
    return Math.max(1, probe.maxAmount ?? 64);
}

export function getCapacityForItem(container, itemId) {
    const maxStack = getMaxStack(itemId);
    let capacity = 0;
    for (let i = 0; i < container.size; i++) {
        const s = container.getItem(i);
        if (!s) capacity += maxStack;
        else if (s.typeId === itemId && s.amount < maxStack) capacity += maxStack - s.amount;
    }
    return capacity;
}

export function canFitExact(container, itemId, amount) {
    return getCapacityForItem(container, itemId) >= amount;
}

export function addExactItems(container, itemId, amount) {
    const itemType = ItemTypes.get(itemId);
    if (!itemType) return false;

    const maxStack = getMaxStack(itemId);
    let remaining = amount;

    for (let i = 0; i < container.size && remaining > 0; i++) {
        const s = container.getItem(i);
        if (!s || s.typeId !== itemId) continue;
        if (s.amount >= maxStack) continue;

        const add = Math.min(maxStack - s.amount, remaining);
        s.amount += add;
        container.setItem(i, s);
        remaining -= add;
    }

    for (let i = 0; i < container.size && remaining > 0; i++) {
        const s = container.getItem(i);
        if (s) continue;

        const stackSize = Math.min(maxStack, remaining);
        container.setItem(i, new ItemStack(itemType, stackSize));
        remaining -= stackSize;
    }

    return remaining === 0;
}

export function countItems(container, itemId) {
    let count = 0;
    for (let i = 0; i < container.size; i++) {
        const s = container.getItem(i);
        if (s && s.typeId === itemId) count += s.amount;
    }
    return count;
}

export function removeItems(container, itemId, amount) {
    let remaining = amount;

    for (let i = 0; i < container.size && remaining > 0; i++) {
        const s = container.getItem(i);
        if (!s || s.typeId !== itemId) continue;

        if (s.amount > remaining) {
            s.amount -= remaining;
            container.setItem(i, s);
            remaining = 0;
        } else {
            remaining -= s.amount;
            try {
                if (typeof container.clearItem === "function") container.clearItem(i);
                else container.setItem(i, undefined);
            } catch {
                try {
                    container.setItem(i, null);
                } catch {}
            }
        }
    }
    return amount - remaining;
}

export function hasMoneyActionbar(player) {
    try {
        if (player.hasTag(_tag("PLAYER_ACTIONBAR_ON_TAG", "actionbar_on"))) return true;
        if (player.hasTag(CONFIG.PLAYER_ACTIONBAR_OFF_TAG)) return false;

        return !!getMoneyPersonalDefaults().actionbar;
    } catch {
        return true;
    }
}

export function setMoneyActionbar(player, enabled) {
    try {
        if (enabled) {
            player.addTag(_tag("PLAYER_ACTIONBAR_ON_TAG", "actionbar_on"));
            player.removeTag(CONFIG.PLAYER_ACTIONBAR_OFF_TAG);
        } else {
            player.removeTag(_tag("PLAYER_ACTIONBAR_ON_TAG", "actionbar_on"));
            player.addTag(CONFIG.PLAYER_ACTIONBAR_OFF_TAG);
        }
    } catch {}
}

export function hasMoneySound(player) {
    try {
        if (player.hasTag(_tag("PLAYER_SOUND_ON_TAG", "sound_on"))) return true;
        if (player.hasTag(CONFIG.PLAYER_SOUND_OFF_TAG)) return false;

        return !!getMoneyPersonalDefaults().sound;
    } catch {
        return true;
    }
}

export function setMoneySound(player, enabled) {
    try {
        if (enabled) {
            player.addTag(_tag("PLAYER_SOUND_ON_TAG", "sound_on"));
            player.removeTag(CONFIG.PLAYER_SOUND_OFF_TAG);
        } else {
            player.removeTag(_tag("PLAYER_SOUND_ON_TAG", "sound_on"));
            player.addTag(CONFIG.PLAYER_SOUND_OFF_TAG);
        }
    } catch {}
}

export function hasCompactMoney(player) {
    try {
        if (player.hasTag(CONFIG.PLAYER_COMPACT_TAG)) return true;
        if (player.hasTag(_tag("PLAYER_COMPACT_OFF_TAG", "compact_off"))) return false;

        return !!getMoneyPersonalDefaults().compact;
    } catch {
        return false;
    }
}

export function setCompactMoney(player, enabled) {
    try {
        if (enabled) {
            player.addTag(CONFIG.PLAYER_COMPACT_TAG);
            player.removeTag(_tag("PLAYER_COMPACT_OFF_TAG", "compact_off"));
        } else {
            player.removeTag(CONFIG.PLAYER_COMPACT_TAG);
            player.addTag(_tag("PLAYER_COMPACT_OFF_TAG", "compact_off"));
        }
    } catch {}
}

/* =========================================================
   MONEY DISPLAY SYSTEM (global toggles)
   - Sidebar & Belowname show DOLLARS only (money objective)
   - Actionbar shows $d.cc
========================================================= */

let _displaySettingsCache = null;
const _lastDisplayDollarByPlayerId = new Map();
const _displayIdentityByPlayerId = new Map();

// { sidebar: bool, belowname: bool, actionbar: bool }
export function getMoneyDisplaySettings() {
    if (_displaySettingsCache) return _displaySettingsCache;

    const def = {
        sidebar: true,
        belowname: true,
        actionbar: true,
        actionbarTemplate: CONFIG.ACTIONBAR_TEMPLATE,
    };

    try {
        const raw = world.getDynamicProperty(CONFIG.MONEY_DISPLAY_SETTINGS_DP_KEY);

        // allow migration from older "mode string"
        if (raw === "sidebar") return (_displaySettingsCache = { ...def, sidebar: true });
        if (raw === "belowname") return (_displaySettingsCache = { ...def, belowname: true });
        if (raw === "actionbar") return (_displaySettingsCache = { ...def, actionbar: true });
        if (raw === "off") return (_displaySettingsCache = def);

        if (typeof raw === "string" && raw.length) {
            const parsed = JSON.parse(raw);

            _displaySettingsCache = {
                sidebar: !!parsed?.sidebar,
                belowname: !!parsed?.belowname,
                actionbar: !!parsed?.actionbar,
                actionbarTemplate:
                    typeof parsed?.actionbarTemplate === "string" && parsed.actionbarTemplate.trim().length
                        ? parsed.actionbarTemplate
                        : CONFIG.ACTIONBAR_TEMPLATE,
            };

            return _displaySettingsCache;
        }
    } catch {}

    _displaySettingsCache = def;
    return def;
}

export function setMoneyDisplaySettings(next) {
    const current = getMoneyDisplaySettings();

    const templateRaw = typeof next?.actionbarTemplate === "string" ? next.actionbarTemplate.trim() : current.actionbarTemplate;

    const merged = {
        sidebar: next?.sidebar ?? current.sidebar,
        belowname: next?.belowname ?? current.belowname,
        actionbar: next?.actionbar ?? current.actionbar,
        actionbarTemplate: templateRaw.length ? templateRaw : CONFIG.ACTIONBAR_TEMPLATE,
    };

    _displaySettingsCache = merged;

    try {
        world.setDynamicProperty(CONFIG.MONEY_DISPLAY_SETTINGS_DP_KEY, JSON.stringify(merged));
    } catch {}

    return merged;
}

function decodeActionbarTemplate(raw) {
    return String(raw ?? "")
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "  ");
}

function cleanActionbarTemplate(raw) {
    const fallback = CONFIG.ACTIONBAR_TEMPLATE ?? "§d§lMoney§r: §e{money}";
    const s = decodeActionbarTemplate(raw).replace(/\r\n/g, "\n").trim();
    return s.length ? s : fallback;
}

function getActionbarPlaceholderValue(player, key, totalCents) {
    const rawKey = String(key ?? "").trim();
    const lower = rawKey.toLowerCase();

    if (lower === "money") return formatMoneyForPlayer(player, totalCents);
    if (lower === "money_full") return formatCents(totalCents);

    if (lower === "dollars") {
        return String(Math.trunc(totalCents / 100));
    }

    if (lower === "cents") {
        return String(Math.abs(totalCents % 100)).padStart(2, "0");
    }

    // Any other placeholder is treated as a scoreboard objective.
    // Example: {secs} reads the player's score from objective "secs".
    try {
        const obj = safeGetObjective(rawKey);
        if (!obj) return "0";
        return String(getScoreSafe(obj, player));
    } catch {
        return "0";
    }
}

function formatActionbarText(player, totalCents, templateRaw) {
    const template = cleanActionbarTemplate(templateRaw);

    return template.replace(/\{([A-Za-z0-9_:.-]+)\}/g, (_match, key) => getActionbarPlaceholderValue(player, key, totalCents));
}

function safeClearSlot(slot) {
    try {
        world.scoreboard.clearObjectiveAtDisplaySlot(slot);
    } catch {}
}

function safeRemoveObjective(name) {
    try {
        const obj = world.scoreboard.getObjective(name);
        if (obj) world.scoreboard.removeObjective(obj);
    } catch {}
}

function safeEnsureObjective(name, displayName) {
    try {
        let obj = world.scoreboard.getObjective(name);
        if (!obj) obj = world.scoreboard.addObjective(name, displayName ?? name);
        return obj;
    } catch {
        return null;
    }
}

/**
 * Apply settings to display slots.
 * NOTE: This will overwrite sidebar/belowname display slots globally.
 */
export function applyMoneyDisplaySettings(settings = null) {
    const s = settings ?? getMoneyDisplaySettings();

    // clear slots first (so turning one off actually removes it)
    safeClearSlot(DisplaySlotId.Sidebar);
    safeClearSlot(DisplaySlotId.BelowName);

    const wantScoreboard = s.sidebar || s.belowname;

    if (!wantScoreboard) {
        // no scoreboard displays: remove temp objective so it leaves no traces
        safeRemoveObjective(CONFIG.MONEY_DISPLAY_OBJECTIVE);
    } else {
        const obj = safeEnsureObjective(CONFIG.MONEY_DISPLAY_OBJECTIVE, CONFIG.MONEY_DISPLAY_OBJECTIVE_NAME);
        if (!obj) return;

        try {
            if (s.sidebar) {
                world.scoreboard.setObjectiveAtDisplaySlot(DisplaySlotId.Sidebar, { objective: obj });
            }
        } catch {}
        try {
            if (s.belowname) {
                world.scoreboard.setObjectiveAtDisplaySlot(DisplaySlotId.BelowName, { objective: obj });
            }
        } catch {}
    }
}

/**
 * Recreate temp objective so ONLY ONLINE players appear (no offline "disconnected").
 * Call on join/leave or after toggling sidebar/belowname.
 */
export function recreateMoneyDisplayObjectiveIfNeeded() {
    const s = getMoneyDisplaySettings();
    if (!s.sidebar && !s.belowname) return;

    // clear slots before removing
    safeClearSlot(DisplaySlotId.Sidebar);
    safeClearSlot(DisplaySlotId.BelowName);

    safeRemoveObjective(CONFIG.MONEY_DISPLAY_OBJECTIVE);
    safeEnsureObjective(CONFIG.MONEY_DISPLAY_OBJECTIVE, CONFIG.MONEY_DISPLAY_OBJECTIVE_NAME);

    _lastDisplayDollarByPlayerId.clear();
    _displayIdentityByPlayerId.clear();

    applyMoneyDisplaySettings(s);
}

export function tickMoneyDisplay() {
    const s = getMoneyDisplaySettings();
    const players = world.getAllPlayers();
    if (!players.length) return;

    const { dollarsObj, centsObj } = ensureMoneyObjectives();
    if (!dollarsObj || !centsObj) return;

    // =========================
    // ACTIONBAR / TOASTS
    // =========================
    for (const p of players) {
        const toast = _getToastState(p);
        const wantsMoney = hasMoneyActionbar(p);

        if (wantsMoney) {
            const total = getBalanceCents(dollarsObj, centsObj, p);
            const base = formatActionbarText(p, total, s.actionbarTemplate);
            const finalText = toast.active ? `${base} \n§l§f-§8§a${toast.text}§f§l-§8` : base;

            try {
                p.onScreenDisplay.setActionBar(finalText);
            } catch {}
        } else {
            if (toast.active) {
                try {
                    p.onScreenDisplay.setActionBar(`§a${toast.text}`);
                } catch {}
            } else if (toast.justExpired) {
                try {
                    p.onScreenDisplay.setActionBar("");
                } catch {}
            }
        }
    }

    // =========================
    // SIDEBAR / BELOWNAME
    // Only update scoreboard scores when the dollar amount changed.
    // =========================
    if (s.sidebar || s.belowname) {
        const obj = safeEnsureObjective(CONFIG.MONEY_DISPLAY_OBJECTIVE, CONFIG.MONEY_DISPLAY_OBJECTIVE_NAME);
        if (!obj) return;

        const seen = new Set();

        for (const p of players) {
            const id = p.id;
            seen.add(id);

            // Remember this player's scoreboard identity.
            // This lets us remove only this player when they leave,
            // instead of recreating the entire sidebar objective.
            try {
                if (p.scoreboardIdentity) {
                    _displayIdentityByPlayerId.set(id, p.scoreboardIdentity);
                }
            } catch {}

            const dollars = getScoreSafe(dollarsObj, p);
            if (_lastDisplayDollarByPlayerId.get(id) === dollars) continue;

            try {
                obj.setScore(p.scoreboardIdentity, dollars);
                _lastDisplayDollarByPlayerId.set(id, dollars);
            } catch {}
        }

        // Keep the cache from growing if player IDs are no longer online.
        for (const id of _lastDisplayDollarByPlayerId.keys()) {
            if (!seen.has(id)) _lastDisplayDollarByPlayerId.delete(id);
        }
    }
}

export function removePlayerFromMoneyDisplay(playerId) {
    const id = String(playerId ?? "");
    if (!id) return;

    // Remove their cached displayed balance.
    _lastDisplayDollarByPlayerId.delete(id);

    // Get the scoreboard identity we cached while they were online.
    const identity = _displayIdentityByPlayerId.get(id);
    _displayIdentityByPlayerId.delete(id);

    if (!identity) return;

    try {
        const obj = world.scoreboard.getObjective(CONFIG.MONEY_DISPLAY_OBJECTIVE);

        if (!obj) return;

        // Remove ONLY the player who left.
        obj.removeParticipant(identity);
    } catch {}
}

/* =========================================================
   ACTIONBAR TOASTS (used by /job so it doesn't fight money actionbar)
========================================================= */
const _actionbarToasts = new Map(); // key: player.id -> { text, expiresTick, cleared }

export function setActionbarToast(player, text, durationTicks = 40) {
    if (!(player instanceof Player)) return;
    const now = typeof system.currentTick === "number" ? system.currentTick : 0;
    _actionbarToasts.set(player.id, {
        text: String(text ?? ""),
        expiresTick: now + Math.max(1, durationTicks),
        cleared: false,
    });
}

function _getToastState(player) {
    const entry = _actionbarToasts.get(player.id);
    if (!entry) return { text: "", active: false, justExpired: false };

    const now = typeof system.currentTick === "number" ? system.currentTick : 0;
    if (now >= entry.expiresTick) {
        // expire
        if (!entry.cleared) {
            entry.cleared = true;
            _actionbarToasts.set(player.id, entry);
            return { text: entry.text, active: false, justExpired: true };
        }
        _actionbarToasts.delete(player.id);
        return { text: "", active: false, justExpired: false };
    }

    return { text: entry.text, active: true, justExpired: false };
}
