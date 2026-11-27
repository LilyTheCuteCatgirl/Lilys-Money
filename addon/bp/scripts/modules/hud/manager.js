import { serverOptions } from "../settings/server.js";
import { system, world } from "@minecraft/server";
import { CONFIG } from "../../config.js";
import { getDisplayOptions, getHudPosition, HUD_POSITIONS, hasCompactMoney, hasMoneyHud } from "../players/preferences.js";
import { enqueueCard, observeBalance, newHudSession, updateHud } from "./session.js";

const sessions = new Map();
let interval;

function readBalance(player) {
    const identity = player.scoreboardIdentity;
    const dollars = world.scoreboard.getObjective(CONFIG.MONEY_DOLLAR_OBJECTIVE);
    const cents = world.scoreboard.getObjective(CONFIG.MONEY_CENT_OBJECTIVE);
    if (!identity || !dollars || !cents) return undefined;

    return (dollars.getScore(identity) ?? 0) * 100 + (cents.getScore(identity) ?? 0);
}

function pulse() {
    const tick = system.currentTick;

    for (const session of sessions.values()) {
        try {
            if (tick >= session.nextPoll || session.state.observed === undefined) {
                session.nextPoll = tick + serverOptions().poll;
                observeBalance(session.state, readBalance(session.player), tick);
            }
            if (tick < session.state.nextFrame && tick < session.state.refreshAt && session.compact === session.state.compact) continue;
            updateHud(
                session.state,
                tick,
                (title) => {
                    session.player.onScreenDisplay.setTitle(title, { fadeInDuration: 0, stayDuration: 1200, fadeOutDuration: 0 });
                },
                session.compact,
            );
            session.warned = false;
        } catch (error) {
            if (!session.warned) console.warn(`[Money HUD] ${error}`);
            session.warned = true;
        }
    }
}

function forget(id) {
    sessions.delete(id);
    if (!sessions.size && interval !== undefined) {
        system.clearRun(interval);
        interval = undefined;
    }
}

export function syncMoneyHud(player) {
    const active = sessions.has(player.id);
    const wallet = hasMoneyHud(player);
    const options = getDisplayOptions(player);
    if (wallet || options.notifications) {
        if (!active) {
            sessions.set(player.id, { player, state: newHudSession(), nextPoll: system.currentTick + serverOptions().poll });
            try {
                observeBalance(sessions.get(player.id).state, readBalance(player), system.currentTick);
            } catch {
                // The next poll retries initialization.
            }
            if (interval === undefined) interval = system.runInterval(pulse, 1);
        }

        const session = sessions.get(player.id);
        if (session.state.wallet !== wallet || JSON.stringify(session.state.options) !== JSON.stringify(options)) {
            const old = session.state.options;
            if (
                old &&
                ["notifications", "job", "shop", "auction", "payment", "admin", "other", "spending"].some(
                    (key) => old[key] !== options[key],
                )
            ) {
                // Account for external scoreboard changes under the filters that were active when they occurred.
                observeBalance(session.state, readBalance(player), system.currentTick);
                const visible = (row) =>
                    options.notifications && options[row.group] !== false && (row.cents > 0 || options.spending) && !!row.group;
                session.state.rows = session.state.rows.filter(visible);
                session.state.waiting = session.state.waiting.filter(visible);
            }
            session.state.wallet = wallet;
            session.state.options = options;
            session.state.nextFrame = 0;
        }
        session.compact = hasCompactMoney(player);
        const route = "BCDE"[HUD_POSITIONS.indexOf(getHudPosition(player))];
        if (session.state.route !== route) {
            session.state.route = route;
            session.state.nextFrame = 0;
        }

        return true;
    }
    if (active) {
        player.onScreenDisplay.setTitle("~LM3:R", { fadeInDuration: 0, stayDuration: 2, fadeOutDuration: 0 });
        forget(player.id);
    }

    return false;
}

// Reconcile external changes first, then advance to the committed balance before the next poll.
export function recordHudChange(player, before, after, description, key, itemQuantity) {
    const session = sessions.get(player.id);
    if (!session) return;

    const state = session.state;
    if (before !== undefined) observeBalance(state, before, system.currentTick);
    if (after === undefined) {
        state.observed = undefined;

        return;
    }
    observeBalance(state, after, system.currentTick, before === undefined ? null : (description ?? null), key, itemQuantity);
}

// Pending auction receipts and two-party payments already settled their wallet balances.
export function notifyHudReceipt(player, delta, description) {
    const session = sessions.get(player.id);
    if (session && Number.isSafeInteger(delta) && delta !== 0) enqueueCard(session.state, delta, description, system.currentTick);
}

export function settleAuctionSeller(identityId, before, after) {
    for (const { player } of sessions.values()) {
        try {
            if (String(player.scoreboardIdentity?.id) === identityId) recordHudChange(player, before, after);
        } catch {}
    }
}

world.afterEvents.playerSpawn.subscribe(({ player }) => {
    const session = sessions.get(player.id);
    if (session) {
        session.player = player;
        session.state = newHudSession();
    }
    syncMoneyHud(player);
});
world.afterEvents.playerLeave.subscribe(({ playerId }) => forget(playerId));
