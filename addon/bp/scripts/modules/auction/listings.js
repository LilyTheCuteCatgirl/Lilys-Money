import { CONFIG } from "../../config.js";
import { isPotionItem, normalizeTemplate } from "../items/templates.js";
import { isShulkerBoxId, stripColors, niceIdName, searchTokens } from "../items/identifiers.js";
import { loadAh, saveAh } from "./storage.js";
import { getAhNowTicks, AH_EXPIRED_COLLECT_TICKS, advanceAhClock, AH_CLOCK_INTERVAL_TICKS } from "./clock.js";
import { system } from "@minecraft/server";

export const AH_MAX_ACTIVE_PER_PLAYER = Math.max(1, Math.floor(Number(CONFIG.AH_MAX_ACTIVE_PER_PLAYER ?? 20)));
export const AH_MAX_EXPIRED_PER_PLAYER = Math.max(1, Math.floor(Number(CONFIG.AH_MAX_EXPIRED_PER_PLAYER ?? 20)));

export function nextAuctionId(ah) {
    const n = Math.max(1, Math.floor(Number(ah.nextId ?? 1)));
    ah.nextId = n + 1;
    return String(n);
}

export function getPlayerIdentityId(player) {
    try {
        return String(player?.scoreboardIdentity?.id ?? "");
    } catch {
        return "";
    }
}

export function sameSeller(player, auction) {
    const pid = getPlayerIdentityId(player);
    return pid && pid === String(auction?.sellerIdentityId ?? "");
}

export function getPlayerAuctions(ah, player) {
    const id = getPlayerIdentityId(player);
    if (!id) return [];
    return ah.auctions.filter((a) => String(a.sellerIdentityId) === id);
}

export function countActivePlayerAuctions(ah, player) {
    return getPlayerAuctions(ah, player).filter((a) => a.status === "active").length;
}

// Older potion and shulker box templates lack the data needed to return the original item. Keep those listings during cleanup.
export function retainedListing(a) {
    return isPotionItem(a.template?.typeId) || isShulkerBoxId(a.template?.typeId);
}

function enforceExpiredCapForSeller(ah, sellerIdentityId) {
    const expired = ah.auctions
        .filter((a) => !retainedListing(a) && a.status === "expired" && String(a.sellerIdentityId) === String(sellerIdentityId))
        .sort((a, b) => a.expiresAt - b.expiresAt);

    while (expired.length > AH_MAX_EXPIRED_PER_PLAYER) {
        const remove = expired.shift();
        const index = ah.auctions.findIndex((a) => a.id === remove.id);
        if (index !== -1) ah.auctions.splice(index, 1);
    }
}

export function processAhExpirations() {
    const ah = loadAh();
    const now = getAhNowTicks();
    let changed = false;
    const touchedSellers = new Set();

    for (const a of ah.auctions) {
        if (a.status === "active" && now >= a.expiresAt) {
            a.status = "expired";
            a.collectUntil = now + AH_EXPIRED_COLLECT_TICKS;
            touchedSellers.add(String(a.sellerIdentityId));
            changed = true;
        }
    }

    const beforeCount = ah.auctions.length;
    ah.auctions = ah.auctions.filter((a) => a.status !== "expired" || now < a.collectUntil || retainedListing(a));
    if (ah.auctions.length !== beforeCount) changed = true;

    for (const id of touchedSellers) enforceExpiredCapForSeller(ah, id);

    if (changed) saveAh(ah);
}

function buildSearchText(auction) {
    const t = normalizeTemplate(auction?.template);
    const id = String(t?.typeId ?? "").toLowerCase();
    const short = id.replace(/^minecraft:/, "");
    const spaced = short.replace(/[_:\-]+/g, " ");
    const name = stripColors(t?.nameTag || niceIdName(id)).toLowerCase();
    const seller = String(auction?.sellerName ?? "").toLowerCase();
    const lore = Array.isArray(t?.lore) ? stripColors(t.lore.join(" ")).toLowerCase() : "";

    return `${id} ${short} ${spaced} ${name} ${seller} ${lore}`;
}

export function searchAuctions(query) {
    const ah = loadAh();
    const tokens = searchTokens(query);
    const active = ah.auctions.filter((a) => a.status === "active");

    if (!tokens.length) {
        return active.sort((a, b) => b.createdAt - a.createdAt);
    }

    return active
        .filter((a) => {
            const text = buildSearchText(a);
            return tokens.every((token) => text.includes(token));
        })
        .sort((a, b) => a.price - b.price || b.createdAt - a.createdAt);
}

export function findAuctionById(id) {
    const ah = loadAh();
    return ah.auctions.find((a) => a.id === String(id)) ?? null;
}

system.runInterval(() => {
    try {
        advanceAhClock();
        processAhExpirations();
    } catch (error) {
        console.warn(`[AH] Clock or expiry update failed: ${error}`);
    }
}, AH_CLOCK_INTERVAL_TICKS);

export function auctionTitle(a) {
    const t = normalizeTemplate(a?.template);
    if (!t) return "Unknown Item";
    return t.nameTag || niceIdName(t.typeId);
}
