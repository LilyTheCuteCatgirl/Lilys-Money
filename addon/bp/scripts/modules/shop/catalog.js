import { sendChat } from "../chat.js";
import { templateKey, normalizeTemplate, templateHasCustomData } from "../items/templates.js";
import { normalizeItemId, niceIdName, stripColors, shortItemName, searchTokens } from "../items/identifiers.js";
import { filterActuallyApplicableEnchantments, mergeEnchantments } from "../items/enchantments.js";
import { formatCents } from "../economy/formatting.js";
import { cleanTexturePath, getItemIconFromShopItem } from "../ui/itemIcons.js";
import { SHOP_CATEGORY_ICON_PRESETS } from "../defaults/shop.js";

export function findCategoryIndex(shop, name) {
    const low = String(name ?? "").toLowerCase();

    return shop.categories.findIndex((c) => String(c.name ?? "").toLowerCase() === low);
}

export function findNormalItemGlobal(shop, itemId) {
    for (let ci = 0; ci < shop.categories.length; ci++) {
        const cat = shop.categories[ci];
        const ii = cat.items.findIndex((it) => !it.template && it.id === itemId);
        if (ii !== -1) return { ci, ii };
    }

    return null;
}

export function findTemplateGlobal(shop, key, ignore = null) {
    for (let ci = 0; ci < shop.categories.length; ci++) {
        const cat = shop.categories[ci];

        for (let ii = 0; ii < cat.items.length; ii++) {
            if (ignore && ignore.ci === ci && ignore.ii === ii) continue;

            const it = cat.items[ii];
            if (!it.template) continue;

            if (templateKey(it.template) === key) return { ci, ii };
        }
    }

    return null;
}

function basicTemplateForId(itemId) {
    const id = normalizeItemId(itemId);

    return id ? normalizeTemplate({ typeId: id }) : null;
}

export function manualTemplateForItem(itemId, customName, enchantments, baseTemplate = null) {
    const id = normalizeItemId(baseTemplate?.typeId ?? itemId);
    if (!id) return null;

    const base = normalizeTemplate(baseTemplate ?? { typeId: id });
    if (!base) return null;

    base.typeId = id;
    base.nameTag = String(customName ?? "").trim();
    base.enchantments = filterActuallyApplicableEnchantments(id, mergeEnchantments([], enchantments));

    return normalizeTemplate(base);
}

export function getTemplateForShopItem(it) {
    if (it?.template) return normalizeTemplate(it.template);

    return basicTemplateForId(it?.id);
}

export function shopItemTitle(it) {
    const t = normalizeTemplate(it?.template);
    if (t?.nameTag) return t.nameTag;

    return niceIdName(it?.id);
}

export function shopItemAdminTitle(it) {
    if (it?.template) {
        return `§d§lCustom §8${shopItemTitle(it)} §r§8(${it.id})`;
    }

    return `§8§l${it.id}`;
}

export function formatItemLineAdmin(it) {
    const buyTxt = it.allowBuy ? `Buy: ${formatCents(it.buy)}` : "Buy: disabled";
    const sellTxt = it.allowSell ? `Sell: ${formatCents(it.sell)}` : "Sell: disabled";
    const exact = it.template ? " | Custom/exact item" : "";

    return `${buyTxt} | ${sellTxt}${exact}`;
}

export function formatItemLinePlayer(it) {
    const buyTxt = it.allowBuy ? `§2Buy: ${formatCents(it.buy)}` : "§8Buy: disabled";
    const sellTxt = it.allowSell ? `§cSell: ${formatCents(it.sell)}` : "§8Sell: disabled";
    const exact = it.template ? " §dCustom" : "";

    return `${buyTxt} §8| ${sellTxt}${exact}`;
}

