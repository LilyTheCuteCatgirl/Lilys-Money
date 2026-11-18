// BP/scripts/config.js

export const CONFIG = Object.freeze({
    // =========================================================
    // EASY USER SETTINGS
    // These are safe for normal server owners to change.
    // =========================================================

    // Players with this tag can use Lily's Money admin menus/settings.
    ADMIN_TAG: "admin",

    // Text shown for money objectives/displays.
    MONEY_DOLLAR_DISPLAY: "§d§lMoney",
    MONEY_CENT_DISPLAY: "§d§lMoney Cents",
    MONEY_DISPLAY_OBJECTIVE_NAME: "§d§lMoney",

    // Actionbar money text.
    // Use {money} where the player's money should appear.
    ACTIONBAR_TEMPLATE: "§d§lMoney§r: §e{money}",

    // How many players show on each /balancetop page.
    TOP_N_PER_PAGE: 10,

    // =========================================================
    // GAMEPLAY SETTINGS
    // These can be changed, but use reasonable values.
    // =========================================================

    // Starting setup delay when a player joins.
    // Usually does not need changing.
    JOIN_INIT_DELAY_TICKS: 2,

    // Auction House settings
    AH_PAGE_SIZE: 20,
    AH_MAX_ACTIVE_PER_PLAYER: 20,
    AH_MAX_EXPIRED_PER_PLAYER: 20,
    // Max saved "your auction sold" messages per player.
    AH_MAX_PENDING_SOLD_MESSAGES_PER_PLAYER: 20,

    // Active-world days.
    // 30 = auctions expire after 30 days while the world is running.
    AH_ACTIVE_DAYS: 30,

    // Active-world days after expiration before expired items are deleted.
    AH_EXPIRED_COLLECT_DAYS: 100,

    // Shop settings
    // 2304 = 36 inventory slots x 64 items.
    SHOP_MAX_TRADE_AMOUNT: 2304,

    // Maximum search results shown when using /shop <search>.
    // Keeps broad searches like /shop e from freezing the game.
    SHOP_MAX_SEARCH_RESULTS: 30,

    // =========================================================
    // DISPLAY / PERFORMANCE SETTINGS
    // These are okay to change if a server is laggy.
    // Higher ticks = less frequent updates = better performance.
    // 20 ticks = about 1 second.
    // =========================================================

    // How often cents are normalized into dollars/cents.
    NORMALIZE_INTERVAL_TICKS: 100,

    // How often actionbar/sidebar/belowname money display updates.
    MONEY_DISPLAY_UPDATE_TICKS: 20,

    // Delay before recreating sidebar/belowname display after joins/leaves.
    MONEY_DISPLAY_RECREATE_DELAY_TICKS: 40,

    // Startup delays.
    BOOT_INIT_DELAY_TICKS: 20,
    WELCOME_MESSAGE_DELAY_TICKS: 20,
    NAME_SAVE_JOIN_DELAY_TICKS: 20,

    // =========================================================
    // ADVANCED INTERNAL TIMING
    // You can change these, but most people should leave them alone.
    // These should not reset saved data, but bad values can cause delays,
    // lag, or weird behavior.
    // =========================================================

    // Scoreboard fallback.
    // Runs a few times during boot, then stops.
    SCOREBOARD_ZERO_FALLBACK_INTERVAL_TICKS: 200,
    SCOREBOARD_ZERO_FALLBACK_MAX_SUCCESSES: 3,

    // Auction House clock/check interval.
    // Do not change unless you understand it.
    // Higher values can make auctions expire late.

    // 72000 ticks = 1 hour.
    // AH timers/expiration checks update once per hour.
    AH_CLOCK_INTERVAL_TICKS: 72000,

    // Job system intervals.
    JOB_PLACED_BLOCK_CLEANUP_INTERVAL_TICKS: 200,
    JOBS_INIT_RETRY_INTERVAL_TICKS: 20,
    JOBS_INIT_MAX_TRIES: 60,
    JOB_STATS_FLUSH_INTERVAL_TICKS: 400,

    // =========================================================
    // DO NOT TOUCH BELOW THIS LINE
    // Changing these can reset/break saved money, shops, jobs,
    // auction house data, personal settings, or old player data.
    // =========================================================

    TRANSACTION_LOGGING_DP_KEY: "lilymoney:transaction_logging",

    MONEY_DOLLAR_OBJECTIVE: "money",
    MONEY_CENT_OBJECTIVE: "moneycent",

    MONEY_DISPLAY_SETTINGS_DP_KEY: "lilymoney:money_display_settings",
    MONEY_DISPLAY_OBJECTIVE: "lilymoney_display",

    MONEY_PERSONAL_DEFAULTS_DP_KEY: "lilymoney:money_personal_defaults",
    START_MONEY_CENTS_DP_KEY: "lilymoney:start_money_cents",

    NAME_CACHE_DP_KEY: "lilymoney:name_cache_v1",
    NAME_CACHE_MAX_CHARS: 32767,

    FIRST_JOIN_TAG: "lilymoney:got_start_money",

    PLAYER_ACTIONBAR_TAG: "lilymoney:actionbar_money",

    PLAYER_ACTIONBAR_OFF_TAG: "lilymoney:actionbar_off",
    PLAYER_ACTIONBAR_ON_TAG: "lilymoney:actionbar_on",

    PLAYER_SOUND_OFF_TAG: "lilymoney:sound_off",
    PLAYER_SOUND_ON_TAG: "lilymoney:sound_on",

    PLAYER_COMPACT_TAG: "lilymoney:compact_numbers",
    PLAYER_COMPACT_OFF_TAG: "lilymoney:compact_off",
});
