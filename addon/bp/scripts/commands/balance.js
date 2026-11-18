// BP/scripts/commands/balance.js
import { CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus, Player, system } from "@minecraft/server";
import { CONFIG } from "../config.js";
import { ensureMoneyObjectives, getBalanceCents, formatCents, getCommandSource, reply } from "../jsfunctions.js";

function resolveBalanceSelectorTarget(source, targetArg) {
    if (targetArg === undefined || targetArg === null) {
        return { ok: true, player: source };
    }

    const targets = Array.isArray(targetArg) ? targetArg : targetArg ? [targetArg] : [];

    if (targets.length <= 0) {
        return { ok: true, player: source };
    }

    const players = targets.filter((p) => p instanceof Player);

    if (players.length <= 0) {
        return { ok: false, error: "Target must be one online player." };
    }

    if (players.length > 1) {
        return { ok: false, error: "You can only check one player at a time." };
    }

    return { ok: true, player: players[0] };
}

function handleBalance(origin, targetRaw) {
    const source = getCommandSource(origin);
    if (!(source instanceof Player)) {
        return { status: CustomCommandStatus.Failure, message: "Only players can use /balance." };
    }

    const resolved = resolveBalanceSelectorTarget(source, targetRaw);
    if (!resolved.ok) {
        return {
            status: CustomCommandStatus.Failure,
            message: resolved.error,
        };
    }

    const target = resolved.player;

    system.run(() => {
        const { dollarsObj, centsObj } = ensureMoneyObjectives();
        if (!dollarsObj || !centsObj) {
            reply(origin, "§cMoney objectives are missing and could not be created.");
            return;
        }

        const total = getBalanceCents(dollarsObj, centsObj, target);
        reply(origin, `§f${target.name}§8: §e${formatCents(total)}`);
    });

    return { status: CustomCommandStatus.Success };
}

export function registerBalanceCommands(customCommandRegistry) {
    const base = `lilymoney:balance`;
    const alias = `lilymoney:bal`;

    const def = {
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        optionalParameters: [{ name: "target", type: CustomCommandParamType.PlayerSelector }],
    };

    customCommandRegistry.registerCommand(
        { name: base, description: "Show balance: /balance [name|@s|@p|@r]", ...def },
        (origin, targetRaw) => handleBalance(origin, targetRaw),
    );

    customCommandRegistry.registerCommand(
        { name: alias, description: "Alias of /balance: /bal [name|@s|@p|@r]", ...def },
        (origin, targetRaw) => handleBalance(origin, targetRaw),
    );
}
