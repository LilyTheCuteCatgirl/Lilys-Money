import { CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus, Player, system } from "@minecraft/server";
import { CONFIG } from "../config.js";
import { ensureMoneyObjectives, setBalanceFromTotalCents } from "../modules/economy/balance.js";
import { parseFloatToCents, formatCents } from "../modules/economy/formatting.js";
import { isAdminOrCommandBlock, getCommandSource, reply } from "../modules/commandSource.js";

import { logMoneyEvent } from "../modules/logging/moneylogging.js";
import { playMoneySound } from "../modules/players/preferences.js";

export function registerSetMoneyCommand(customCommandRegistry) {
    customCommandRegistry.registerCommand(
        {
            name: `lilymoney:setmoney`,
            description: "Admin/CB: set money (can be negative) /setmoney <selector> <amount>",
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

            const parsed = parseFloatToCents(amountFloat, true);
            if (!parsed.ok) return { status: CustomCommandStatus.Failure, message: parsed.error };

            system.run(() => {
                const { dollarsObj, centsObj } = ensureMoneyObjectives();
                if (!dollarsObj || !centsObj) return;

                for (const p of targets) {
                    setBalanceFromTotalCents(dollarsObj, centsObj, p, parsed.cents, "Balance set");

                    logMoneyEvent("SET_MONEY", {
                        actor: origin,
                        target: p,
                        amountCents: parsed.cents,
                        balanceAfter: parsed.cents,
                    });

                    p.sendMessage("§r<§dLily's Money§r> §r" + `§aYour balance was set to §e${formatCents(parsed.cents)}§a.`);
                    playMoneySound(p);
                }

                const src = getCommandSource(origin);
                if (src instanceof Player)
                    reply(origin, `§aSet money for §e${targets.length}§a player(s) to §e${formatCents(parsed.cents)}§a.`);
                playMoneySound(src);
            });

            return { status: CustomCommandStatus.Success };
        },
    );
}
