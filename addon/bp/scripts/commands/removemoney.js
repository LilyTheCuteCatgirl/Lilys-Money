import { CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus, Player, system } from "@minecraft/server";
import { CONFIG } from "../config.js";
import { ensureMoneyObjectives, getBalanceCents, setBalanceFromTotalCents } from "../modules/economy/balance.js";
import { parseFloatToCents, formatCents } from "../modules/economy/formatting.js";
import { isAdminOrCommandBlock, getCommandSource, reply } from "../modules/commandSource.js";
import { logMoneyEvent } from "../modules/logging/moneylogging.js";

export function registerRemoveMoneyCommand(customCommandRegistry) {
    customCommandRegistry.registerCommand(
        {
            name: `lilymoney:removemoney`,
            description: "Admin/CB: remove money (can go negative) /removemoney <selector> <amount>",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
            mandatoryParameters: [
                { name: "target", type: CustomCommandParamType.PlayerSelector },
                { name: "amount", type: CustomCommandParamType.Float },
            ],
        },
        (origin, targets, amountFloat) => {
            if (!isAdminOrCommandBlock(origin)) {
                return {
                    status: CustomCommandStatus.Failure,
                    message: `Only admins (tag: ${CONFIG.ADMIN_TAG}) or command blocks can use this.`,
                };
            }
            if (!targets || targets.length === 0) return { status: CustomCommandStatus.Failure, message: "No target selected." };

            const parsed = parseFloatToCents(amountFloat, false);
            if (!parsed.ok) return { status: CustomCommandStatus.Failure, message: parsed.error };
            if (parsed.cents <= 0) return { status: CustomCommandStatus.Failure, message: "Amount must be > 0." };

            system.run(() => {
                const { dollarsObj, centsObj } = ensureMoneyObjectives();
                if (!dollarsObj || !centsObj) return;

                for (const p of targets) {
                    const bal = getBalanceCents(dollarsObj, centsObj, p);
                    const next = bal - parsed.cents;
                    setBalanceFromTotalCents(dollarsObj, centsObj, p, next);

                    logMoneyEvent("REMOVE_MONEY", {
                        actor: origin,
                        target: p,
                        amountCents: parsed.cents,
                        balanceAfter: next,
                    });

                    p.sendMessage(
                        "§r<§dLily's Money§r> §r" + `§aRemoved §e${formatCents(parsed.cents)}§a. New balance: §e${formatCents(next)}§a.`,
                    );
                }

                const src = getCommandSource(origin);
                if (src instanceof Player)
                    reply(origin, `§aRemoved §e${formatCents(parsed.cents)}§a from §e${targets.length}§a player(s).`);
            });

            return { status: CustomCommandStatus.Success };
        },
    );
}
