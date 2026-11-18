import { world } from "@minecraft/server";
import { CONFIG } from "../../config.js";
import { formatCents, formatCentsCompact } from "../economy/formatting.js";

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

export function playMoneySound(player) {
    try {
        if (!hasMoneySound(player)) return;

        // Try the sound API first to avoid running a command for each payment.
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

export function formatMoneyForPlayer(player, totalCents) {
    return hasCompactMoney(player) ? formatCentsCompact(totalCents) : formatCents(totalCents);
}
