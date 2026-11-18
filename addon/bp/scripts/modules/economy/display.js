import { Player, world, DisplaySlotId, system } from "@minecraft/server";
import { CONFIG } from "../../config.js";
import { formatCents } from "./formatting.js";
import { safeGetObjective, ensureMoneyObjectives, getScoreSafe, getBalanceCents } from "./balance.js";
import { hasMoneyActionbar, formatMoneyForPlayer } from "../players/preferences.js";

// The sidebar and below-name slots show whole dollars. The actionbar supports cents.

let _displaySettingsCache = null;
const _lastDisplayDollarByPlayerId = new Map();
const _displayIdentityByPlayerId = new Map();

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

        // Older worlds may store a single mode name instead of a settings object.
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

    // Other placeholders read scoreboard objectives. For example, {secs} shows the player's score in secs.
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

/** Applying these settings replaces the world's sidebar and below-name display slots. */
export function applyMoneyDisplaySettings(settings = null) {
    const s = settings ?? getMoneyDisplaySettings();

    safeClearSlot(DisplaySlotId.Sidebar);
    safeClearSlot(DisplaySlotId.BelowName);

    const wantScoreboard = s.sidebar || s.belowname;

    if (!wantScoreboard) {
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

/** Rebuild the temporary objective from online players to remove stale scoreboard entries. */
export function recreateMoneyDisplayObjectiveIfNeeded() {
    const s = getMoneyDisplaySettings();
    if (!s.sidebar && !s.belowname) return;

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

    // Only changed dollar amounts need a scoreboard write.
    if (s.sidebar || s.belowname) {
        const obj = safeEnsureObjective(CONFIG.MONEY_DISPLAY_OBJECTIVE, CONFIG.MONEY_DISPLAY_OBJECTIVE_NAME);
        if (!obj) return;

        const seen = new Set();

        for (const p of players) {
            const id = p.id;
            seen.add(id);

            // Keep the identity while the player is online so their display entry can be removed after they leave.
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

        for (const id of _lastDisplayDollarByPlayerId.keys()) {
            if (!seen.has(id)) _lastDisplayDollarByPlayerId.delete(id);
        }
    }
}

export function removePlayerFromMoneyDisplay(playerId) {
    const id = String(playerId ?? "");
    if (!id) return;

    _lastDisplayDollarByPlayerId.delete(id);

    const identity = _displayIdentityByPlayerId.get(id);
    _displayIdentityByPlayerId.delete(id);

    if (!identity) return;

    try {
        const obj = world.scoreboard.getObjective(CONFIG.MONEY_DISPLAY_OBJECTIVE);

        if (!obj) return;

        obj.removeParticipant(identity);
    } catch {}
}

// Job messages temporarily take priority over the money actionbar.
const _actionbarToasts = new Map();

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
