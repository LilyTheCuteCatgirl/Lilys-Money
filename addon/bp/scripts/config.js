export const CONFIG = Object.freeze({
    // Server settings

    // Players with this tag can access the add-on's admin menus. Choose a tag reserved for trusted players.
    ADMIN_TAG: "admin",

    // Labels for the dollar, cent and display objectives. These are display names, separate from the IDs used to store balances.
    MONEY_DOLLAR_DISPLAY: "§d§lMoney",
    MONEY_CENT_DISPLAY: "§d§lMoney Cents",
    MONEY_DISPLAY_OBJECTIVE_NAME: "§d§lMoney",

    // Number of entries on each /balancetop page.
    TOP_N_PER_PAGE: 10,

    // Gameplay settings

    // Delay after a player's initial spawn before setting up their balance and checking for starting money.
    // Timing settings use game ticks. At normal speed, 20 ticks take about one second.
    JOIN_INIT_DELAY_TICKS: 2,

    // Number of listings shown on one auction page.
    AH_PAGE_SIZE: 20,
    // Maximum simultaneous active listings per seller.
    AH_MAX_ACTIVE_PER_PLAYER: 20,
    // Maximum ordinary expired listings per seller. The oldest are removed first when the cap is enforced.
    AH_MAX_EXPIRED_PER_PLAYER: 20,
    // Sold notices kept per seller. When the queue fills, the oldest notices are dropped.
    AH_MAX_PENDING_SOLD_MESSAGES_PER_PLAYER: 20,

    // Lifetime for new listings. Each day is 24 hours of world runtime at normal speed. The clock pauses while the world is closed.
    AH_ACTIVE_DAYS: 30,

    // Days of world runtime available to collect an item after it expires.
    // Old potion and shulker box listings are kept because their items cannot be restored safely.
    AH_EXPIRED_COLLECT_DAYS: 100,

    // Maximum items per shop transaction. The default equals 36 stacks of 64. Inventory limits still apply.
    SHOP_MAX_TRADE_AMOUNT: 2304,

    // Maximum matches shown for a shop search. Smaller limits keep broad searches from producing large menus.
    SHOP_MAX_SEARCH_RESULTS: 30,

    // Display and performance settings

    // Ticks between balance normalization passes for online players. Longer intervals reduce how often the scoreboards are checked.
    NORMALIZE_INTERVAL_TICKS: 100,

    // Ticks between checks for changes to HUD preferences.
    MONEY_DISPLAY_UPDATE_TICKS: 40,

    // Reserved setting. The current display code does not use this delay.
    MONEY_DISPLAY_RECREATE_DELAY_TICKS: 40,

    // Ticks to wait before setting up objectives, displays and logging at startup.
    BOOT_INIT_DELAY_TICKS: 20,
    // Ticks after joining before the welcome message appears.
    WELCOME_MESSAGE_DELAY_TICKS: 20,
    // Ticks before retrying the name lookup after joining. The name database schedules its own saves.
    NAME_SAVE_JOIN_DELAY_TICKS: 20,

    // Advanced timing
    // The defaults suit most worlds. Shorter intervals run the corresponding checks more often.

    // Ticks between attempts to initialize missing scoreboard entries for online players.
    SCOREBOARD_ZERO_FALLBACK_INTERVAL_TICKS: 200,
    // Stop after this many successful passes. Set to zero to disable the fallback.
    SCOREBOARD_ZERO_FALLBACK_MAX_SUCCESSES: 3,

    // Ticks between auction clock updates and expiry checks. The default is one hour at normal speed.
    // Longer intervals can delay when an expired listing disappears from active auctions.
    AH_CLOCK_INTERVAL_TICKS: 72000,

    // Ticks between passes that clear expired player-placed block records. This does not set how long a block is tracked.
    JOB_PLACED_BLOCK_CLEANUP_INTERVAL_TICKS: 200,
    // Ticks between attempts to load the saved job definitions at startup.
    JOBS_INIT_RETRY_INTERVAL_TICKS: 20,
    // After this many attempts, check whether storage is empty before saving defaults.
    JOBS_INIT_MAX_TRIES: 60,
    // Ticks between saves of buffered job statistics. A longer interval leaves recent changes in memory longer.
    JOB_STATS_FLUSH_INTERVAL_TICKS: 400,

    //_____________________________________________________________________________________________________________________________________
    // Internal identifiers
    // Leave these property keys, objective IDs and player tags unchanged in existing worlds.
    // The add-on uses them to find saved balances, names and preferences.

    TRANSACTION_LOGGING_DP_KEY: "lilymoney:transaction_logging",

    // These two objectives hold player balances. Changing either ID points the add-on at a different scoreboard.
    MONEY_DOLLAR_OBJECTIVE: "money",
    MONEY_CENT_OBJECTIVE: "moneycent",

    MONEY_DISPLAY_SETTINGS_DP_KEY: "lilymoney:money_display_settings",
    // This temporary objective can be removed and rebuilt. Keep its ID separate from both balance objectives.
    MONEY_DISPLAY_OBJECTIVE: "lilymoney_display",

    MONEY_PERSONAL_DEFAULTS_DP_KEY: "lilymoney:money_personal_defaults",
    START_MONEY_CENTS_DP_KEY: "lilymoney:start_money_cents",

    NAME_CACHE_DP_KEY: "lilymoney:name_cache_v1",
    // Reserved value. The name database applies its own page size limit.
    NAME_CACHE_MAX_CHARS: 32767,

    // Marks players who have received their starting allowance. Renaming it can pay existing players again.
    FIRST_JOIN_TAG: "lilymoney:got_start_money",

    PLAYER_HUD_OFF_TAG: "lilymoney:hud_off",
    PLAYER_HUD_ON_TAG: "lilymoney:hud_on",

    PLAYER_SOUND_OFF_TAG: "lilymoney:sound_off",
    PLAYER_SOUND_ON_TAG: "lilymoney:sound_on",

    PLAYER_COMPACT_TAG: "lilymoney:compact_numbers",
    PLAYER_COMPACT_OFF_TAG: "lilymoney:compact_off",
});
