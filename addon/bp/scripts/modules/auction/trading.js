import { recordHudChange, settleAuctionSeller } from "../hud/manager.js";
import { world } from "@minecraft/server";
import {
    getPlayerIdentityId,
    sameSeller,
    retainedListing,
    auctionTitle,
    countActivePlayerAuctions,
    AH_MAX_ACTIVE_PER_PLAYER,
    nextAuctionId,
} from "./listings.js";
import { loadAh, saveAh, AH_MAX_PRICE_CENTS } from "./storage.js";
import { getAhNowTicks, AH_ACTIVE_TICKS, AH_EXPIRED_COLLECT_TICKS } from "./clock.js";
import { msg, queueAhSoldMessage, deliverAhSoldMessagesForIdentity } from "./notifications.js";
import { getInventoryContainer } from "../inventory/items.js";
import { getCapacityForTemplate, addTemplateItems, stackMatchesTemplate, takeFromSlot } from "../inventory/templateInventory.js";
import { ensureMoneyObjectives, getBalanceCents } from "../economy/balance.js";
import { formatCents } from "../economy/formatting.js";
import { runTrade, changeTradeBalance } from "../economy/trade.js";
import { logMoneyEvent } from "../logging/moneylogging.js";
import { playMoneySound } from "../players/preferences.js";
import { isPotionItem, templateToStack, normalizeTemplate } from "../items/templates.js";
import { isShulkerBoxId } from "../items/identifiers.js";

// An offline seller can still be paid through their existing scoreboard identity.
function sellerTarget(auction, dollars, cents) {
    const matches = (participant) => String(participant.id) === auction.sellerIdentityId;
    return (
        dollars.getParticipants().find(matches) ??
        cents.getParticipants().find(matches) ??
        world.getAllPlayers().find((player) => getPlayerIdentityId(player) === auction.sellerIdentityId)?.scoreboardIdentity
    );
}

export function buyAuction(player, auctionId) {
    const ah = loadAh();
    const index = ah.auctions.findIndex((a) => a.id === String(auctionId));
    const a = index >= 0 ? ah.auctions[index] : null;

    if (!a || a.status !== "active" || getAhNowTicks() >= a.expiresAt) {
        msg(player, "§cThat auction is no longer active.");
        return "back";
    }

    if (sameSeller(player, a)) {
        msg(player, "§cYou cannot buy your own auction.");
        return "details";
    }

    const inv = getInventoryContainer(player);
    if (!inv) return msg(player, "§cNo inventory container.");
    if (retainedListing(a)) {
        msg(player, "§cThe saved listing lacks the data needed to restore this item. The listing has been kept.");
        return "details";
    }
    if (getCapacityForTemplate(inv, a.template) < a.amount) {
        msg(player, "§cYou do not have enough inventory space.");
        return "details";
    }

    const { dollarsObj, centsObj } = ensureMoneyObjectives();
    const bal = getBalanceCents(dollarsObj, centsObj, player);
    if (bal < a.price) {
        msg(player, `§cNot enough money. Need §e${formatCents(a.price)}§c but you have §e${formatCents(bal)}§c.`);
        return "details";
    }

    let buyerBalanceAfter, sellerBalanceAfter;
    const ok = runTrade((onRollback) => {
        const seller = sellerTarget(a, dollarsObj, centsObj);
        if (!seller) throw new Error("Seller scoreboard identity is unavailable.");
        buyerBalanceAfter = changeTradeBalance(dollarsObj, centsObj, player.scoreboardIdentity, -a.price, onRollback);
        sellerBalanceAfter = changeTradeBalance(dollarsObj, centsObj, seller, a.price, onRollback);
        addTemplateItems(inv, a.template, a.amount, onRollback);
        queueAhSoldMessage(ah, a, player.name);
        ah.auctions.splice(index, 1);
        if (!saveAh(ah)) throw new Error("Auction save failed.");
    });
    if (!ok) {
        msg(player, "§cPurchase failed. Check the Content Log for details.");
        return "details";
    }
    recordHudChange(player, buyerBalanceAfter + a.price, buyerBalanceAfter, `Auction: bought ${auctionTitle(a)}`);
    settleAuctionSeller(a.sellerIdentityId, sellerBalanceAfter - a.price, sellerBalanceAfter);
    logMoneyEvent("AH_BUY", {
        buyer: player,
        sellerIdentityId: a.sellerIdentityId,
        sellerName: a.sellerName,
        itemId: a?.template?.typeId ?? "",
        itemName: auctionTitle(a),
        quantity: a.amount,
        amountCents: a.price,
        buyerBalanceAfter,
    });

    msg(
        player,
        `§2Bought §e${a.amount}§2 x §f${auctionTitle(a)}§2 for §e${formatCents(a.price)}§2. Balance: §e${formatCents(buyerBalanceAfter)}§2.`,
    );
    playMoneySound(player);

    // Delivery is attempted now for online sellers. Offline sellers keep their queued notice until reconnecting.
    deliverAhSoldMessagesForIdentity(a.sellerIdentityId);

    return "back";
}

