import { getDisplayOptions } from "../players/preferences.js";
import { serverOptions } from "../settings/server.js";
import { CONFIG } from "../../config.js";
import { parseFloatToCents, formatCents } from "../economy/formatting.js";
import { AH_MAX_PRICE_CENTS, loadAh } from "./storage.js";
import { getAhNowTicks, TICKS_PER_DAY } from "./clock.js";
import { getItemIconFromAuction, getStackIcon } from "../ui/itemIcons.js";
import {
    auctionTitle,
    sameSeller,
    processAhExpirations,
    searchAuctions,
    findAuctionById,
    getPlayerAuctions,
    AH_MAX_EXPIRED_PER_PLAYER,
} from "./listings.js";
import { normalizeTemplate, stackToTemplate, isPotionItem } from "../items/templates.js";
import { niceIdName, romanLevel, shortItemName, isShulkerBoxId } from "../items/identifiers.js";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { msg } from "./notifications.js";
import { claimExpiredAuction, buyAuction, cancelAuction, listAuctionFromSlot } from "./trading.js";
import { getInventoryContainer } from "../inventory/items.js";

const AH_PAGE_SIZE = Math.max(1, Math.floor(Number(CONFIG.AH_PAGE_SIZE ?? 20)));

const AH_FULLSCREEN_UI = "§a§n§d§e§x§d§b§_§f§u§l§l§s§c§r§e§e§n§_§l§o§n§g§_§f§o§r§m§r";

function ahTitle(text) {
    return `${AH_FULLSCREEN_UI}${text}`;
}

function parseUiMoneyToCents(text, allowNegative = false) {
    const s = String(text ?? "").trim();
    if (!s) return { ok: false, error: "Price cannot be empty." };

    const num = Number(s.replace(",", "."));
    if (!Number.isFinite(num)) return { ok: false, error: "Invalid number." };

    const parsed = parseFloatToCents(num, allowNegative);
    if (!parsed.ok) return parsed;
    if (parsed.cents <= 0) return { ok: false, error: "Price must be above $0.00." };
    if (parsed.cents > AH_MAX_PRICE_CENTS) return { ok: false, error: "Price is too large." };

    return parsed;
}

function getSelectedSlotIndex(player) {
    try {
        const v = player.selectedSlotIndex;
        if (Number.isInteger(v) && v >= 0) return v;
    } catch {}
    return 0;
}

function daysLeftText(tickValue) {
    const left = Math.max(0, Math.floor(Number(tickValue ?? 0) - getAhNowTicks()));
    if (left <= 0) return "expired";

    const days = Math.ceil(left / TICKS_PER_DAY);
    return `${days}d`;
}

function getAuctionIcon(auctionOrTemplate) {
    return getItemIconFromAuction(auctionOrTemplate);
}

function enchantmentSummary(a) {
    const enchants = a.template?.enchantments;
    if (!enchants?.length) return "";
    const first = enchants[0];
    const remaining = enchants.length > 1 ? ` +${enchants.length - 1} more` : "";
    return ` §r§5${niceIdName(first.id)} ${romanLevel(first.level)}${remaining}`;
}

function auctionButtonText(a, includeSeller = true) {
    const seller = includeSeller ? ` §8| §b${a.sellerName}` : "";

    return `§8§l${auctionTitle(a)} x${a.amount}${enchantmentSummary(a)}\n` + `§r§d${formatCents(a.price)}${seller}`;
}

