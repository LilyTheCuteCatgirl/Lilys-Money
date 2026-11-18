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

    // A new player may lack a scoreboard identity. Adding zero by name creates an entry while preserving any existing score.
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

    system.runTimeout(
        () => {
            try {
                player.sendMessage(
                    "§d<Lily's Money - v3.4.2>§2 scripts have launched!§r\n§bLily's money Support Discord: §9https://discord.gg/mVJmmAuQeX\n§rremember to use /moneyhelp for commands and /moneysettings for settings.",
                );
            } catch {}
        },
        configTicks("WELCOME_MESSAGE_DELAY_TICKS", 20),
    );

    // Retry after spawn in case the player's scoreboard identity was unavailable on the first attempt.
    system.runTimeout(
        () => {
            try {
                rememberPlayerName(player);
            } catch {}
        },
        configTicks("NAME_SAVE_JOIN_DELAY_TICKS", 20),
    );

    system.runTimeout(
        () => {
            try {
                addZeroToJoiningPlayer(player);
                giveStartMoneyIfNeeded(player);

                // Cache the name before the join record or a checkpoint can refer to this identity.
                try {
                    rememberPlayerName(player);
                } catch {}

                // Record the balance after starting money has been applied. The logger checks whether recording is enabled.
                logPlayerJoin(player);
            } catch {}
        },
        configTicks("JOIN_INIT_DELAY_TICKS", 20),
    );
});

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