export function cancelAuction(player, auctionId) {
    const ah = loadAh();
    const index = ah.auctions.findIndex((a) => a.id === String(auctionId));
    const a = index >= 0 ? ah.auctions[index] : null;

    if (!a || a.status !== "active" || !sameSeller(player, a)) return "back";

    const inv = getInventoryContainer(player);
    if (!inv) return msg(player, "§cNo inventory container.");
    if (retainedListing(a)) {
        msg(player, "§cThe saved listing lacks the data needed to restore this item. The listing has been kept.");
        return "details";
    }
    if (getCapacityForTemplate(inv, a.template) < a.amount) {
        msg(player, "§cYou need inventory space before cancelling this auction.");
        return "details";
    }

    if (!returnListing(ah, index, inv)) {
        msg(player, "§cCould not return the listing. Check the Content Log for details.");
        return "details";
    }
    msg(player, "§aAuction cancelled and item returned.");
    return "mine";
}

export function claimExpiredAuction(player, auctionId) {
    const ah = loadAh();
    const index = ah.auctions.findIndex((a) => a.id === String(auctionId));
    const a = index >= 0 ? ah.auctions[index] : null;

    if (!a || a.status !== "expired" || !sameSeller(player, a)) return "back";

    const inv = getInventoryContainer(player);
    if (!inv) return msg(player, "§cNo inventory container.");
    if (retainedListing(a)) {
        msg(player, "§cThe saved listing lacks the data needed to restore this item. The listing has been kept.");
        return "details";
    }
    if (getCapacityForTemplate(inv, a.template) < a.amount) {
        msg(player, "§cYou need inventory space to claim this item.");
        return "details";
    }

    if (!returnListing(ah, index, inv)) {
        msg(player, "§cCould not return the listing. Check the Content Log for details.");
        return "details";
    }
    msg(player, "§aExpired auction item claimed.");
    return "mine";
}

export function listAuctionFromSlot(player, slotIndex, template, amount, priceCents) {
    if (
        !Number.isSafeInteger(amount) ||
        amount <= 0 ||
        amount > 255 ||
        !Number.isSafeInteger(priceCents) ||
        priceCents <= 0 ||
        priceCents > AH_MAX_PRICE_CENTS
    )
        return msg(player, "§cInvalid amount or price.");
    if (isPotionItem(template?.typeId) || isShulkerBoxId(template?.typeId))
        return msg(player, "§cThis item cannot be safely copied for auction.");
    if (!templateToStack(template, 1)) return msg(player, "§cThis item cannot be reconstructed with its saved properties.");
    const sellerId = getPlayerIdentityId(player);
    if (!sellerId) return msg(player, "§cYour scoreboard identity is not ready yet. Try again in a moment.");

    const inv = getInventoryContainer(player);
    if (!inv) return msg(player, "§cNo inventory container.");

    const ah = loadAh();

    if (countActivePlayerAuctions(ah, player) >= AH_MAX_ACTIVE_PER_PLAYER) {
        return msg(player, `§cYou already have ${AH_MAX_ACTIVE_PER_PLAYER} active auctions.`);
    }

    const current = inv.getItem(slotIndex);
    if (!current || !stackMatchesTemplate(current, template) || current.amount < amount) {
        msg(player, "§cThat item changed before listing. Try again.");
        return "browse";
    }

    const now = getAhNowTicks();

    const auction = {
        id: nextAuctionId(ah),
        sellerIdentityId: sellerId,
        sellerName: player.name,
        template: normalizeTemplate(template),
        amount,
        price: priceCents,
        createdAt: now,
        expiresAt: now + AH_ACTIVE_TICKS,
        collectUntil: now + AH_ACTIVE_TICKS + AH_EXPIRED_COLLECT_TICKS,
        status: "active",
    };

    ah.auctions.push(auction);

    const ok = runTrade((onRollback) => {
        takeFromSlot(inv, slotIndex, amount, onRollback);
        if (!saveAh(ah)) throw new Error("Listing save failed.");
    });
    if (!ok) {
        msg(player, "§cListing failed. Check the Content Log for details.");
        return "browse";
    }
    msg(player, `§aListed §e${amount}§a x §f${auctionTitle(auction)}§a for §e${formatCents(priceCents)}§a.`);
    return "mine";
}

function returnListing(ah, index, inv) {
    const [listing] = ah.auctions.splice(index, 1);
    return runTrade((onRollback) => {
        addTemplateItems(inv, listing.template, listing.amount, onRollback);
        if (!saveAh(ah)) throw new Error("Auction save failed.");
    });
}
