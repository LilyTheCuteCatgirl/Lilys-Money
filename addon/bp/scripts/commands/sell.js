import { sendChat, chatText } from "../modules/chat.js";
import { niceIdName } from "../modules/items/identifiers.js";
import { notifyHudReceipt } from "../modules/hud/manager.js";
import { CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus, Player, system, world } from "@minecraft/server";
import { CONFIG } from "../config.js";
import { ensureMoneyObjectives, getBalanceCents, setBalanceFromTotalCents } from "../modules/economy/balance.js";
import { parseFloatToCents, formatCents } from "../modules/economy/formatting.js";
import { isAdminOrCommandBlock, getCommandSource, reply } from "../modules/commandSource.js";
import { getInventoryContainer, countItems, removeItems } from "../modules/inventory/items.js";
import { logMoneyEvent } from "../modules/logging/moneylogging.js";

function getRef(origin) {
    const src = getCommandSource(origin);
    if (src instanceof Player) return { dimId: src.dimension.id, loc: src.location, self: src };
    if (origin?.sourceBlock) {
        try {
            return { dimId: origin.sourceBlock.dimension.id, loc: origin.sourceBlock.location, self: null };
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
        if (low === "@s") return ref.self;

        return null;
    }

    return findByName(s);
}

export function registerSellCommand(customCommandRegistry) {
    customCommandRegistry.registerCommand(
        {
            name: "lilymoney:sell",
            description: "Admin/CB: take item(s) and pay money. Price is per item. /sell <player|@p|@r|@s> <item> <amount> <priceEach>",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
            mandatoryParameters: [
                { name: "target", type: CustomCommandParamType.String }, // Resolve targets from text to avoid selector permission checks.
                { name: "item", type: CustomCommandParamType.ItemType },
                { name: "amount", type: CustomCommandParamType.Integer },
                { name: "priceEach", type: CustomCommandParamType.Float },
            ],
        },
        (origin, targetRaw, itemType, amountItems, priceFloat) => {
            if (!isAdminOrCommandBlock(origin)) {
                return {
                    status: CustomCommandStatus.Failure,
                    message: chatText(`Only admins (tag: ${CONFIG.ADMIN_TAG}) or command blocks can use this.`),
                };
            }

            if (!Number.isInteger(amountItems) || amountItems <= 0) {
                return { status: CustomCommandStatus.Failure, message: chatText("Item amount must be a positive whole number.") };
            }

            const parsed = parseFloatToCents(priceFloat, false);
            if (!parsed.ok) return { status: CustomCommandStatus.Failure, message: chatText(parsed.error) };

            const unitPrice = parsed.cents;
            if (unitPrice < 0) return { status: CustomCommandStatus.Failure, message: chatText("Price must not be negative.") };

            const target = resolveTarget(origin, targetRaw);
            if (!(target instanceof Player)) {
                return { status: CustomCommandStatus.Failure, message: chatText("Target must be an online player (name, @p, @r, @s).") };
            }

            const itemId = itemType.id;
            const totalPay = unitPrice * amountItems;
            if (!Number.isSafeInteger(totalPay)) {
                return { status: CustomCommandStatus.Failure, message: chatText("Total price is too large.") };
            }

            system.run(() => {
                const { dollarsObj, centsObj } = ensureMoneyObjectives();
                if (!dollarsObj || !centsObj) return;

                const inv = getInventoryContainer(target);
                if (!inv) {
                    sendChat(target, "§cNo inventory container.");

                    return;
                }

                const have = countItems(inv, itemId);
                if (have < amountItems) {
                    sendChat(target, `§cNot enough §f${itemId}§c. You have §e${have}§c/${amountItems}.`);

                    return;
                }

                const removed = removeItems(inv, itemId, amountItems);
                if (removed < amountItems) {
                    sendChat(target, "§cError removing items.");

                    return;
                }

                const bal = getBalanceCents(dollarsObj, centsObj, target);
                const next = bal + totalPay;
                const delta = setBalanceFromTotalCents(dollarsObj, centsObj, target, next);
                // The legacy removal helper may count a slot even if clearing it failed.
                try {
                    if (countItems(inv, itemId) === have - amountItems) notifyHudReceipt(target, delta, `Sold ${niceIdName(itemId)}`);
                } catch {}

                logMoneyEvent("SELL_COMMAND", {
                    actor: origin,
                    target,
                    itemId,
                    quantity: amountItems,
                    amountCents: totalPay,
                    balanceAfter: next,
                });

                sendChat(
                    target,
                    `§2Sold §e${amountItems}§2 x §f${itemId}§2 for §e${formatCents(totalPay)}§2. Balance: §e${formatCents(next)}§2.`,
                );
                reply(origin, `§aTook §e${amountItems}§a x §f${itemId}§a from §f${target.name}§a and paid §e${formatCents(totalPay)}§a.`);
            });

            return { status: CustomCommandStatus.Success };
        },
    );
}
