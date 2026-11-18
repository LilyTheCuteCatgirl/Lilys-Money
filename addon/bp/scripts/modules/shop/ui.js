import { CONFIG } from "../../config.js";
import { ensureMoneyObjectives, getBalanceCents } from "../economy/balance.js";
import { formatCents } from "../economy/formatting.js";
import { formatItemLinePlayer, findItemInShop, shopItemTitle, getShopItemIcon, getCategoryIcon } from "./catalog.js";
import { normalizeTemplate } from "../items/templates.js";
import { niceIdName, romanLevel, shortItemName } from "../items/identifiers.js";
import { loadShop } from "./storage.js";
import { ActionFormData } from "@minecraft/server-ui";
import { isAdmin } from "../commandSource.js";
import { flowBuy, flowSell } from "./trading.js";
import { openAdminMenu } from "./adminUi.js";

const MAX_SHOP_SEARCH_RESULTS = Math.max(1, Math.floor(Number(CONFIG.SHOP_MAX_SEARCH_RESULTS ?? 30)));

function getMoneyStr(player) {
    const { dollarsObj, centsObj } = ensureMoneyObjectives();
    return formatCents(getBalanceCents(dollarsObj, centsObj, player));
}

function buildShopItemDetailsBody(player, it) {
    const lines = [];

    lines.push(`Balance: §e${getMoneyStr(player)}`);
    lines.push(`§8${formatItemLinePlayer(it)}`);
    lines.push("");

    const t = normalizeTemplate(it?.template);

    if (!t) {
        lines.push(`§8Item: §f${niceIdName(it.id)}`);
        lines.push(`§8ID: §8${it.id}`);
        return lines.join("\n");
    }

    lines.push("§dCustom item");
    lines.push(`§8Type: §f${niceIdName(t.typeId)}`);
    lines.push(`§8ID: §8${t.typeId}`);

    if (t.nameTag) {
        lines.push(`§8Custom name: §r${t.nameTag}`);
    }

    if (Array.isArray(t.enchantments) && t.enchantments.length > 0) {
        lines.push("");
        lines.push("§8Enchantments:");

        for (const e of t.enchantments.slice(0, 12)) {
            lines.push(`§8- §b${niceIdName(e.id)} ${romanLevel(e.level)}`);
        }

        if (t.enchantments.length > 12) {
            lines.push(`§8- §8and ${t.enchantments.length - 12} more...`);
        }
    }

    if (Array.isArray(t.lore) && t.lore.length > 0) {
        lines.push("");
        lines.push("§8Lore:");

        for (const line of t.lore.slice(0, 8)) {
            lines.push(`§8- §r${line}`);
        }

        if (t.lore.length > 8) {
            lines.push(`§8- §8and ${t.lore.length - 8} more...`);
        }
    }

    if (Number.isInteger(t.durabilityDamage) && t.durabilityDamage > 0) {
        lines.push("");
        lines.push(`§8Durability damage: §e${t.durabilityDamage}`);
    }

    if (Array.isArray(t.canPlaceOn) && t.canPlaceOn.length > 0) {
        lines.push("");
        lines.push("§8Can place on:");

        for (const id of t.canPlaceOn.slice(0, 6)) {
            lines.push(`§8- §f${shortItemName(id)}`);
        }

        if (t.canPlaceOn.length > 6) {
            lines.push(`§8- §8and ${t.canPlaceOn.length - 6} more...`);
        }
    }

    if (Array.isArray(t.canDestroy) && t.canDestroy.length > 0) {
        lines.push("");
        lines.push("§8Can destroy:");

        for (const id of t.canDestroy.slice(0, 6)) {
            lines.push(`§8- §f${shortItemName(id)}`);
        }

        if (t.canDestroy.length > 6) {
            lines.push(`§8- §8and ${t.canDestroy.length - 6} more...`);
        }
    }

    if (t.keepOnDeath) {
        lines.push("");
        lines.push("§8Keep on death: §2Yes");
    }

    if (t.lockMode !== undefined && t.lockMode !== null && String(t.lockMode) !== "none") {
        lines.push(`§8Lock mode: §e${String(t.lockMode)}`);
    }

    const dynCount = Object.keys(t.dynamicProperties ?? {}).length;
    if (dynCount > 0) {
        lines.push("");
        lines.push(`§8Custom data: §e${dynCount} properties`);
    }

    return lines.join("\n");
}

