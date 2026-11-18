// BP/scripts/commands/pay.js
import { CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus, Player, system } from "@minecraft/server";
import { ensureMoneyObjectives, getBalanceCents, setBalanceFromTotalCents } from "../modules/economy/balance.js";
import { parseFloatToCents, formatCents } from "../modules/economy/formatting.js";
import { getCommandSource, isCommandBlock, reply } from "../modules/commandSource.js";

import { playMoneySound } from "../modules/players/preferences.js";

import { logMoneyEvent } from "../modules/logging/moneylogging.js";

function resolvePaySelectorTarget(source, targetArg) {
    const targets = Array.isArray(targetArg) ? targetArg : targetArg ? [targetArg] : [];

    const players = targets.filter((p) => p instanceof Player);

    if (players.length <= 0) {
        return { ok: false, error: "Target must be one online player." };
    }

    if (players.length > 1) {
        return { ok: false, error: "You can only pay one player at a time." };
    }

    const target = players[0];

    if (target.id === source.id) {
        return { ok: false, error: "You can't pay yourself." };
    }

    return { ok: true, player: target };
}

export function registerPayCommand(customCommandRegistry) {
    customCommandRegistry.registerCommand(
        {
            name: `lilymoney:pay`,
            description: "Pay another player (no debt) /pay <player|@p|@r|@s> <amount>",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
            mandatoryParameters: [
                { name: "target", type: CustomCommandParamType.PlayerSelector },
                { name: "amount", type: CustomCommandParamType.Float },
            ],
        },
        (origin, targetRaw, amountFloat) => {
            const source = getCommandSource(origin);

            if (isCommandBlock(origin) || !(source instanceof Player)) {
                return { status: CustomCommandStatus.Failure, message: "Player-only. Command blocks/console cannot use /pay." };
            }

            const parsedAmount = parseFloatToCents(amountFloat, false);
            if (!parsedAmount.ok) return { status: CustomCommandStatus.Failure, message: parsedAmount.error };
            const amount = parsedAmount.cents;
            if (amount <= 0) return { status: CustomCommandStatus.Failure, message: "Amount must be > 0." };

            const resolved = resolvePaySelectorTarget(source, targetRaw);
            if (!resolved.ok) {
                return {
                    status: CustomCommandStatus.Failure,
                    message: resolved.error,
                };
            }

            const target = resolved.player;

            system.run(() => {
                const { dollarsObj, centsObj } = ensureMoneyObjectives();
                if (!dollarsObj || !centsObj) return;

                const senderBal = getBalanceCents(dollarsObj, centsObj, source);
                if (senderBal < amount) {
                    reply(origin, `§cNot enough money. Balance: §e${formatCents(senderBal)}§c, needed: §e${formatCents(amount)}§c.`);
                    return;
                }

                const targetBal = getBalanceCents(dollarsObj, centsObj, target);

                setBalanceFromTotalCents(dollarsObj, centsObj, source, senderBal - amount);
                setBalanceFromTotalCents(dollarsObj, centsObj, target, targetBal + amount);

                logMoneyEvent("PAY", {
                    actor: source,
                    target,
                    amountCents: amount,
                    actorBalanceAfter: senderBal - amount,
                    targetBalanceAfter: targetBal + amount,
                });

                reply(origin, `§aPaid §f${target.name} §e${formatCents(amount)}§a. New balance: §e${formatCents(senderBal - amount)}§a.`);
                playMoneySound(source);
                playMoneySound(target);
                target.sendMessage(
                    "§r<§dLily's Money§r> §r" +
                        `§aYou received §e${formatCents(amount)}§a from §f${source.name}§a. New balance: §e${formatCents(targetBal + amount)}§a.`,
                );
            });

            return { status: CustomCommandStatus.Success };
        },
    );
}
