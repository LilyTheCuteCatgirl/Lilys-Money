import { system, world } from "@minecraft/server";
import { CONFIG } from "../../config.js";
import { getHudPosition, HUD_POSITIONS, hasCompactMoney, hasMoneyHud } from "../players/preferences.js";
import { observeBalance, newHudSession, updateHud } from "./session.js";

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
                session.nextPoll = tick + 20;
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
    if (hasMoneyHud(player)) {
        if (!active) {
            sessions.set(player.id, { player, state: newHudSession(), nextPoll: system.currentTick + 20 });
            sampleHudBalance(player);
            if (interval === undefined) interval = system.runInterval(pulse, 1);
        }
        const session = sessions.get(player.id);
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

export function observePreRewardBalance(player, balance) {
    const session = sessions.get(player.id);
    if (session) observeBalance(session.state, balance, system.currentTick);
}

export function sampleHudBalance(player, description, key) {
    try {
        const session = sessions.get(player.id);
        if (!session) return;
        // A chat receipt covers this change even if its scoreboard read has to wait.
        if (description === null) session.state.observed = undefined;
        observeBalance(session.state, readBalance(player), system.currentTick, description, key);
    } catch {
        // The next HUD tick retries a score that was unavailable during settlement.
    }
}

export function sampleAuctionSeller(identityId) {
    for (const { player } of sessions.values()) {
        try {
            if (String(player.scoreboardIdentity?.id) === identityId) sampleHudBalance(player, null);
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
