import { syncMoneyHud } from "../hud/manager.js";
import { world, DisplaySlotId } from "@minecraft/server";
import { CONFIG } from "../../config.js";
import { serverOptions } from "../settings/server.js";

export function clearLegacyMoneyDisplaySlots() {
    const slot = DisplaySlotId.BelowName;
    if (world.scoreboard.getObjectiveAtDisplaySlot(slot)?.objective.id === CONFIG.MONEY_DISPLAY_OBJECTIVE)
        world.scoreboard.clearObjectiveAtDisplaySlot(slot);
    syncMoneySidebar();
}

export function syncMoneySidebar(players) {
    const board = world.scoreboard;
    const slot = DisplaySlotId.Sidebar;
    const displayed = board.getObjectiveAtDisplaySlot(slot)?.objective;
    const id = CONFIG.MONEY_DISPLAY_OBJECTIVE;

    if (!serverOptions().sidebar) {
        if (displayed?.id === id) board.clearObjectiveAtDisplaySlot(slot);

        return;
    }

    if (displayed && displayed.id !== id) return;

    const dollars = board.getObjective(CONFIG.MONEY_DOLLAR_OBJECTIVE);
    const cents = board.getObjective(CONFIG.MONEY_CENT_OBJECTIVE);

    if (!dollars || !cents) return;

    const objective = displayed ?? board.getObjective(id) ?? board.addObjective(id, CONFIG.MONEY_DISPLAY_OBJECTIVE_NAME);
    const online = new Set();

    for (const player of players ?? world.getAllPlayers()) {
        const identity = player.scoreboardIdentity;

        if (!identity) continue;
        online.add(identity.id);
        const whole = Math.trunc(((dollars.getScore(identity) ?? 0) * 100 + (cents.getScore(identity) ?? 0)) / 100);

        if (objective.getScore(identity) !== whole) objective.setScore(identity, whole);
    }

    for (const identity of objective.getParticipants()) {
        if (!online.has(identity.id)) objective.removeParticipant(identity);
    }
    if (!displayed) board.setObjectiveAtDisplaySlot(slot, { objective });
}

export function tickMoneyDisplay() {
    const players = world.getAllPlayers();

    for (const player of players) syncMoneyHud(player);
    syncMoneySidebar(players);
}
