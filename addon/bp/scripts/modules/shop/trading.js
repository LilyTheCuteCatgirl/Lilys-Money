import { serverOptions } from "../settings/server.js";
import { recordHudChange } from "../hud/manager.js";

import { normalizeItemId } from "../items/identifiers.js";
import { stackMatchesTemplate, takeFromSlot, addTemplateItems, getCapacityForTemplate } from "../inventory/templateInventory.js";
import { getTemplateForShopItem, shopMessage, shopItemTitle, getShopItemIcon } from "./catalog.js";
import { loadShop } from "./storage.js";
import { templateKey, isPotionItem } from "../items/templates.js";
import { ModalFormData, ActionFormData } from "@minecraft/server-ui";
import { formatCents } from "../economy/formatting.js";
import { getInventoryContainer } from "../inventory/items.js";
import { ensureMoneyObjectives, getBalanceCents } from "../economy/balance.js";
import { runTrade, changeTradeBalance } from "../economy/trade.js";
import { logMoneyEvent } from "../logging/moneylogging.js";
import { getDisplayOptions, playMoneySound } from "../players/preferences.js";

const SHOP_CONFIRM_UI = "§a§n§d§e§x§d§b§_§m§e§d§i§u§m§_§l§o§n§g§_§f§o§r§m§r";

export function shopConfirmTitle(text) {
    return `${SHOP_CONFIRM_UI}${text}`;
}

function stackMatchesShopItem(stack, it) {
    if (!stack) return false;

    const itemId = normalizeItemId(it?.id);
    if (!itemId) return false;

    if (!it?.template) {
        return stack.typeId === itemId;
    }

    return stackMatchesTemplate(stack, getTemplateForShopItem(it));
}

function countShopItems(container, it) {
    let count = 0;

    for (let i = 0; i < container.size; i++) {
        const s = container.getItem(i);
        if (stackMatchesShopItem(s, it)) count += s.amount;
    }

    return count;
}

function removeShopItems(container, it, amount, onRollback) {
    let remaining = amount;
    for (let i = 0; i < container.size && remaining; i++) {
        const stack = container.getItem(i);
        if (!stackMatchesShopItem(stack, it)) continue;
        const count = Math.min(stack.amount, remaining);
        takeFromSlot(container, i, count, onRollback);
        remaining -= count;
    }
    if (remaining) throw new Error("Not enough matching items.");
}

function offerAvailable(it, side) {
    const allowed = side === "buy" ? "allowBuy" : "allowSell";
    return loadShop().categories.some((category) =>
        category.items.some(
            (entry) =>
                entry.id === it.id &&
                entry[allowed] &&
                entry[side] === it[side] &&
                templateKey(entry.template) === templateKey(it.template),
        ),
    );
}

async function askQuantity(player, title, min, max, defaultAmount = 1) {
    const minN = Math.max(1, Math.floor(Number(min) || 1));
    const maxN = Math.floor(Number(max));

    if (!Number.isFinite(maxN) || maxN < minN) {
        shopMessage(player, "§cNo valid amount is available.");
        return null;
    }

    const defN = Math.max(minN, Math.min(maxN, Math.floor(Number(defaultAmount) || minN)));

    const form = new ModalFormData().title(title).textField(`Amount (${minN} - ${maxN})`, "number", {
        defaultValue: String(defN),
    });

    const res = await form.show(player);
    if (res.canceled) return null;

    const rawInput = String(res.formValues?.[0] ?? "").trim();
    const raw = rawInput.length ? rawInput : String(defN);

    if (!/^\d+$/.test(raw)) {
        shopMessage(player, `§cInvalid amount. Enter a whole number between ${minN}-${maxN}.`);
        return null;
    }

    const n = Number(raw);

    if (!Number.isSafeInteger(n) || n < minN || n > maxN) {
        shopMessage(player, `§cInvalid amount. Enter a whole number between ${minN}-${maxN}.`);
        return null;
    }

    return n;
}

function getMaxAffordableAmount(balanceCents, priceEachCents) {
    const bal = Math.floor(Number(balanceCents) || 0);
    const price = Math.floor(Number(priceEachCents) || 0);

    if (price <= 0) return 0;
    if (bal <= 0) return 0;

    return Math.floor(bal / price);
}

