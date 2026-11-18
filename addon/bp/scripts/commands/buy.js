// BP/scripts/commands/buy.js
import { CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus, Player, system, world } from "@minecraft/server";
import { CONFIG } from "../config.js";
import {
    ensureMoneyObjectives,
    getBalanceCents,
    setBalanceFromTotalCents,
    parseFloatToCents,
    formatCents,
    isAdminOrCommandBlock,
    getCommandSource,
    reply,
    getInventoryContainer,
    canFitExact,
    addExactItems,
} from "../jsfunctions.js";

import { logMoneyEvent } from "../moneylogging.js";

/* -----------------------------
   Target resolving (String) - supports:
   - player name
   - @p, @r, @s
   Command blocks: @p picks nearest to the block.
----------------------------- */
function getRef(origin) {
    const src = getCommandSource(origin);
    if (src instanceof Player) {
        return { dimId: src.dimension.id, loc: src.location, self: src };
    }
    if (origin?.sourceBlock) {
        try {
            return {
                dimId: origin.sourceBlock.dimension.id,
                loc: origin.sourceBlock.location,
                self: null,
            };
        } catch {}
    }
    return { dimId: null, loc: null, self: null };
}

function nearestPlayer(ref) {
    const players = world.getAllPlayers();
    if (!ref.dimId || !ref.loc || players.length === 0) return players[0] ?? null;

    let best = null;
    let bestD2 = Infinity;

    for (const p of players) {
        if (p.dimension.id !== ref.dimId) continue;
        const l = p.location;
        const dx = l.x - ref.loc.x;
        const dy = l.y - ref.loc.y;
        const dz = l.z - ref.loc.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD2) {
            bestD2 = d2;
            best = p;
        }
    }
    return best ?? players[0] ?? null;
}

function randomPlayer() {
    const players = world.getAllPlayers();
    if (players.length === 0) return null;
    return players[Math.floor(Math.random() * players.length)];
}

function findByName(nameRaw) {
    const name = (nameRaw ?? "").trim().toLowerCase();
    if (!name) return null;
    for (const p of world.getAllPlayers()) {
        if (p.name.toLowerCase() === name) return p;
    }
    return null;
}

function resolveTarget(origin, raw) {
    const s = (raw ?? "").trim();
    if (!s) return null;

    const ref = getRef(origin);

    if (s.startsWith("@")) {
        const low = s.toLowerCase();
        if (low === "@p") return nearestPlayer(ref);
        if (low === "@r") return randomPlayer();
        if (low === "@s") return ref.self; // only works for player executor
        return null; // keep it simple
    }

    return findByName(s);
}

export function registerBuyCommand(customCommandRegistry) {
    customCommandRegistry.registerCommand(
        {
            name: `lilymoney:buy`,
            description:
                "Admin/CB: give item(s) and charge money (no debt). Price is per item. /buy <player|@p|@r|@s> <item> <amount> <priceEach>",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
            mandatoryParameters: [
                { name: "target", type: CustomCommandParamType.String }, // IMPORTANT: string to avoid selector permission issues
                { name: "item", type: CustomCommandParamType.ItemType },
                { name: "amount", type: CustomCommandParamType.Integer },
                { name: "priceEach", type: CustomCommandParamType.Float },
            ],
        },
        (origin, targetRaw, itemType, amountItems, priceFloat) => {
            if (!isAdminOrCommandBlock(origin)) {
                return {
                    status: CustomCommandStatus.Failure,
                    message: `Only admins (tag: ${CONFIG.ADMIN_TAG}) or command blocks can use this.`,
                };
            }

            if (!Number.isInteger(amountItems) || amountItems <= 0) {
                return { status: CustomCommandStatus.Failure, message: "Item amount must be a positive whole number." };
            }

            const parsed = parseFloatToCents(priceFloat, false);
            if (!parsed.ok) return { status: CustomCommandStatus.Failure, message: parsed.error };
            const unitPrice = parsed.cents;
            if (unitPrice <= 0) return { status: CustomCommandStatus.Failure, message: "Price must be > 0." };

            const target = resolveTarget(origin, targetRaw);
            if (!(target instanceof Player)) {
                return { status: CustomCommandStatus.Failure, message: "Target must be an online player (name, @p, @r, @s)." };
            }

            const itemId = itemType.id;

            // total cost = unit price * amount
            const totalCost = unitPrice * amountItems;
            // safety vs insane numbers
            if (!Number.isSafeInteger(totalCost)) {
                return { status: CustomCommandStatus.Failure, message: "Total price is too large." };
            }

            system.run(() => {
                const { dollarsObj, centsObj } = ensureMoneyObjectives();
                if (!dollarsObj || !centsObj) return;

                const inv = getInventoryContainer(target);
                if (!inv) {
                    target.sendMessage("§r<§d§lLilys Money§r> §r" + "§cNo inventory container.");
                    return;
                }

                const bal = getBalanceCents(dollarsObj, centsObj, target);

                // NO DEBT for buy
                if (bal < totalCost) {
                    target.sendMessage(
                        "§r<§d§lLilys Money§r> §r" +
                            `§cNot enough money. Balance: §e${formatCents(bal)}§c, needed: §e${formatCents(totalCost)}§c.`,
                    );
                    return;
                }

                if (!canFitExact(inv, itemId, amountItems)) {
                    target.sendMessage("§r<§d§lLilys Money§r> §r" + "§cNot enough inventory space for that purchase.");
                    return;
                }

                const ok = addExactItems(inv, itemId, amountItems);
                if (!ok) {
                    target.sendMessage("§r<§d§lLilys Money§r> §r" + "§cFailed to give items.");
                    return;
                }

                setBalanceFromTotalCents(dollarsObj, centsObj, target, bal - totalCost);

                logMoneyEvent("BUY_COMMAND", {
                    actor: origin,
                    target,
                    itemId,
                    quantity: amountItems,
                    amountCents: totalCost,
                    balanceAfter: bal - totalCost,
                });

                target.sendMessage(
                    "§r<§d§lLilys Money§r> §r" +
                        `§2Bought §e${amountItems}§2 x §f${itemId}§2 for §e${formatCents(totalCost)}§2. Balance: §e${formatCents(bal - totalCost)}§2.`,
                );

                // feedback to executor if player
                reply(origin, `§aGave §e${amountItems}§a x §f${itemId}§a to §f${target.name}§a for §e${formatCents(totalCost)}§a.`);
            });

            return { status: CustomCommandStatus.Success };
        },
    );
}
