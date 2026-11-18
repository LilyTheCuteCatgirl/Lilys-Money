// BP/scripts/main.js
import { system, world } from "@minecraft/server";
import "./modules/ui/8crafterUiAuto.js";

import { CONFIG } from "./config.js";
import {
    ensureMoneyObjectives,
    initMoneyForAllOnlinePlayers,
    addZero,
    normalizePlayerIfNeeded,
    getStartMoneyCents,
    getBalanceCents,
    setBalanceFromTotalCents,
} from "./modules/economy/balance.js";
import {
    applyMoneyDisplaySettings,
    tickMoneyDisplay,
    recreateMoneyDisplayObjectiveIfNeeded,
    removePlayerFromMoneyDisplay,
} from "./modules/economy/display.js";

import { rememberPlayerName, flushSavedPlayerNames } from "./modules/players/nameDatabase.js";
import { registerBalanceCommands } from "./commands/balance.js";
import { registerSetMoneyCommand } from "./commands/setmoney.js";
import { registerAddMoneyCommand } from "./commands/addmoney.js";
import { registerRemoveMoneyCommand } from "./commands/removemoney.js";
import { registerPayCommand } from "./commands/pay.js";
import { registerBalanceTopCommands } from "./commands/balancetop.js";
import { registerBuyCommand } from "./commands/buy.js";
import { registerSellCommand } from "./commands/sell.js";
import { registerShopCommand } from "./commands/shop.js";
import { registerMoneySettingsCommand } from "./commands/moneysettings.js";
import { registerMoneyHelpCommand } from "./commands/moneyhelp.js";
import { registerJobCommand } from "./commands/job.js";
import { registerAhCommand } from "./commands/ah.js";

import { initializeMoneyLogging, logPlayerJoin } from "./modules/logging/moneylogging.js";

/* =========================================================
   Spawn / first-join setup
   Kept as one handler so join spikes are much smaller on SMPs.
========================================================= */

