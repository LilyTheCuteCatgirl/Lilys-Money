import { syncMoneyHud } from "../hud/manager.js";
import { world, DisplaySlotId } from "@minecraft/server";
import { CONFIG } from "../../config.js";

export function clearLegacyMoneyDisplaySlots() {
    for (const slot of [DisplaySlotId.Sidebar, DisplaySlotId.BelowName]) {
        const display = world.scoreboard.getObjectiveAtDisplaySlot(slot);
        if (display?.objective.id === CONFIG.MONEY_DISPLAY_OBJECTIVE) world.scoreboard.clearObjectiveAtDisplaySlot(slot);
    }
}

export function tickMoneyDisplay() {
    for (const player of world.getAllPlayers()) syncMoneyHud(player);
}