export async function openShopEntry(player, itemQuery) {
    const shop = loadShop();

    if (!itemQuery || !String(itemQuery).trim()) {
        return openShopRoot(player);
    }

    const query = String(itemQuery ?? "").trim();
    const matches = findItemInShop(shop, query);

    if (matches.length === 0) {
        player.sendMessage("§r<§dLily's Money§r> §r" + `§cItem not found in shop: §f${itemQuery}`);
        return openShopRoot(player);
    }

    if (matches.length === 1) {
        const m = matches[0];
        return openItemMenu(player, m.ci, m.ii);
    }

    const shownMatches = matches.slice(0, MAX_SHOP_SEARCH_RESULTS);
    const hiddenCount = matches.length - shownMatches.length;

    const form = new ActionFormData()
        .use8CrafterLayout("long")
        .title("Shop Search")
        .body(
            `§8Matches for §f${itemQuery}§8. Pick one:` +
                (hiddenCount > 0 ? `\n\n§8Showing best §e${shownMatches.length}§8 of §e${matches.length}§8 matches.` : "") +
                (hiddenCount > 0 ? "\n§8Try a longer search to narrow it down." : ""),
        );

    for (const m of shownMatches) {
        form.button(`§8§l${shopItemTitle(m.item)}\n§r§8Category: ${m.catName}`, getShopItemIcon(m.item));
    }

    form.button("§8§lBack", "textures/ui/arrow_left");

    const res = await form.show(player);
    if (res.canceled) return;

    if (res.selection === shownMatches.length) return openShopRoot(player);

    const pick = shownMatches[res.selection];
    if (!pick) return openShopRoot(player);

    return openItemMenu(player, pick.ci, pick.ii);
}

async function openShopRoot(player) {
    const shop = loadShop();
    const admin = isAdmin(player);

    if (shop.categories.length === 0) {
        if (!admin) {
            const form = new ActionFormData()
                .use8CrafterLayout("long")
                .title("Shop")
                .body("§cThe shop is not configured yet.\n§8Ask an admin to set it up.")
                .button("§c§lClose", "textures/ui/cancel");

            await form.show(player);
            return;
        }

        return openEditor(player);
    }

    const form = new ActionFormData()
        .use8CrafterLayout("long")
        .title("Shop")
        .body(`Balance: §e${getMoneyStr(player)}\n§8Choose a category:`);

    if (admin) form.button("§6§lEdit Shop", "textures/ui/settings_glyph_color_2x");

    for (const c of shop.categories) {
        form.button(`§f§l${c.name}`, getCategoryIcon(c));
    }

    const res = await form.show(player);
    if (res.canceled) return;

    if (admin && res.selection === 0) return openEditor(player);

    const catIndex = admin ? res.selection - 1 : res.selection;
    if (catIndex < 0 || catIndex >= shop.categories.length) return;

    return openCategoryMenu(player, catIndex);
}

async function openCategoryMenu(player, catIndex) {
    const shop = loadShop();
    const cat = shop.categories[catIndex];
    if (!cat) return;

    const form = new ActionFormData()
        .use8CrafterLayout("long")
        .title(`Shop - ${cat.name}`)
        .body(`Balance: §e${getMoneyStr(player)}\n§8Choose an item:`);

    for (const it of cat.items) {
        form.button(`§8§l${shopItemTitle(it)}\n§r${formatItemLinePlayer(it)}`, getShopItemIcon(it));
    }

    form.button("§8§lBack", "textures/ui/arrow_left");

    const res = await form.show(player);
    if (res.canceled) return;

    if (res.selection === cat.items.length) return openShopRoot(player);

    const it = cat.items[res.selection];
    if (!it) return;

    return openItemMenu(player, catIndex, res.selection);
}

async function openItemMenu(player, catIndex, itemIndex) {
    const shop = loadShop();
    const cat = shop.categories[catIndex];
    const it = cat?.items?.[itemIndex];

    if (!cat || !it) return;

    const form = new ActionFormData().use8CrafterLayout("long").title(shopItemTitle(it)).body(buildShopItemDetailsBody(player, it));

    const actions = [];

    if (it.allowBuy) {
        form.button("§2§lBuy", "textures/ui/color_plus");
        actions.push("buy");
    }

    if (it.allowSell) {
        form.button("§b§lSell", "textures/items/emerald");
        actions.push("sell");
    }

    form.button("§8§lBack", "textures/ui/arrow_left");
    actions.push("back");

    const res = await form.show(player);
    if (res.canceled) return;

    const chosen = actions[res.selection];

    if (chosen === "back") return openCategoryMenu(player, catIndex);
    if (chosen === "buy") await flowBuy(player, it);
    if (chosen === "sell") await flowSell(player, it);

    return openItemMenu(player, catIndex, itemIndex);
}

async function openEditor(player) {
    if (await openAdminMenu(player)) return openShopRoot(player);
}
