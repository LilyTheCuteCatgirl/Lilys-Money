import { system, world } from "@minecraft/server";
import { CONFIG } from "../../config.js";
import { formatDisplayMoney } from "../economy/formatting.js";

const confirmationDefaults = { confirmBuy: true, confirmSell: true, confirmAuctionBuy: true, confirmAuctionList: true };

function confirmations(source, fallback) {
    return Object.fromEntries(
        Object.keys(confirmationDefaults).map((key) => [key, typeof source?.[key] === "boolean" ? source[key] : fallback[key]]),
    );
}

let _personalDefaultsCache = null;

export function getMoneyPersonalDefaults() {
    if (_personalDefaultsCache) return _personalDefaultsCache;

    const def = {
        ...confirmationDefaults,
        hud: true,
        notifications: true,
        duration: 3,
        position: "Top right",
        sound: true,
        compact: false,
    };

    try {
        const raw = world.getDynamicProperty(CONFIG.MONEY_PERSONAL_DEFAULTS_DP_KEY);
        if (typeof raw === "string" && raw.length) {
            const parsed = JSON.parse(raw);

            _personalDefaultsCache = {
                ...confirmations(parsed, def),
                notifications: typeof parsed?.notifications === "boolean" ? parsed.notifications : true,
                duration: DURATIONS.includes(parsed?.duration) ? parsed.duration : 3,
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
        ...confirmations(next, cur),
        notifications: next.notifications ?? cur.notifications,
        duration: DURATIONS.includes(next.duration) ? next.duration : cur.duration,
        hud: typeof next?.hud === "boolean" ? next.hud : cur.hud,
        position: HUD_POSITIONS.includes(next?.position) ? next.position : cur.position,
        sound: typeof next?.sound === "boolean" ? next.sound : cur.sound,
        compact: typeof next?.compact === "boolean" ? next.compact : cur.compact,
    };

    world.setDynamicProperty(CONFIG.MONEY_PERSONAL_DEFAULTS_DP_KEY, JSON.stringify(merged));
    _personalDefaultsCache = merged;

    return merged;
}

function _tag(name, fallback) {
    return CONFIG[name] ?? `lilymoney:${fallback}`;
}

export const DURATIONS = [1, 2, 3, 4, 5, 7, 10];
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

const lastSound = new WeakMap();
export function playMoneySound(player, event = "receive") {
    try {
        if (!hasMoneySound(player)) return;

        const options = getDisplayOptions(player);
        if (event === "spend" ? !options.spendSound : !options.receiveSound) return;
        if ((event === "job" && !options.jobSound) || (event === "auction" && !options.auctionSound)) return;
        if (options.combineSound && system.currentTick - (lastSound.get(player) ?? -Infinity) < 4) return;
        lastSound.set(player, system.currentTick);
        const volume = (options.volume / 100) * (options.effect === "Soft" ? 0.65 : 1);
        const pitch = options.effect === "Soft" ? 0.8 : options.effect === "Coin" ? 1.7 : 1;
        // Try the sound API first to avoid running a command for each payment.
        try {
            if (typeof player.playSound === "function") {
                player.playSound("random.orb", { volume, pitch });

                return;
            }
        } catch {}

        const name = player.name.replace(/"/g, '\\"');
        player.dimension.runCommand(`playsound random.orb "${name}" ~ ~ ~ ${volume} ${pitch} 2`);
    } catch {}
}

export function formatMoneyForPlayer(player, totalCents) {
    return formatDisplayMoney(totalCents, getDisplayOptions(player), hasCompactMoney(player));
}

const preferenceKey = "lilymoney:display_options";
const options = {
    smart: false,
    cents: "Always",
    group: "None",
    decimal: "Period",
    color: "White",
    boldBalance: true,
    effect: "XP Orb",
    combine: true,
    animate: true,
    job: true,
    shop: true,
    auction: true,
    payment: true,
    admin: true,
    other: true,
    spending: true,
    names: true,
    quantity: true,
    volume: 100,
    receiveSound: true,
    spendSound: true,
    jobSound: true,
    auctionSound: true,
    combineSound: false,
};
function overrides(player) {
    return JSON.parse(player.getDynamicProperty?.(preferenceKey) ?? "{}");
}
export function getDisplayOptions(player) {
    const defaults = getMoneyPersonalDefaults();
    const { notifications, duration } = defaults;

    return { ...options, ...confirmations(defaults, confirmationDefaults), notifications, duration, ...overrides(player) };
}
export function saveDisplayOptions(player, changes) {
    player.setDynamicProperty(preferenceKey, JSON.stringify({ ...overrides(player), ...changes }));
}
