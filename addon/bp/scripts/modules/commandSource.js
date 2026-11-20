import { sendChat } from "./chat.js";
import { Player } from "@minecraft/server";
import { CONFIG } from "../config.js";

export function getCommandSource(origin) {
    return origin?.initiator ?? origin?.sourceEntity ?? null;
}

export function isCommandBlock(origin) {
    return !!origin?.sourceBlock;
}

export function isAdmin(player) {
    return player instanceof Player && player.hasTag(CONFIG.ADMIN_TAG);
}

export function isAdminOrCommandBlock(origin) {
    const src = getCommandSource(origin);
    return isCommandBlock(origin) || isAdmin(src);
}

export function reply(originOrPlayer, text) {
    const p = originOrPlayer instanceof Player ? originOrPlayer : getCommandSource(originOrPlayer);
    if (p instanceof Player) sendChat(p, text);
}