export function sanitizeShop(shop) {
    const out = {
        v: 2,
        categories: Array.isArray(shop?.categories) ? shop.categories : [],
    };

    out.categories = out.categories
        .map((c) => {
            const name = String(c?.name ?? "").trim();

            return {
                name,
                icon: cleanTexturePath(c?.icon || DEFAULT_CATEGORY_ICON, DEFAULT_CATEGORY_ICON),
                items: Array.isArray(c?.items) ? c.items : [],
            };
        })
        .filter((c) => c.name.length > 0)
        .map((c) => ({
            name: c.name,
            icon: getCategoryIcon(c),
            items: c.items
                .map((it) => {
                    const template = normalizeTemplate(it?.template);
                    const idNorm = normalizeItemId(template?.typeId ?? it?.id);
                    if (!idNorm) return null;

                    const obj = {
                        id: idNorm,
                        buy: Number.isInteger(it?.buy) ? it.buy : 0,
                        sell: Number.isInteger(it?.sell) ? it.sell : 0,
                        allowBuy: it?.allowBuy === true,
                        allowSell: it?.allowSell === true,
                    };

                    if (template && templateHasCustomData(template)) obj.template = template;

                    return obj;
                })
                .filter((it) => it && it.id.length > 0),
        }))
        .filter((c) => c.items.length > 0);

    return out;
}

function shopSearchText(itemId, categoryName = "", it = null) {
    const full = String(itemId ?? "").toLowerCase();
    const short = full.replace(/^minecraft:/, "");
    const spaced = short.replace(/[_:\-]+/g, " ");
    const cat = String(categoryName ?? "").toLowerCase();

    const t = normalizeTemplate(it?.template);
    const customName = stripColors(t?.nameTag ?? "").toLowerCase();
    const lore = Array.isArray(t?.lore) ? stripColors(t.lore.join(" ")).toLowerCase() : "";
    const ench = Array.isArray(t?.enchantments)
        ? t.enchantments
              .map((e) => `${e.id} ${shortItemName(e.id)} ${niceIdName(e.id)}`)
              .join(" ")
              .toLowerCase()
        : "";

    return `${full} ${short} ${spaced} ${cat} ${customName} ${lore} ${ench}`;
}

export function findItemInShop(shop, rawQuery) {
    const tokens = searchTokens(rawQuery);
    if (!tokens.length) return [];

    const matches = [];

    for (let ci = 0; ci < shop.categories.length; ci++) {
        const cat = shop.categories[ci];

        for (let ii = 0; ii < cat.items.length; ii++) {
            const it = cat.items[ii];
            const searchText = shopSearchText(it.id, cat.name, it);

            const ok = tokens.every((token) => searchText.includes(token));
            if (!ok) continue;

            const short = String(it.id ?? "")
                .toLowerCase()
                .replace(/^minecraft:/, "");
            const spaced = short.replace(/[_:\-]+/g, " ");
            const cleanTitle = stripColors(shopItemTitle(it)).toLowerCase();

            let score = 0;

            if (short === tokens.join("_")) score += 100;
            if (spaced === tokens.join(" ")) score += 90;
            if (cleanTitle === tokens.join(" ")) score += 85;
            if (short.includes(tokens.join("_"))) score += 50;
            if (spaced.includes(tokens.join(" "))) score += 40;
            if (cleanTitle.includes(tokens.join(" "))) score += 35;

            score -= short.length;

            matches.push({
                ci,
                ii,
                catName: cat.name,
                item: it,
                score,
            });
        }
    }

    matches.sort((a, b) => b.score - a.score);

    return matches;
}

const DEFAULT_CATEGORY_ICON = "textures/ui/page";

export function getCategoryIcon(cat) {
    return cleanTexturePath(cat?.icon || DEFAULT_CATEGORY_ICON, DEFAULT_CATEGORY_ICON);
}

export function getShopCategoryIconOptions() {
    return SHOP_CATEGORY_ICON_PRESETS.map((p) => p.name);
}

export function getShopCategoryIconByPresetIndex(index) {
    const i = Math.floor(Number(index));

    return cleanTexturePath(SHOP_CATEGORY_ICON_PRESETS[i]?.texture, DEFAULT_CATEGORY_ICON);
}

export function getShopCategoryIconPresetIndex(texture) {
    const clean = cleanTexturePath(texture, DEFAULT_CATEGORY_ICON);

    const index = SHOP_CATEGORY_ICON_PRESETS.findIndex((p) => cleanTexturePath(p.texture, DEFAULT_CATEGORY_ICON) === clean);

    return index >= 0 ? index : 0;
}

export function getShopItemIcon(it) {
    return getItemIconFromShopItem(it);
}

export function shopMessage(player, text) {
    sendChat(player, text);
}