function buildAuctionDetailsBody(a, t, title, own) {
    const lines = [];

    lines.push(`§8Item: §f${title} §lx${a.amount}`);
    lines.push(`§8Price: §e${formatCents(a.price)} §l(total)`);
    lines.push(`§8Seller: §f${a.sellerName}`);
    lines.push(`§8Status: ${a.status === "expired" ? "§cExpired" : "§2§lActive"}`);

    if (a.status === "active") lines.push(`§8Expires in: §f${daysLeftText(a.expiresAt)}`);
    if (a.status === "expired") lines.push(`§8Claim/delete in: §f${daysLeftText(a.collectUntil)}`);

    if (own) lines.push("", "§2§lThis is your auction.");

    if (!t) return lines.join("\n");

    lines.push("", `§8Type: §f${niceIdName(t.typeId)}`);
    lines.push(`§8ID: §l${t.typeId}`);

    if (Array.isArray(t.enchantments) && t.enchantments.length > 0) {
        lines.push("", "§8Enchantments:");
        for (const e of t.enchantments.slice(0, 12)) {
            lines.push(`§l- §b${niceIdName(e.id)} ${romanLevel(e.level)}`);
        }
        if (t.enchantments.length > 12) lines.push(`§l- §8and ${t.enchantments.length - 12} more...`);
    }

    if (Array.isArray(t.lore) && t.lore.length > 0) {
        lines.push("", "§8Lore:");
        for (const line of t.lore.slice(0, 8)) lines.push(`§l- §r${line}`);
        if (t.lore.length > 8) lines.push(`§l- §8and ${t.lore.length - 8} more...`);
    }

    if (Number.isInteger(t.durabilityDamage) && t.durabilityDamage > 0) {
        lines.push("", `§8Durability damage: §e${t.durabilityDamage}`);
    }

    const dynCount = Object.keys(t.dynamicProperties ?? {}).length;
    if (dynCount > 0) {
        lines.push("", `§8Custom data: §e${dynCount} properties`);
    }

    return lines.join("\n");
}

function describeStack(stack) {
    if (!stack) return "§lEmpty";

    const template = stackToTemplate(stack);
    const name = template?.nameTag ? `${template.nameTag} §l(${shortItemName(template.typeId)})` : niceIdName(stack.typeId);

    const bits = [];
    if (Array.isArray(template?.enchantments) && template.enchantments.length > 0) bits.push(`§d${template.enchantments.length} ench`);
    if (Array.isArray(template?.lore) && template.lore.length > 0) bits.push(`§b${template.lore.length} lore`);

    const extra = bits.length ? ` §l| ${bits.join(" §l| ")}` : "";
    return `§f${name} §lx${stack.amount}${extra}`;
}

export async function openAhEntry(player, rawArg = "") {
    if (!serverOptions().auctions) return openMyAhItems(player);
    processAhExpirations();

    const arg = String(rawArg ?? "").trim();
    if (!arg) return openAhBrowse(player, "", 0);

    const parts = arg.split(/\s+/).filter(Boolean);
    if (parts[0]?.toLowerCase() === "sell") {
        const priceRaw = parts.length >= 2 ? parts.slice(1).join(" ") : "";
        return openAhSellEntry(player, priceRaw);
    }

    return openAhBrowse(player, arg, 0);
}

async function openAhBrowse(player, query = "", page = 0) {
    const matches = searchAuctions(query);
    const totalPages = Math.max(1, Math.ceil(matches.length / AH_PAGE_SIZE));
    page = Math.max(0, Math.min(totalPages - 1, Math.floor(Number(page) || 0)));

    const start = page * AH_PAGE_SIZE;
    const shown = matches.slice(start, start + AH_PAGE_SIZE);

    const title = query ? `AH Search: ${query}` : "Auction House";
    const body = query
        ? `§l${matches.length} matches. Cheapest first. Page ${page + 1}/${totalPages}`
        : `§lNewest auctions. Page ${page + 1}/${totalPages}`;

    const form = new ActionFormData().title(ahTitle(title)).body(body);
    const actions = [];

    if (!query) {
        form.button("§d§lMy Items", "textures/blocks/chest_front");
        actions.push({ type: "my" });
    }

    for (const a of shown) {
        form.button(auctionButtonText(a), getAuctionIcon(a));
        actions.push({ type: "view", id: a.id, query, page });
    }

    if (page > 0) {
        form.button("§8§lPrevious Page", "textures/ui/arrow_left");
        actions.push({ type: "page", page: page - 1, query });
    }

    if (page < totalPages - 1) {
        form.button("§8§lNext Page", "textures/ui/arrow_right");
        actions.push({ type: "page", page: page + 1, query });
    }

    form.button("§c§lClose", "textures/ui/cancel");
    actions.push({ type: "close" });

    const res = await form.show(player);
    if (res.canceled) return;

    const action = actions[res.selection];
    if (!action || action.type === "close") return;
    if (action.type === "my") return openMyAhItems(player, 0);
    if (action.type === "page") return openAhBrowse(player, action.query, action.page);
    if (action.type === "view") return openAuctionDetails(player, action.id, { type: "browse", query: action.query, page: action.page });
}