function configTicks(key, fallback) {
    const n = Math.floor(Number(CONFIG[key] ?? fallback));
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function configCount(key, fallback) {
    const n = Math.floor(Number(CONFIG[key] ?? fallback));
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function addZeroToJoiningPlayer(player) {
    try {
        const { dollarsObj, centsObj } = ensureMoneyObjectives();

        if (dollarsObj && centsObj) {
            const dollarsOk = addZero(dollarsObj, player);
            const centsOk = addZero(centsObj, player);

            if (dollarsOk && centsOk) {
                return true;
            }
        }
    } catch {}

    // Brand-new players may not have a scoreboardIdentity yet.
    // "scoreboard players add <player> <objective> 0" creates their entry
    // without changing an existing score.
    try {
        const name = String(player?.name ?? "").replace(/"/g, '\\"');
        if (!name) return false;

        player.dimension.runCommand(`scoreboard players add "${name}" ${CONFIG.MONEY_DOLLAR_OBJECTIVE} 0`);

        player.dimension.runCommand(`scoreboard players add "${name}" ${CONFIG.MONEY_CENT_OBJECTIVE} 0`);

        return true;
    } catch {}

    return false;
}

function giveStartMoneyIfNeeded(player) {
    try {
        if (!player || player.hasTag(CONFIG.FIRST_JOIN_TAG)) return;

        const start = getStartMoneyCents();

        if (start <= 0) {
            player.addTag(CONFIG.FIRST_JOIN_TAG);
            return;
        }

        const { dollarsObj, centsObj } = ensureMoneyObjectives();
        if (!dollarsObj || !centsObj) return;

        addZeroToJoiningPlayer(player);

        const current = getBalanceCents(dollarsObj, centsObj, player);
        setBalanceFromTotalCents(dollarsObj, centsObj, player, current + start);

        player.addTag(CONFIG.FIRST_JOIN_TAG);
    } catch {}
}

world.afterEvents.playerSpawn.subscribe((ev) => {
    if (!ev.initialSpawn) return;
    const player = ev.player;
    rememberPlayerName(player);

    // Small welcome message. Delayed so it does not fight spawn loading.
    system.runTimeout(
        () => {
            try {
                player.sendMessage(
                    "§d<Lily's Money - v3.4.1>§2 scripts have launched!§r\n§bLily's money Support Discord: §9https://discord.gg/mVJmmAuQeX\n§rremember to use /moneyhelp for commands and /moneysettings for settings.",
                );
            } catch {}
        },
        configTicks("WELCOME_MESSAGE_DELAY_TICKS", 20),
    );

    // Name saving is batched inside nameDatabase.js now.
    system.runTimeout(
        () => {
            try {
                rememberPlayerName(player);
            } catch {}
        },
        configTicks("NAME_SAVE_JOIN_DELAY_TICKS", 20),
    );

    // Init scoreboard entries and starting money without scoreboard commands.
    system.runTimeout(
        () => {
            try {
                addZeroToJoiningPlayer(player);
                giveStartMoneyIfNeeded(player);

                // Update the existing shared Name Database in RAM before the session
                // record/full checkpoint can reference this identity. Its normal save
                // batching behavior remains unchanged.
                try {
                    rememberPlayerName(player);
                } catch {}

                // Exact session-start balance. moneylogging.js owns persistence and
                // immediately returns without writing anything when logging is OFF.
                logPlayerJoin(player);
            } catch {}
        },
        configTicks("JOIN_INIT_DELAY_TICKS", 20),
    );
});

/* =========================================================
   BOOT: create objectives + init players + normalize cents
========================================================= */
system.runTimeout(
    () => {
        ensureMoneyObjectives();
        initMoneyForAllOnlinePlayers();
        for (const player of world.getAllPlayers()) rememberPlayerName(player);
        applyMoneyDisplaySettings();
        recreateMoneyDisplayObjectiveIfNeeded();

        initializeMoneyLogging();
    },
    configTicks("BOOT_INIT_DELAY_TICKS", 20),
);

system.runInterval(() => {
    const { dollarsObj, centsObj } = ensureMoneyObjectives();
    if (!dollarsObj || !centsObj) return;

    for (const p of world.getAllPlayers()) {
        normalizePlayerIfNeeded(dollarsObj, centsObj, p);
    }
}, CONFIG.NORMALIZE_INTERVAL_TICKS);

let scoreboardFallbackSuccesses = 0;

const scoreboardFallbackRun = system.runInterval(
    () => {
        const maxSuccesses = configCount("SCOREBOARD_ZERO_FALLBACK_MAX_SUCCESSES", 3);

        if (maxSuccesses <= 0) {
            try {
                system.clearRun(scoreboardFallbackRun);
            } catch {}
            return;
        }

        const players = world.getAllPlayers();
        if (!players.length) return;

        try {
            const p = players[0];

            p.dimension.runCommand(`scoreboard players add @a ${CONFIG.MONEY_DOLLAR_OBJECTIVE} 0`);
            p.dimension.runCommand(`scoreboard players add @a ${CONFIG.MONEY_CENT_OBJECTIVE} 0`);

            scoreboardFallbackSuccesses++;

            if (scoreboardFallbackSuccesses >= maxSuccesses) {
                try {
                    system.clearRun(scoreboardFallbackRun);
                } catch {}
            }
        } catch {}
    },
    configTicks("SCOREBOARD_ZERO_FALLBACK_INTERVAL_TICKS", 200),
);

/* =========================================================
   Money display
========================================================= */
system.runInterval(() => {
    tickMoneyDisplay();
}, CONFIG.MONEY_DISPLAY_UPDATE_TICKS);

world.beforeEvents.playerLeave?.subscribe(({ player }) => rememberPlayerName(player));

world.afterEvents.playerLeave.subscribe((ev) => {
    try {
        flushSavedPlayerNames();
        removePlayerFromMoneyDisplay(ev.playerId);
    } catch {}
});

/* =========================================================
   COMMAND REGISTRATION
========================================================= */
system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
    registerBalanceCommands(customCommandRegistry);
    registerSetMoneyCommand(customCommandRegistry);
    registerAddMoneyCommand(customCommandRegistry);
    registerRemoveMoneyCommand(customCommandRegistry);
    registerPayCommand(customCommandRegistry);
    registerBalanceTopCommands(customCommandRegistry);
    registerBuyCommand(customCommandRegistry);
    registerSellCommand(customCommandRegistry);
    registerShopCommand(customCommandRegistry);
    registerMoneySettingsCommand(customCommandRegistry);
    registerMoneyHelpCommand(customCommandRegistry);
    registerJobCommand(customCommandRegistry);
    registerAhCommand(customCommandRegistry);
});
