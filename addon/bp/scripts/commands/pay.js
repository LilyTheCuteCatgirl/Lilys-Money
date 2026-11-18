// BP/scripts/commands/pay.js
import { CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus, Player, system, world } from "@minecraft/server";
import {
    ensureMoneyObjectives,
    getBalanceCents,
    setBalanceFromTotalCents,
    parseFloatToCents,
    formatCents,
    getCommandSource,
    isCommandBlock,
    reply,
} from "../jsfunctions.js";

import { playMoneySound } from "../jsfunctions.js";

import { logMoneyEvent } from "../moneylogging.js";

function findByName(nameRaw) {
    const name = (nameRaw ?? "").trim();
    if (!name) return null;

    const lower = name.toLowerCase();
    for (const p of world.getAllPlayers()) {
        if (p.name.toLowerCase() === lower) return p;
    }
    return null;
}

function nearestPlayer(source) {
    const players = world.getAllPlayers();
    if (players.length === 0) return null;

    const dimId = source.dimension?.id;
    const sLoc = source.location;
    if (!dimId || !sLoc) return players[0] ?? null;

    let best = null;
    let bestDist = Infinity;

    for (const p of players) {
        if (p.dimension?.id !== dimId) continue;
        const l = p.location;
        const dx = l.x - sLoc.x;
        const dy = l.y - sLoc.y;
        const dz = l.z - sLoc.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestDist) {
            bestDist = d2;
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

function resolvePayTarget(source, raw) {
    const s = (raw ?? "").trim();
    if (!s) return { ok: false, error: "No target provided." };

    if (s.startsWith("@")) {
        const lower = s.toLowerCase();
        if (lower === "@s") return { ok: true, player: source };
        if (lower === "@p") return { ok: true, player: nearestPlayer(source) };
        if (lower === "@r") return { ok: true, player: randomPlayer() };

        const m = lower.match(/^@a(?:\[(.*)\])?$/);
        if (m) {
            const inside = m[1] ?? "";
            if (!inside) return { ok: false, error: "Selector @a is not allowed for /pay. Use a single player." };

            const cMatch = inside.match(/(?:^|,)\s*c\s*=\s*(\d+)\s*(?:,|$)/i);
            const lMatch = inside.match(/(?:^|,)\s*limit\s*=\s*(\d+)\s*(?:,|$)/i);
            const count = cMatch ? parseInt(cMatch[1], 10) : lMatch ? parseInt(lMatch[1], 10) : NaN;

            if (count !== 1) return { ok: false, error: "Only @a[c=1] or @a[limit=1] is allowed for /pay." };
            return { ok: true, player: nearestPlayer(source) };
        }

        return { ok: false, error: "Unsupported selector. Use a name, @s, @p, @r, or @a[c=1]." };
    }

    const byName = findByName(s);
    if (!byName) return { ok: false, error: `Player not found: ${s}` };
    return { ok: true, player: byName };
}

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
                    "§r<§d§lLilys Money§r> §r" +
                        `§aYou received §e${formatCents(amount)}§a from §f${source.name}§a. New balance: §e${formatCents(targetBal + amount)}§a.`,
                );
            });

            return { status: CustomCommandStatus.Success };
        },
    );
}