async function openAuctionDetails(player, auctionId, back = { type: "browse", query: "", page: 0 }) {
    const a = findAuctionById(auctionId);
    if (!a) {
        msg(player, "§cThat auction no longer exists.");
        return openBack(player, back);
    }

    const own = sameSeller(player, a);

    const template = normalizeTemplate(a.template);
    const title = template ? template.nameTag || niceIdName(template.typeId) : "Unknown Item";
    const form = new ActionFormData().title(ahTitle(title)).body(buildAuctionDetailsBody(a, template, title, own));

    const actions = [];

    if (a.status === "active" && !own) {
        form.button("§2§lBuy", "textures/items/emerald");
        actions.push("buy");
    }

    if (a.status === "active" && own) {
        form.button("§c§lCancel Listing", "textures/ui/trash");
        actions.push("cancel");
    }

    if (a.status === "expired" && own) {
        form.button("§2§lClaim Item", "textures/ui/confirm");
        actions.push("claim");
    }

    form.button("§8§lBack", "textures/ui/arrow_left");
    actions.push("back");

    const res = await form.show(player);
    if (res.canceled) return openBack(player, back);

    const chosen = actions[res.selection];
    if (chosen === "buy") return openBuyAuctionConfirm(player, auctionId, back);
    if (chosen === "cancel") return openCancelAuctionConfirm(player, auctionId, back);
    if (chosen === "claim") return afterTrade(player, claimExpiredAuction(player, auctionId), auctionId, back);

    return openBack(player, back);
}

async function openBack(player, back) {
    if (back?.type === "my") return openMyAhItems(player, back.page ?? 0);
    return openAhBrowse(player, back?.query ?? "", back?.page ?? 0);
}

async function openBuyAuctionConfirm(player, auctionId, back) {
    const a = findAuctionById(auctionId);
    if (!a || a.status !== "active") return openBack(player, back);

    if (sameSeller(player, a)) {
        msg(player, "§cYou cannot buy your own auction.");
        return openAuctionDetails(player, auctionId, back);
    }

    if (getDisplayOptions(player).confirmAuctionBuy) {
        const confirm = new ActionFormData()
            .title(ahTitle("§2§lBuy Auction?"))
            .body(
                `§f§lItem: §e${auctionTitle(a)}\n` +
                    `§f§lAmount: §e${a.amount}\n` +
                    `§f§lSeller: §e${a.sellerName}\n` +
                    `§f§lTotal price: §e${formatCents(a.price)}`,
            )
            .button("§c§lCancel", "textures/ui/cancel")
            .button("§2§lBuy", getAuctionIcon(a));

        const res = await confirm.show(player);
        if (res.canceled || res.selection !== 1) return openAuctionDetails(player, auctionId, back);
    }

    return afterTrade(player, buyAuction(player, auctionId), auctionId, back);
}

