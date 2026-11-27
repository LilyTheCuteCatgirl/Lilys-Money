import { world } from "@minecraft/server";
import { CONFIG } from "../../config.js";

const AH_CLOCK_DP_KEY = "lilymoney:ah_v1:clock_ticks";

let AH_CLOCK_CACHE = null;

export function getAhNowTicks() {
    if (typeof AH_CLOCK_CACHE === "number") return AH_CLOCK_CACHE;

    const raw = world.getDynamicProperty(AH_CLOCK_DP_KEY);
    const ticks = Number(raw ?? 0);
    if (!Number.isSafeInteger(ticks) || ticks < 0) throw new Error("Invalid auction clock.");

    return (AH_CLOCK_CACHE = ticks);
}

export const AH_CLOCK_INTERVAL_TICKS = Math.max(1, Math.floor(Number(CONFIG.AH_CLOCK_INTERVAL_TICKS ?? 1200)));

export function advanceAhClock(ticks = AH_CLOCK_INTERVAL_TICKS) {
    const next = getAhNowTicks() + ticks;
    world.setDynamicProperty(AH_CLOCK_DP_KEY, next);
    AH_CLOCK_CACHE = next;
}

const AH_ACTIVE_DAYS = Math.max(1, Math.floor(Number(CONFIG.AH_ACTIVE_DAYS ?? 30)));

const AH_EXPIRED_COLLECT_DAYS = Math.max(1, Math.floor(Number(CONFIG.AH_EXPIRED_COLLECT_DAYS ?? 100)));

export const TICKS_PER_DAY = 20 * 60 * 60 * 24;

export const AH_ACTIVE_TICKS = AH_ACTIVE_DAYS * TICKS_PER_DAY;

export const AH_EXPIRED_COLLECT_TICKS = AH_EXPIRED_COLLECT_DAYS * TICKS_PER_DAY;