async function confirmShopBuy(player, it, qty, totalCost, balanceBefore) {
    const balanceAfter = balanceBefore - totalCost;

    const form = new ActionFormData()
        .title(shopConfirmTitle("§2§lConfirm Buy"))
        .body(
            `§f§lItem: §e${shopItemTitle(it)}\n` +
                `§f§lAmount: §e${qty}\n` +
                `§f§lPrice each: §e${formatCents(it.buy)}\n\n` +
                `§f§lTotal cost: §c${formatCents(totalCost)}\n` +
                `§f§lYour balance after: §a${formatCents(balanceAfter)}`,
        )
        .button("§c§lCancel", "textures/ui/cancel")
        .button("§2§lBuy", getShopItemIcon(it));

    const res = await form.show(player);
    return !res.canceled && res.selection === 1;
}

async function confirmShopSell(player, it, qty, totalPay, balanceBefore) {
    const balanceAfter = balanceBefore + totalPay;

    const form = new ActionFormData()
        .title(shopConfirmTitle("§b§lConfirm Sell"))
        .body(
            `§f§lItem: §e${shopItemTitle(it)}\n` +
                `§f§lAmount: §e${qty}\n` +
                `§f§lSell each: §e${formatCents(it.sell)}\n\n` +
                `§f§lTotal payout: §a${formatCents(totalPay)}\n` +
                `§f§lYour balance after: §a${formatCents(balanceAfter)}`,
        )
        .button("§c§lCancel", "textures/ui/cancel")
        .button("§b§lSell", getShopItemIcon(it));

    const res = await form.show(player);
    return !res.canceled && res.selection === 1;
}

export async function flowBuy(player, it) {
    if (!serverOptions().shop || !serverOptions().buy) return shopMessage(player, "Shop buy transactions are disabled.");
    if (isPotionItem(it.id)) return shopMessage(player, "§cPotion effects cannot be preserved in shop trades.");
    if (!it.allowBuy) return shopMessage(player, "§cBuying is disabled for this item.");
    if (it.buy <= 0) return shopMessage(player, "§cThis item has no buy price.");

    const template = getTemplateForShopItem(it);
    if (!template) return shopMessage(player, `§cInvalid item in shop config: §f${it.id}`);

    const inv = getInventoryContainer(player);
    if (!inv) return shopMessage(player, "§cNo inventory container.");

    const spaceLeft = getCapacityForShopItem(inv, it);
    if (spaceLeft <= 0) {
        return shopMessage(player, "§cNot enough inventory space.");
    }

    const { dollarsObj, centsObj } = ensureMoneyObjectives();
    const bal = getBalanceCents(dollarsObj, centsObj, player);

    const affordable = getMaxAffordableAmount(bal, it.buy);
    if (affordable <= 0) {
        return shopMessage(player, `§cNot enough money. You need at least §e${formatCents(it.buy)}§c.`);
    }

    const maxBuy = Math.min(serverOptions().maxItems, spaceLeft, affordable);

    const qty = await askQuantity(player, "Buy Amount", 1, maxBuy, 1);
    if (!qty) return;

    const totalCost = it.buy * qty;
    if (!Number.isSafeInteger(totalCost)) return shopMessage(player, "§cTotal cost is too large.");

    const confirmed = !getDisplayOptions(player).confirmBuy || (await confirmShopBuy(player, it, qty, totalCost, bal));
    if (!confirmed) return;
    if (!serverOptions().shop || !serverOptions().buy || qty > serverOptions().maxItems)
        return shopMessage(player, "Shop settings changed. Reopen the shop.");
    if (!offerAvailable(it, "buy")) return shopMessage(player, "§cThis offer has changed. Reopen the shop.");

    // Recheck the balance and available space after the player confirms the purchase.
    const invNow = getInventoryContainer(player);
    if (!invNow) return shopMessage(player, "§cNo inventory container.");

    const balNow = getBalanceCents(dollarsObj, centsObj, player);

    if (balNow < totalCost) {
        return shopMessage(player, `§cNot enough money. Need §e${formatCents(totalCost)}§c but you have §e${formatCents(balNow)}§c.`);
    }

    if (!canFitExactShopItem(invNow, it, qty)) {
        return shopMessage(player, "§cNot enough inventory space.");
    }

    let next;
    const ok = runTrade((onRollback) => {
        next = changeTradeBalance(dollarsObj, centsObj, player.scoreboardIdentity, -totalCost, onRollback);
        addTemplateItems(invNow, template, qty, onRollback);
    });
    if (!ok) return shopMessage(player, "§cPurchase failed. Check the Content Log for details.");
    recordHudChange(player, next + totalCost, next, `Shop: bought ${shopItemTitle(it)}`, undefined, qty);
    logMoneyEvent("SHOP_BUY", {
        player,
        itemId: it.id,
        itemName: shopItemTitle(it),
        quantity: qty,
        amountCents: totalCost,
        balanceAfter: next,
    });
    shopMessage(
        player,
        `§2Bought §e${qty}§2 x §f${shopItemTitle(it)}§2 for §e${formatCents(totalCost)}§2. Balance: §e${formatCents(next)}§2.`,
    );
    playMoneySound(player, "spend");
}

