import { createDocumentStore } from "../storage/chunkedDocument.js";
import { sanitizeShop } from "./catalog.js";
import { DEFAULT_SHOP } from "../defaults/shop.js";
import { normalizeItemId } from "../items/identifiers.js";
import { normalizeTemplate } from "../items/templates.js";

export function defaultCatalog() {
    const catalog = sanitizeShop(DEFAULT_SHOP);
    if (!catalog.categories.length) throw new Error("The default catalog could not resolve any item types.");
    return catalog;
}

const shopStore = createDocumentStore("lilymoney:shop_v2", 2, {
    initial: defaultCatalog,
    legacyVersions: [DEFAULT_SHOP.v],
    empty: () => ({ v: 2, categories: [] }),
    decode(data) {
        if (!Array.isArray(data?.categories)) throw new Error("Missing shop categories.");
        const clean = sanitizeShop(data);
        for (const category of data.categories) {
            if (!category?.name || !Array.isArray(category.items)) throw new Error("Invalid shop category.");
            for (const item of category.items) {
                if (!item || !normalizeItemId(item.id ?? item.template?.typeId) || (item.template && !normalizeTemplate(item.template)))
                    throw new Error("Invalid shop item.");
            }
        }
        const nonempty = data.categories.filter((category) => category.items.length);
        if (
            clean.categories.length !== nonempty.length ||
            nonempty.some((category, i) => category.items.length !== clean.categories[i].items.length)
        )
            throw new Error("Could not resolve every stored shop item.");
        return clean;
    },
});
export function loadShop() {
    return shopStore.load();
}
export function saveShop(data) {
    return shopStore.save(data);
}
export function stageShop(data) {
    shopStore.stage(data);
}
