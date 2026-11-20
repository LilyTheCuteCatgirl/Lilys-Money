import { world } from "@minecraft/server";
import { CONFIG } from "../../config.js";
import { formatCents, formatCentsCompact } from "../economy/formatting.js";

let _personalDefaultsCache = null;

export function getMoneyPersonalDefaults() {
    if (_personalDefaultsCache) return _personalDefaultsCache;

    const def = {
        hud: true,
        position: "Top right",
        sound: true,
        compact: false,
    };

    try {
        const raw = world.getDynamicProperty(CONFIG.MONEY_PERSONAL_DEFAULTS_DP_KEY);
        if (typeof raw === "string" && raw.length) {
            const parsed = JSON.parse(raw);

            _personalDefaultsCache = {
                hud: typeof parsed?.hud === "boolean" ? parsed.hud : def.hud,
                position: HUD_POSITIONS.includes(parsed?.position) ? parsed.position : def.position,
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
        hud: typeof next?.hud === "boolean" ? next.hud : cur.hud,
        position: HUD_POSITIONS.includes(next?.position) ? next.position : cur.position,
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

export const HUD_POSITIONS = ["Top right", "Top left", "Bottom right", "Bottom left"];

export function getHudPosition(player) {
    for (const position of HUD_POSITIONS) {
        if (player.hasTag("lilymoney:hud_" + position.toLowerCase().replace(" ", "_"))) return position;
    }
    return getMoneyPersonalDefaults().position;
}

export function setHudPosition(player, selected) {
    if (!HUD_POSITIONS.includes(selected)) return;
    for (const position of HUD_POSITIONS) {
        const tag = "lilymoney:hud_" + position.toLowerCase().replace(" ", "_");
        if (position === selected) player.addTag(tag);
        else player.removeTag(tag);
    }
}

export function hasMoneyHud(player) {
    if (player.hasTag(CONFIG.PLAYER_HUD_ON_TAG)) return true;
    if (player.hasTag(CONFIG.PLAYER_HUD_OFF_TAG)) return false;
    return getMoneyPersonalDefaults().hud;
}

export function setMoneyHud(player, enabled) {
    player.addTag(enabled ? CONFIG.PLAYER_HUD_ON_TAG : CONFIG.PLAYER_HUD_OFF_TAG);
    player.removeTag(enabled ? CONFIG.PLAYER_HUD_OFF_TAG : CONFIG.PLAYER_HUD_ON_TAG);
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
