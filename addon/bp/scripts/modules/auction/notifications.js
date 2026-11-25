import { sendChat } from "../chat.js";
import { notifyHudReceipt } from "../hud/manager.js";
import { CONFIG } from "../../config.js";
import { world, system, Player } from "@minecraft/server";
import { getPlayerIdentityId, auctionTitle } from "./listings.js";
import { formatCents } from "../economy/formatting.js";
import { getAhNowTicks } from "./clock.js";
import { loadAh, saveAh } from "./storage.js";
import { playMoneySound } from "../players/preferences.js";

const AH_MAX_PENDING_SOLD_MESSAGES_PER_PLAYER = Math.max(1, Math.floor(Number(CONFIG.AH_MAX_PENDING_SOLD_MESSAGES_PER_PLAYER ?? 20)));

world.afterEvents.playerSpawn.subscribe((ev) => {
    if (!ev.initialSpawn) return;

    system.runTimeout(() => {
        try {
            deliverAhSoldMessagesForPlayer(ev.player);
        } catch {}
    }, 60);
});

function nextSoldMessageId(ah) {
    const n = Math.max(1, Math.floor(Number(ah.nextSoldMessageId ?? 1)));
    ah.nextSoldMessageId = n + 1;
    return String(n);
}

function getOnlinePlayerByIdentityId(identityId) {
    const id = String(identityId ?? "");
    if (!id) return null;

    for (const p of world.getAllPlayers()) {
        if (getPlayerIdentityId(p) === id) return p;
    }

    return null;
}

function formatAhSoldMessage(m) {
    return `§f${m.buyerName}§2 bought your §e${m.amount}§2 x ` + `§f${m.itemName}§2 at the Auction House for §e${formatCents(m.price)}§2.`;
}

function enforceSoldMessageCapForSeller(ah, sellerIdentityId) {
    const id = String(sellerIdentityId ?? "");
    if (!id) return;

    const mine = ah.soldMessages.filter((m) => String(m.sellerIdentityId) === id).sort((a, b) => a.createdAt - b.createdAt);

    const removeCount = mine.length - AH_MAX_PENDING_SOLD_MESSAGES_PER_PLAYER;
    if (removeCount <= 0) return;

    const removeIds = new Set(mine.slice(0, removeCount).map((m) => String(m.id)));

    ah.soldMessages = ah.soldMessages.filter((m) => !removeIds.has(String(m.id)));
}

export function queueAhSoldMessage(ah, auction, buyerName) {
    if (!ah || !auction) return;

    if (!Array.isArray(ah.soldMessages)) ah.soldMessages = [];

    ah.soldMessages.push({
        id: nextSoldMessageId(ah),
        sellerIdentityId: String(auction.sellerIdentityId),
        buyerName: String(buyerName ?? "Someone"),
        itemName: auctionTitle(auction),
        amount: Math.max(1, Math.floor(Number(auction.amount ?? 1))),
        price: Math.max(0, Math.floor(Number(auction.price ?? 0))),
        createdAt: getAhNowTicks(),
    });

    enforceSoldMessageCapForSeller(ah, auction.sellerIdentityId);
}

export function deliverAhSoldMessagesForIdentity(identityId, seller = getOnlinePlayerByIdentityId(identityId)) {
    if (!(seller instanceof Player)) return false;

    const ah = loadAh();
    const id = String(identityId ?? "");

    const all = Array.isArray(ah.soldMessages) ? ah.soldMessages : [];
    const mine = all.filter((m) => String(m.sellerIdentityId) === id);

    if (!mine.length) return false;

    ah.soldMessages = all.filter((m) => String(m.sellerIdentityId) !== id);

    if (!saveAh(ah)) return false;

    if (mine.length === 1) {
        msg(seller, formatAhSoldMessage(mine[0]));
    } else {
        msg(seller, `§2You had §e${mine.length}§2 auction sales while you were away:`);
        for (const m of mine) {
            msg(seller, formatAhSoldMessage(m));
        }
    }

    for (const sale of mine) notifyHudReceipt(seller, sale.price, `Auction: sold ${sale.itemName}`);
    playMoneySound(seller, "auction");
    return true;
}

function deliverAhSoldMessagesForPlayer(player) {
    if (!(player instanceof Player)) return false;

    const id = getPlayerIdentityId(player);
    if (!id) return false;

    return deliverAhSoldMessagesForIdentity(id, player);
}

export function msg(player, text) {
    try {
        sendChat(player, text);
    } catch {}
}