async function openMyAhItems(player, page = 0) {
    const ah = loadAh();
    const mine = getPlayerAuctions(ah, player).sort((a, b) => {
        if (a.status !== b.status) return a.status === "active" ? -1 : 1;
        return b.createdAt - a.createdAt;
    });

    const totalPages = Math.max(1, Math.ceil(mine.length / AH_PAGE_SIZE));
    page = Math.max(0, Math.min(totalPages - 1, Math.floor(Number(page) || 0)));
    const start = page * AH_PAGE_SIZE;
    const shown = mine.slice(start, start + AH_PAGE_SIZE);

    const activeCount = mine.filter((a) => a.status === "active").length;
    const expiredCount = mine.filter((a) => a.status === "expired").length;

    const form = new ActionFormData()
        .title(ahTitle("My AH Items"))
        .body(
            `§lActive: §f${activeCount}/${serverOptions().active} §l| Expired: §f${expiredCount}/${AH_MAX_EXPIRED_PER_PLAYER}\n§lPage ${page + 1}/${totalPages}`,
        );

    const actions = [];

    for (const a of shown) {
        const status = a.status === "active" ? `§2Active §8${daysLeftText(a.expiresAt)}` : `§cExpired §8${daysLeftText(a.collectUntil)}`;

        form.button(
            `§8§l${auctionTitle(a)} x${a.amount}${enchantmentSummary(a)}\n§r${status} §8| §e${formatCents(a.price)}`,
            getAuctionIcon(a),
        );

        actions.push({
            type: "view",
            id: a.id,
        });
    }
    if (serverOptions().auctions) {
        form.button("§2§lSell Item", "textures/ui/color_plus_green");
        actions.push({ type: "sell" });
    }
    if (page > 0) {
        form.button("§8§lPrevious Page", "textures/ui/arrow_left");
        actions.push({ type: "page", page: page - 1 });
    }

    if (page < totalPages - 1) {
        form.button("§8§lNext Page", "textures/ui/arrow_right");
        actions.push({ type: "page", page: page + 1 });
    }

    form.button("§8§lBack", "textures/ui/arrow_left");
    actions.push({ type: "back" });

    const res = await form.show(player);
    if (res.canceled || actions[res.selection]?.type === "back") return serverOptions().auctions ? openAhBrowse(player, "", 0) : undefined;
    const action = actions[res.selection];
    if (!action) return;
    if (action.type === "sell") return openAhInventoryPicker(player, { type: "my", page });
    if (action.type === "page") return openMyAhItems(player, action.page);
    if (action.type === "view") return openAuctionDetails(player, action.id, { type: "my", page });
}

async function openCancelAuctionConfirm(player, auctionId, back) {
    const a = findAuctionById(auctionId);
    if (!a || a.status !== "active" || !sameSeller(player, a)) return openBack(player, back);

    const confirm = new ActionFormData()
        .title(ahTitle("§c§lCancel Auction?"))
        .body(
            `§c§lCancel this listing and reclaim the item?\n\n` +
                `§f§lItem: §e${auctionTitle(a)}\n` +
                `§f§lAmount: §e${a.amount}\n` +
                `§f§lPrice: §e${formatCents(a.price)}`,
        )
        .button("§8§lBack", "textures/ui/arrow_left")
        .button("§c§lCancel Listing", "textures/ui/trash");

    const res = await confirm.show(player);
    if (res.canceled || res.selection === 0) return openAuctionDetails(player, auctionId, back);

    return afterTrade(player, cancelAuction(player, auctionId), auctionId, back);
}

async function openAhSellEntry(player, priceRaw = "") {
    const inv = getInventoryContainer(player);
    if (!inv) return msg(player, "§cNo inventory container.");

    const selected = getSelectedSlotIndex(player);
    const held = inv.getItem(selected);

    if (!held) {
        return openAhInventoryPicker(player);
    }

    if (priceRaw && String(priceRaw).trim()) {
        const parsed = parseUiMoneyToCents(priceRaw, false);
        if (!parsed.ok) {
            msg(player, `§c${parsed.error ?? "Invalid price."}`);
            return openAhSellHeld(player, selected, held);
        }
        return openQuickSellConfirm(player, selected, held, parsed.cents);
    }

    return openAhSellHeld(player, selected, held);
}

