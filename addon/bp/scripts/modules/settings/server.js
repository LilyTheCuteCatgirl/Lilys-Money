import { world } from "@minecraft/server";
import { CONFIG } from "../../config.js";

const key = "lilymoney:server_options";
const initial = {
    pay: true,
    shop: true,
    buy: true,
    sell: true,
    sidebar: false,
    maxItems: CONFIG.SHOP_MAX_TRADE_AMOUNT,
    search: CONFIG.SHOP_MAX_SEARCH_RESULTS,
    auctions: true,
    sort: "Newest",
    active: CONFIG.AH_MAX_ACTIVE_PER_PLAYER,
    days: CONFIG.AH_ACTIVE_DAYS,
    collect: CONFIG.AH_EXPIRED_COLLECT_DAYS,
    jobs: true,
    cooldown: 0,
    poll: 20,
    join: CONFIG.JOIN_INIT_DELAY_TICKS,
    normalize: CONFIG.NORMALIZE_INTERVAL_TICKS,
    refresh: CONFIG.MONEY_DISPLAY_UPDATE_TICKS,
    retry: CONFIG.SCOREBOARD_ZERO_FALLBACK_INTERVAL_TICKS,
    stats: CONFIG.JOB_STATS_FLUSH_INTERVAL_TICKS,
    cleanup: CONFIG.JOB_PLACED_BLOCK_CLEANUP_INTERVAL_TICKS,
    expiry: CONFIG.AH_CLOCK_INTERVAL_TICKS,
    boot: CONFIG.BOOT_INIT_DELAY_TICKS,
};
let cached;
export function serverOptions() {
    if (!cached) cached = { ...initial, ...JSON.parse(world.getDynamicProperty(key) ?? "{}") };

    return cached;
}
export function saveServerOptions(changes) {
    const next = { ...serverOptions(), ...changes };
    world.setDynamicProperty(key, JSON.stringify(next));
    cached = next;
}
function positive(max) {
    return (raw) => (/^\d+$/.test(raw) && Number(raw) >= 1 && Number(raw) <= max ? Number(raw) : undefined);
}
export const serverFields = {
    "Shop Settings": [
        ["shop", "Enable /shop"],
        ["buy", "Allow Shop Buying"],
        ["sell", "Allow Shop Selling"],
        ["maxItems", "Maximum Items per Transaction (1–2304)", "text", positive(2304)],
        ["search", "Maximum Search Results", [10, 25, 30, 50, 100]],
    ],
    "General Auction Settings": [
        ["auctions", "Enable /ah Trading (owners can still recover items)"],
        ["sort", "Default Auction Sorting", ["Newest", "Cheapest", "Most Expensive"]],
    ],
    "Limits & Durations": [
        ["active", "Maximum Active Listings per Player (1–100)", "text", positive(100)],
        ["days", "Auction Listing Duration (days)", [1, 3, 7, 14, 30]],
        ["collect", "Expired Item Collection Duration (days)", [7, 30, 60, 100]],
    ],
    "Jobs Settings": [
        ["jobs", "Enable Jobs"],
        ["cooldown", "Job Change Cooldown (minutes, 0 = off)", [0, 1, 5, 15, 30, 60]],
    ],
    "HUD & Economy Timing": [
        ["normalize", "Scoreboard Normalization Interval (ticks, after reload)", [100, 200, 400]],
        ["poll", "HUD Balance Polling Interval (ticks)", [20, 40, 60]],
        ["refresh", "HUD Preferences Refresh Interval (ticks, after reload)", [40, 80, 120]],
        ["retry", "Scoreboard Initialization Retry Interval (ticks, after reload)", [200, 400, 600]],
    ],
    "Jobs & Auction Timing": [
        ["stats", "Job Statistics Save Interval (ticks, after reload)", [400, 600, 1200]],
        ["cleanup", "Placed-Block Cleanup Interval (ticks, after reload)", [200, 400, 600]],
        ["expiry", "Auction Expiration Check Interval (ticks, after reload)", [18000, 36000, 72000]],
    ],
    "Startup & Initialization Timing": [
        ["boot", "Initial Add-on Startup Delay (ticks, after reload)", [20, 40, 60]],
        ["join", "Player Balance Initialization Delay (ticks, next join)", [2, 5, 10]],
    ],
};
