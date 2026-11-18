import { Player, world, DisplaySlotId, system } from "@minecraft/server";
import { CONFIG } from "../../config.js";
import { formatCents } from "./formatting.js";
import { safeGetObjective, ensureMoneyObjectives, getScoreSafe, getBalanceCents } from "./balance.js";
import { hasMoneyActionbar, formatMoneyForPlayer } from "../players/preferences.js";

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
