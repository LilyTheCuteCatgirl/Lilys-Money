import { chatText } from "../modules/chat.js";
import { CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus, Player, system } from "@minecraft/server";
import { CONFIG } from "../config.js";
import { ensureMoneyObjectives, getScoreSafe } from "../modules/economy/balance.js";
import { getDisplayOptions, hasCompactMoney } from "../modules/players/preferences.js";
import { formatDisplayMoney } from "../modules/economy/formatting.js";
import { getCommandSource, reply } from "../modules/commandSource.js";

import { getSavedPlayerNameFromParticipant } from "../modules/players/nameDatabase.js";

function buildTopMoneyMessage(rows, page, perPage, viewer) {
    const totalPages = Math.max(1, Math.ceil(rows.length / perPage));
    const safePage = Math.min(Math.max(1, page), totalPages);

    const start = (safePage - 1) * perPage;
    const slice = rows.slice(start, start + perPage);

    let text = `§bTop Money §8(Page §f${safePage}§8/§f${totalPages}§8)\n`;

    if (slice.length === 0) {
        text += "§8No entries yet.";
        return text;
    }

    const options = getDisplayOptions(viewer);
    const compact = hasCompactMoney(viewer);

    for (let i = 0; i < slice.length; i++) {
        const rank = start + i + 1;
        const r = slice[i];
        text += `§e#${rank} §f${r.name} §8- §a${formatDisplayMoney(r.total, options, compact)}\n`;
    }

    text += `§8Tip: /topmoney ${safePage + 1} for next page`;
    return text.trimEnd();
}

function handleTopMoney(origin, pageArg) {
    const page = Number.isInteger(pageArg) ? pageArg : 1;
    if (page < 1) return { status: CustomCommandStatus.Failure, message: chatText("Page must be 1 or higher.") };

    system.run(() => {
        const { dollarsObj, centsObj } = ensureMoneyObjectives();
        if (!dollarsObj || !centsObj) return;

        let p1 = [];
        let p2 = [];
        try {
            p1 = dollarsObj.getParticipants();
        } catch {}
        try {
            p2 = centsObj.getParticipants();
        } catch {}

        // Use the scoreboard ID when available so renamed participants keep one entry.
        const ids = new Map();
        for (const ident of p1) ids.set(String(ident?.id ?? ident?.displayName ?? Math.random()), ident);
        for (const ident of p2) ids.set(String(ident?.id ?? ident?.displayName ?? Math.random()), ident);

        const rows = [];
        for (const ident of ids.values()) {
            const d = getScoreSafe(dollarsObj, ident);
            const c = getScoreSafe(centsObj, ident);
            rows.push({
                name: getSavedPlayerNameFromParticipant(ident) ?? "Unknown",
                total: d * 100 + c,
            });
        }

        rows.sort((a, b) => b.total - a.total);

        const src = getCommandSource(origin);
        if (src instanceof Player) reply(origin, buildTopMoneyMessage(rows, page, CONFIG.TOP_N_PER_PAGE ?? 10, src));
    });

    return { status: CustomCommandStatus.Success };
}

export function registerBalanceTopCommands(customCommandRegistry) {
    const def = {
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        optionalParameters: [{ name: "page", type: CustomCommandParamType.Integer }],
    };

    customCommandRegistry.registerCommand(
        { name: `lilymoney:topmoney`, description: "Top money leaderboard: /topmoney [page]", ...def },
        (origin, page) => handleTopMoney(origin, page),
    );

    customCommandRegistry.registerCommand({ name: `lilymoney:baltop`, description: "Alias of /topmoney", ...def }, (origin, page) =>
        handleTopMoney(origin, page),
    );

    customCommandRegistry.registerCommand({ name: `lilymoney:balancetop`, description: "Alias of /topmoney", ...def }, (origin, page) =>
        handleTopMoney(origin, page),
    );
}