export async function flowSell(player, it) {
    if (!serverOptions().shop || !serverOptions().sell) return shopMessage(player, "Shop sell transactions are disabled.");
    if (isPotionItem(it.id)) return shopMessage(player, "§cPotion effects cannot be preserved in shop trades.");
    if (!it.allowSell) return shopMessage(player, "§cSelling is disabled for this item.");

    const template = getTemplateForShopItem(it);
    if (!template) return shopMessage(player, `§cInvalid item in shop config: §f${it.id}`);

    const inv = getInventoryContainer(player);
    if (!inv) return shopMessage(player, "§cNo inventory container.");

    const have = countShopItems(inv, it);
    if (have <= 0) return shopMessage(player, `§cYou have no §f${shopItemTitle(it)}§c to sell.`);

    const maxSell = Math.min(serverOptions().maxItems, have);

    const qty = await askQuantity(player, "Sell Amount", 1, maxSell, 1);
    if (!qty) return;

    const totalPay = it.sell * qty;
    if (!Number.isSafeInteger(totalPay)) return shopMessage(player, "§cTotal payout is too large.");

    const { dollarsObj, centsObj } = ensureMoneyObjectives();
    const bal = getBalanceCents(dollarsObj, centsObj, player);

    const confirmed = !getDisplayOptions(player).confirmSell || (await confirmShopSell(player, it, qty, totalPay, bal));
    if (!confirmed) return;
    if (!serverOptions().shop || !serverOptions().sell || qty > serverOptions().maxItems)
        return shopMessage(player, "Shop settings changed. Reopen the shop.");
    if (!offerAvailable(it, "sell")) return shopMessage(player, "§cThis offer has changed. Reopen the shop.");

    // The player may have moved or used the items while the sale form was open.
    const invNow = getInventoryContainer(player);
    if (!invNow) return shopMessage(player, "§cNo inventory container.");

    const haveNow = countShopItems(invNow, it);
    if (haveNow < qty) {
        return shopMessage(player, `§cYou do not have enough §f${shopItemTitle(it)}§c anymore.`);
    }

    let next;
    const ok = runTrade((onRollback) => {
        removeShopItems(invNow, it, qty, onRollback);
        next = changeTradeBalance(dollarsObj, centsObj, player.scoreboardIdentity, totalPay, onRollback);
    });
    if (!ok) return shopMessage(player, "§cSale failed. Check the Content Log for details.");
    recordHudChange(player, next - totalPay, next, `Shop: sold ${shopItemTitle(it)}`, undefined, qty);
    logMoneyEvent("SHOP_SELL", {
        player,
        itemId: it.id,
        itemName: shopItemTitle(it),
        quantity: qty,
        amountCents: totalPay,
        balanceAfter: next,
    });
    shopMessage(
        player,
        `§2Sold §e${qty}§2 x §f${shopItemTitle(it)}§2 for §e${formatCents(totalPay)}§2. Balance: §e${formatCents(next)}§2.`,
    );
    playMoneySound(player);
}

function getCapacityForShopItem(inv, it) {
    return getCapacityForTemplate(inv, getTemplateForShopItem(it));
}
function canFitExactShopItem(inv, it, qty) {
    return getCapacityForShopItem(inv, it) >= qty;
}