async function openAhInventoryPicker(player, back) {
    const inv = getInventoryContainer(player);
    if (!inv) return msg(player, "§cNo inventory container.");

    const form = new ActionFormData().title(ahTitle("Sell Item")).body("§lPick an inventory slot to list on the auction house.");

    const slots = [];

    for (let i = 0; i < inv.size; i++) {
        const s = inv.getItem(i);
        if (!s) continue;
        form.button(`§f§lSlot ${i + 1}\n§r${describeStack(s)}`, getStackIcon(s));
        slots.push(i);
    }

    form.button("§8§lBack", "textures/ui/arrow_left");

    const res = await form.show(player);
    if (res.canceled || res.selection === slots.length) return openBack(player, back);

    const slot = slots[res.selection];
    const stack = inv.getItem(slot);
    if (!stack) {
        msg(player, "§cThat slot is empty now.");
        return openAhInventoryPicker(player, back);
    }

    return openAhSellHeld(player, slot, stack, back);
}

async function openAhSellHeld(player, slotIndex, sourceStack, back) {
    if (!sourceStack) return openAhInventoryPicker(player, back);

    if (isShulkerBoxId(sourceStack.typeId)) {
        msg(player, "§cAuction House does not support shulker boxes because Bedrock hides their contents from scripts.");
        return openBack(player, back);
    }

    if (isPotionItem(sourceStack?.typeId) || isShulkerBoxId(sourceStack?.typeId))
        return msg(player, "§cPotions and shulker boxes cannot be safely copied for auction.");
    const template = stackToTemplate(sourceStack);
    if (!template) {
        msg(player, "§cCould not copy that item.");
        return openBack(player, back);
    }

    const form = new ModalFormData().title("Sell on AH").textField("Total price", "ex: 500", { defaultValue: "1.00" });

    const res = await form.show(player);
    if (res.canceled) return openBack(player, back);

    const parsed = parseUiMoneyToCents(res.formValues?.[0], false);
    if (!parsed.ok) {
        msg(player, `§c${parsed.error ?? "Invalid price."}`);
        return openBack(player, back);
    }

    return openQuickSellConfirm(player, slotIndex, sourceStack, parsed.cents, back);
}

async function openQuickSellConfirm(player, slotIndex, sourceStack, priceCents, back) {
    if (isPotionItem(sourceStack?.typeId) || isShulkerBoxId(sourceStack?.typeId))
        return msg(player, "§cPotions and shulker boxes cannot be safely copied for auction.");
    const template = stackToTemplate(sourceStack);
    if (!template) return msg(player, "§cCould not copy that item.");

    const amount = Math.max(1, Math.floor(Number(sourceStack.amount ?? 1)));
    const itemName = template.nameTag || niceIdName(template.typeId);

    if (getDisplayOptions(player).confirmAuctionList) {
        const confirm = new ActionFormData()
            .title(ahTitle("§2§lList Auction?"))
            .body(
                `§f§lItem: §e${itemName}\n` +
                    `§f§lAmount: §e${amount}\n` +
                    `§f§lTotal price: §e${formatCents(priceCents)}\n\n` +
                    `§c§lThis will remove the whole stack from your inventory.`,
            )
            .button("§8§lBack", "textures/ui/arrow_left")
            .button("§2§lList Item", getStackIcon(sourceStack));

        const res = await confirm.show(player);
        if (res.canceled || res.selection !== 1) return openBack(player, back);
    }

    return afterTrade(player, listAuctionFromSlot(player, slotIndex, template, amount, priceCents), undefined, back);
}

function afterTrade(player, destination, auctionId, back) {
    switch (destination) {
        case "back":
            return openBack(player, back);
        case "details":
            return openAuctionDetails(player, auctionId, back);
        case "mine":
            return openMyAhItems(player, back?.page ?? 0);
        case "browse":
            return openBack(player, back);
    }
}
