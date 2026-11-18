// BP/scripts/commands/shop.js
import {
    CommandPermissionLevel,
    CustomCommandParamType,
    CustomCommandStatus,
    EnchantmentTypes,
    ItemStack,
    ItemTypes,
    Player,
    system,
    world,
} from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";

import { CONFIG } from "../config.js";
import {
    ensureMoneyObjectives,
    getBalanceCents,
    setBalanceFromTotalCents,
    parseFloatToCents,
    formatCents,
    getCommandSource,
    isAdmin,
    getInventoryContainer,
    playMoneySound,
} from "../jsfunctions.js";

import { DEFAULT_SHOP, SHOP_CATEGORY_ICON_PRESETS } from "../defaults.js";
import { getItemIconFromShopItem, getStackIcon } from "../ui/itemIcons.js";

import { logMoneyEvent } from "../moneylogging.js";

// =========================================================
// SETTINGS
// =========================================================
const MAX_TRADE_AMOUNT = Math.max(1, Math.floor(Number(CONFIG.SHOP_MAX_TRADE_AMOUNT ?? 2304)));
const MAX_SHOP_SEARCH_RESULTS = Math.max(1, Math.floor(Number(CONFIG.SHOP_MAX_SEARCH_RESULTS ?? 30)));

const SHOP_CONFIRM_UI = "§a§n§d§e§x§d§b§_§m§e§d§i§u§m§_§l§o§n§g§_§f§o§r§m§r";

function shopConfirmTitle(text) {
    return `${SHOP_CONFIRM_UI}${text}`;
}

const SHOP_DP_BASE = `lilymoney:shop_v2`;
const SHOP_DP_META = `${SHOP_DP_BASE}:meta`;
const SHOP_DP_PART = (i) => `${SHOP_DP_BASE}:part_${i}`;

const SHOP_DP_MAX_CHARS = 32767;
const SHOP_CHUNK_SIZE = 30000;

let SHOP_CACHE = null;

// =========================================================
// Chunked DP Storage
// =========================================================
function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function splitChunks(str, size) {
    const out = [];
    for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
    return out;
}

function clearOldShopParts(maxParts = 300) {
    try {
        world.setDynamicProperty(SHOP_DP_META, "");
    } catch {}
    try {
        world.setDynamicProperty(SHOP_DP_BASE, "");
    } catch {}

    for (let i = 0; i < maxParts; i++) {
        try {
            world.setDynamicProperty(SHOP_DP_PART(i), "");
        } catch {}
    }
}

function readShopRawFromDP() {
    try {
        const metaRaw = world.getDynamicProperty(SHOP_DP_META);
        if (typeof metaRaw === "string" && metaRaw.length) {
            const meta = JSON.parse(metaRaw);
            const parts = Math.max(0, Math.floor(meta?.parts ?? 0));

            if (parts === 0) return "";

            if (parts > 0 && parts < 300) {
                let full = "";
                for (let i = 0; i < parts; i++) {
                    const part = world.getDynamicProperty(SHOP_DP_PART(i));
                    if (typeof part !== "string") return null;
                    full += part;
                }
                return full;
            }
        }
    } catch {}

    try {
        const legacy = world.getDynamicProperty(SHOP_DP_BASE);
        if (typeof legacy === "string" && legacy.length) return legacy;
    } catch {}

    return null;
}

function saveShop(shopObj) {
    try {
        const cleaned = sanitizeShop(shopObj);
        const json = JSON.stringify(cleaned);
        const parts = splitChunks(json, SHOP_CHUNK_SIZE);

        if (parts.some((p) => p.length > SHOP_DP_MAX_CHARS)) return false;

        let oldParts = 0;
        try {
            const oldMetaRaw = world.getDynamicProperty(SHOP_DP_META);
            if (typeof oldMetaRaw === "string" && oldMetaRaw.length) {
                const oldMeta = JSON.parse(oldMetaRaw);
                oldParts = Math.max(0, Math.floor(oldMeta?.parts ?? 0));
            }
        } catch {}

        for (let i = 0; i < parts.length; i++) {
            world.setDynamicProperty(SHOP_DP_PART(i), parts[i]);
        }

        for (let i = parts.length; i < oldParts; i++) {
            try {
                world.setDynamicProperty(SHOP_DP_PART(i), "");
            } catch {}
        }

        world.setDynamicProperty(SHOP_DP_META, JSON.stringify({ v: 2, parts: parts.length }));

        SHOP_CACHE = cleaned;
        return true;
    } catch (e) {
        console.warn(`[Shop] saveShop error: ${String(e)}\n${e?.stack ?? ""}`);
        return false;
    }
}

function loadShop() {
    if (SHOP_CACHE) return SHOP_CACHE;

    try {
        const raw = readShopRawFromDP();

        if (raw === "") {
            SHOP_CACHE = { v: 2, categories: [] };
            return SHOP_CACHE;
        }

        if (typeof raw === "string" && raw.length) {
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.categories)) {
                SHOP_CACHE = sanitizeShop(parsed);
                return SHOP_CACHE;
            }
        }
    } catch (e) {
        console.warn(`[Shop] loadShop parse error: ${String(e)}`);
    }

    SHOP_CACHE = sanitizeShop(deepClone(DEFAULT_SHOP));
    saveShop(SHOP_CACHE);
    return SHOP_CACHE;
}

// =========================================================
// Basic Helpers
// =========================================================
function msg(player, text) {
    player.sendMessage("§r<§d§lLilys Money§r> §r" + text);
}

function safeIsValidItemId(id) {
    try {
        return !!ItemTypes.get(id);
    } catch {
        return false;
    }
}

function normalizeLooseId(raw) {
    const s = String(raw ?? "")
        .trim()
        .toLowerCase();
    if (!s) return null;
    return s.includes(":") ? s : `minecraft:${s}`;
}

function normalizeItemId(raw) {
    const id = normalizeLooseId(raw);
    return id && safeIsValidItemId(id) ? id : null;
}

function getItemType(id) {
    try {
        return ItemTypes.get(id);
    } catch {
        return null;
    }
}

function shortItemName(id) {
    const s = String(id ?? "");
    if (s.startsWith("minecraft:")) return s.slice("minecraft:".length);
    const i = s.indexOf(":");
    return i !== -1 ? s.slice(i + 1) : s;
}

function niceIdName(id) {
    const s = shortItemName(id);
    return s
        .split("_")
        .map((p) => (p.length ? p[0].toUpperCase() + p.slice(1) : p))
        .join(" ");
}

function stripColors(text) {
    return String(text ?? "").replace(/§./g, "");
}

function romanLevel(n) {
    const level = Math.floor(Number(n));
    if (level <= 0) return String(n);

    const romans = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
    if (level >= 1 && level <= 10) return romans[level];

    return String(level);
}

function parseUiMoneyToCents(text, allowNegative = false) {
    const s = String(text ?? "").trim();
    if (!s) return { ok: true, cents: 0 };

    const num = Number(s.replace(",", "."));
    if (!Number.isFinite(num)) return { ok: false, error: "Invalid number." };

    return parseFloatToCents(num, allowNegative);
}

function getMoneyStr(player) {
    const { dollarsObj, centsObj } = ensureMoneyObjectives();
    return formatCents(getBalanceCents(dollarsObj, centsObj, player));
}

function findCategoryIndex(shop, name) {
    const low = String(name ?? "").toLowerCase();
    return shop.categories.findIndex((c) => String(c.name ?? "").toLowerCase() === low);
}

function isShulkerBoxId(id) {
    const s = String(id ?? "").toLowerCase();
    return s === "minecraft:shulker_box" || s.endsWith("_shulker_box");
}

function isOldFakeEnchantLore(line) {
    const plain = stripColors(line).trim().toLowerCase();
    return plain.startsWith("enchant:");
}

function findNormalItemGlobal(shop, itemId) {
    for (let ci = 0; ci < shop.categories.length; ci++) {
        const cat = shop.categories[ci];
        const ii = cat.items.findIndex((it) => !it.template && it.id === itemId);
        if (ii !== -1) return { ci, ii };
    }

    return null;
}

function findTemplateGlobal(shop, key, ignore = null) {
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

// =========================================================
// Enchantment Helpers
// =========================================================
function normalizeEnchantId(raw) {
    const s = String(raw ?? "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "_");

    if (!s) return "";

    return s.includes(":") ? s : `minecraft:${s}`;
}

function parseEnchantmentsText(text) {
    const raw = String(text ?? "").trim();
    if (!raw) return [];

    const parts = raw
        .split(/[,;\n]+/g)
        .map((p) => p.trim())
        .filter(Boolean);

    const map = new Map();

    for (const part of parts) {
        let idPart = part;
        let level = 1;

        const lastSpace = part.lastIndexOf(" ");
        const lastColon = part.lastIndexOf(":");

        if (lastSpace > -1) {
            const maybeLevel = part.slice(lastSpace + 1).trim();
            if (/^-?\d+$/.test(maybeLevel)) {
                idPart = part.slice(0, lastSpace).trim();
                level = Math.floor(Number(maybeLevel));
            }
        } else if (lastColon > -1) {
            const maybeLevel = part.slice(lastColon + 1).trim();
            if (/^-?\d+$/.test(maybeLevel)) {
                idPart = part.slice(0, lastColon).trim();
                level = Math.floor(Number(maybeLevel));
            }
        }

        const id = normalizeEnchantId(idPart);
        if (!id || level <= 0) continue;

        level = Math.min(32767, level);
        map.set(id, { id, level });
    }

    return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function enchantmentsToText(enchantments) {
    if (!Array.isArray(enchantments) || enchantments.length === 0) return "";
    return enchantments.map((e) => `${shortItemName(e.id)}:${e.level}`).join(", ");
}

function mergeEnchantments(a, b) {
    const map = new Map();

    for (const e of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
        const id = normalizeEnchantId(e?.id);
        const level = Math.floor(Number(e?.level ?? 1));
        if (!id || level <= 0) continue;

        map.set(id, {
            id,
            level: Math.min(32767, level),
        });
    }

    return [...map.values()].sort((x, y) => x.id.localeCompare(y.id));
}

function getEnchantType(id) {
    try {
        const t = EnchantmentTypes.get(id);
        if (t) return t;
    } catch {}

    try {
        const t = EnchantmentTypes.get(shortItemName(id));
        if (t) return t;
    } catch {}

    return null;
}

function filterActuallyApplicableEnchantments(typeId, enchantments) {
    const itemType = getItemType(typeId);
    if (!itemType) return [];

    let stack;
    try {
        stack = new ItemStack(itemType, 1);
    } catch {
        return [];
    }

    try {
        const ench = stack.getComponent("minecraft:enchantable");
        if (!ench) return [];

        for (const e of enchantments) {
            try {
                const enchType = getEnchantType(e.id);
                if (!enchType) continue;

                ench.addEnchantment({
                    type: enchType,
                    level: e.level,
                });
            } catch {
                // Minecraft rejected it, so it does not get stored.
            }
        }

        if (!ench.getEnchantments) return [];

        return ench
            .getEnchantments()
            .map((e) => ({
                id: normalizeEnchantId(e?.type?.id ?? ""),
                level: Math.floor(Number(e?.level ?? 1)),
            }))
            .filter((e) => e.id && e.level > 0)
            .sort((a, b) => a.id.localeCompare(b.id));
    } catch {
        return [];
    }
}

// =========================================================
// Exact Item Templates
// =========================================================
function normalizeDynamicValue(value) {
    const t = typeof value;

    if (value === undefined || value === null) return undefined;
    if (t === "string" || t === "number" || t === "boolean") return value;

    if (t === "object" && Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y)) && Number.isFinite(Number(value.z))) {
        return {
            __type: "Vector3",
            x: Number(value.x),
            y: Number(value.y),
            z: Number(value.z),
        };
    }

    return undefined;
}

function restoreDynamicValue(value) {
    if (value && typeof value === "object" && value.__type === "Vector3") {
        return {
            x: Number(value.x),
            y: Number(value.y),
            z: Number(value.z),
        };
    }

    return value;
}

function sortedStringArray(value) {
    return Array.isArray(value) ? value.map(String).sort((a, b) => a.localeCompare(b)) : [];
}

function normalizeTemplate(template) {
    if (!template || typeof template !== "object") return null;

    const typeId = normalizeItemId(template.typeId ?? template.id);
    if (!typeId) return null;

    const out = {
        typeId,
        nameTag: typeof template.nameTag === "string" ? template.nameTag : "",
        lore: Array.isArray(template.lore) ? template.lore.map(String).filter((line) => !isOldFakeEnchantLore(line)) : [],
        canDestroy: sortedStringArray(template.canDestroy),
        canPlaceOn: sortedStringArray(template.canPlaceOn),
        keepOnDeath: template.keepOnDeath === true,
        lockMode: template.lockMode === undefined ? undefined : template.lockMode,
        durabilityDamage:
            Number.isInteger(template.durabilityDamage) && template.durabilityDamage > 0 ? template.durabilityDamage : undefined,
        enchantments: Array.isArray(template.enchantments) ? template.enchantments : [],
        dynamicProperties: {},
    };

    out.enchantments = out.enchantments
        .map((e) => ({
            id: normalizeEnchantId(e?.id ?? e?.typeId ?? e?.type?.id ?? ""),
            level: Math.floor(Number(e?.level ?? 1)),
        }))
        .filter((e) => e.id && e.level > 0)
        .map((e) => ({
            id: e.id,
            level: Math.min(32767, e.level),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));

    const dyn = template.dynamicProperties && typeof template.dynamicProperties === "object" ? template.dynamicProperties : {};

    for (const key of Object.keys(dyn).sort((a, b) => a.localeCompare(b))) {
        const v = normalizeDynamicValue(dyn[key]);
        if (v !== undefined) out.dynamicProperties[key] = v;
    }

    return out;
}

function templateHasCustomData(template) {
    const t = normalizeTemplate(template);
    if (!t) return false;

    if (t.nameTag) return true;
    if (t.lore.length > 0) return true;
    if (t.canDestroy.length > 0) return true;
    if (t.canPlaceOn.length > 0) return true;
    if (t.keepOnDeath) return true;
    if (t.lockMode !== undefined && t.lockMode !== null && String(t.lockMode) !== "none") return true;
    if (Number.isInteger(t.durabilityDamage) && t.durabilityDamage > 0) return true;
    if (t.enchantments.length > 0) return true;
    if (Object.keys(t.dynamicProperties ?? {}).length > 0) return true;

    return false;
}

function stackToTemplate(stack) {
    if (!stack) return null;

    const template = {
        typeId: stack.typeId,
        nameTag: "",
        lore: [],
        canDestroy: [],
        canPlaceOn: [],
        keepOnDeath: false,
        lockMode: undefined,
        durabilityDamage: undefined,
        enchantments: [],
        dynamicProperties: {},
    };

    try {
        template.nameTag = stack.nameTag ?? "";
    } catch {}
    try {
        template.lore = (stack.getLore?.() ?? []).map(String).filter((line) => !isOldFakeEnchantLore(line));
    } catch {}
    try {
        template.canDestroy = stack.getCanDestroy?.() ?? [];
    } catch {}
    try {
        template.canPlaceOn = stack.getCanPlaceOn?.() ?? [];
    } catch {}
    try {
        template.keepOnDeath = stack.keepOnDeath === true;
    } catch {}
    try {
        template.lockMode = stack.lockMode;
    } catch {}

    try {
        const dura = stack.getComponent("minecraft:durability");
        if (dura && Number.isInteger(dura.damage) && dura.damage > 0) {
            template.durabilityDamage = dura.damage;
        }
    } catch {}

    try {
        const ench = stack.getComponent("minecraft:enchantable");
        if (ench?.getEnchantments) {
            const realEnchants = ench
                .getEnchantments()
                .map((e) => ({
                    id: normalizeEnchantId(e?.type?.id ?? ""),
                    level: Math.floor(Number(e?.level ?? 1)),
                }))
                .filter((e) => e.id && e.level > 0);

            template.enchantments = mergeEnchantments(template.enchantments, realEnchants);
        }
    } catch {}

    try {
        const ids = stack.getDynamicPropertyIds?.() ?? [];
        ids.sort((a, b) => String(a).localeCompare(String(b)));

        for (const id of ids) {
            const v = normalizeDynamicValue(stack.getDynamicProperty(id));
            if (v !== undefined) template.dynamicProperties[String(id)] = v;
        }
    } catch {}

    return normalizeTemplate(template);
}

function templateToStack(template, amount = 1) {
    const t = normalizeTemplate(template);
    if (!t) return null;

    const itemType = getItemType(t.typeId);
    if (!itemType) return null;

    let stack;
    try {
        stack = new ItemStack(itemType, Math.max(1, Math.min(255, Math.floor(amount))));
    } catch {
        return null;
    }

    try {
        if (t.nameTag) stack.nameTag = t.nameTag;
    } catch {}
    try {
        if (t.canDestroy.length) stack.setCanDestroy(t.canDestroy);
    } catch {}
    try {
        if (t.canPlaceOn.length) stack.setCanPlaceOn(t.canPlaceOn);
    } catch {}
    try {
        stack.keepOnDeath = t.keepOnDeath === true;
    } catch {}
    try {
        if (t.lockMode !== undefined) stack.lockMode = t.lockMode;
    } catch {}

    try {
        const dura = stack.getComponent("minecraft:durability");
        if (dura && Number.isInteger(t.durabilityDamage) && t.durabilityDamage > 0) {
            dura.damage = t.durabilityDamage;
        }
    } catch {}

    try {
        const ench = stack.getComponent("minecraft:enchantable");

        if (ench && t.enchantments.length) {
            for (const e of t.enchantments) {
                try {
                    const enchType = getEnchantType(e.id);
                    if (!enchType) continue;

                    ench.addEnchantment({
                        type: enchType,
                        level: e.level,
                    });
                } catch {
                    // Minecraft rejected it, so skip it.
                }
            }
        }
    } catch {}

    try {
        if (Array.isArray(t.lore) && t.lore.length) {
            stack.setLore(t.lore);
        }
    } catch {}

    try {
        for (const [id, v] of Object.entries(t.dynamicProperties ?? {})) {
            stack.setDynamicProperty(id, restoreDynamicValue(v));
        }
    } catch {}

    return stack;
}

function templateKey(template) {
    const t = normalizeTemplate(template);
    return t ? JSON.stringify(t) : "";
}

function basicTemplateForId(itemId) {
    const id = normalizeItemId(itemId);
    return id ? normalizeTemplate({ typeId: id }) : null;
}

function manualTemplateForItem(itemId, customName, enchantments, baseTemplate = null) {
    const id = normalizeItemId(baseTemplate?.typeId ?? itemId);
    if (!id) return null;

    const base = normalizeTemplate(baseTemplate ?? { typeId: id });
    if (!base) return null;

    base.typeId = id;
    base.nameTag = String(customName ?? "").trim();
    base.enchantments = filterActuallyApplicableEnchantments(id, mergeEnchantments([], enchantments));

    return normalizeTemplate(base);
}

function getTemplateForShopItem(it) {
    if (it?.template) return normalizeTemplate(it.template);
    return basicTemplateForId(it?.id);
}

function stackMatchesShopItem(stack, it) {
    if (!stack) return false;

    const itemId = normalizeItemId(it?.id);
    if (!itemId) return false;

    if (!it?.template) {
        return stack.typeId === itemId;
    }

    const wanted = getTemplateForShopItem(it);
    const current = stackToTemplate(stack);
    if (!wanted || !current) return false;

    return templateKey(wanted) === templateKey(current);
}

function stackCanMergeWhenBuying(stack, it) {
    if (!stack) return false;

    const wanted = getTemplateForShopItem(it);
    const current = stackToTemplate(stack);
    if (!wanted || !current) return false;

    return templateKey(wanted) === templateKey(current);
}

function getMaxStackFromTemplate(template) {
    const probe = templateToStack(template, 1);
    if (!probe) return 64;
    return Math.max(1, probe.maxAmount ?? 64);
}

function getCapacityForShopItem(container, it) {
    const template = getTemplateForShopItem(it);
    if (!template) return 0;

    const maxStack = getMaxStackFromTemplate(template);
    let capacity = 0;

    for (let i = 0; i < container.size; i++) {
        const s = container.getItem(i);

        if (!s) {
            capacity += maxStack;
            continue;
        }

        if (stackCanMergeWhenBuying(s, it) && s.amount < maxStack) {
            capacity += maxStack - s.amount;
        }
    }

    return capacity;
}

function canFitExactShopItem(container, it, amount) {
    return getCapacityForShopItem(container, it) >= amount;
}

function addExactShopItem(container, it, amount) {
    const template = getTemplateForShopItem(it);
    if (!template) return false;

    const maxStack = getMaxStackFromTemplate(template);
    let remaining = Math.max(0, Math.floor(amount));

    for (let i = 0; i < container.size && remaining > 0; i++) {
        const s = container.getItem(i);
        if (!s || !stackCanMergeWhenBuying(s, it)) continue;
        if (s.amount >= maxStack) continue;

        const add = Math.min(maxStack - s.amount, remaining);
        s.amount += add;
        container.setItem(i, s);
        remaining -= add;
    }

    for (let i = 0; i < container.size && remaining > 0; i++) {
        if (container.getItem(i)) continue;

        const stackSize = Math.min(maxStack, remaining);
        const newStack = templateToStack(template, stackSize);
        if (!newStack) return false;

        container.setItem(i, newStack);
        remaining -= stackSize;
    }

    return remaining === 0;
}

function countShopItems(container, it) {
    let count = 0;

    for (let i = 0; i < container.size; i++) {
        const s = container.getItem(i);
        if (stackMatchesShopItem(s, it)) count += s.amount;
    }

    return count;
}

function removeShopItems(container, it, amount) {
    let remaining = Math.max(0, Math.floor(amount));

    for (let i = 0; i < container.size && remaining > 0; i++) {
        const s = container.getItem(i);
        if (!s || !stackMatchesShopItem(s, it)) continue;

        if (s.amount > remaining) {
            s.amount -= remaining;
            container.setItem(i, s);
            remaining = 0;
        } else {
            remaining -= s.amount;

            try {
                if (typeof container.clearItem === "function") container.clearItem(i);
                else container.setItem(i, undefined);
            } catch {
                try {
                    container.setItem(i, null);
                } catch {}
            }
        }
    }

    return amount - remaining;
}

// =========================================================
// Display Helpers
// =========================================================
function describeStack(stack) {
    if (!stack) return "§8Empty";

    const template = stackToTemplate(stack);
    const name = template?.nameTag ? `${template.nameTag} §8(${shortItemName(template.typeId)})` : shortItemName(stack.typeId);

    const bits = [];

    if (Array.isArray(template?.enchantments) && template.enchantments.length > 0) {
        bits.push(`§d${template.enchantments.length} ench`);
    }

    if (Array.isArray(template?.lore) && template.lore.length > 0) {
        bits.push(`§b${template.lore.length} lore`);
    }

    const extra = bits.length ? ` §8| ${bits.join(" §8| ")}` : "";
    return `§f${name} §8x${stack.amount}${extra}`;
}

function shopItemTitle(it) {
    const t = normalizeTemplate(it?.template);
    if (t?.nameTag) return t.nameTag;
    return niceIdName(it?.id);
}

function shopItemAdminTitle(it) {
    if (it?.template) {
        return `§d§lCustom §8${shopItemTitle(it)} §r§8(${it.id})`;
    }

    return `§8§l${it.id}`;
}

function formatItemLineAdmin(it) {
    const buyTxt = it.allowBuy ? `Buy: ${formatCents(it.buy)}` : "Buy: disabled";
    const sellTxt = it.allowSell ? `Sell: ${formatCents(it.sell)}` : "Sell: disabled";
    const exact = it.template ? " | Custom/exact item" : "";
    return `${buyTxt} | ${sellTxt}${exact}`;
}

function formatItemLinePlayer(it) {
    const buyTxt = it.allowBuy ? `§2Buy: ${formatCents(it.buy)}` : "§8Buy: disabled";
    const sellTxt = it.allowSell ? `§cSell: ${formatCents(it.sell)}` : "§8Sell: disabled";
    const exact = it.template ? " §dCustom" : "";
    return `${buyTxt} §8| ${sellTxt}${exact}`;
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

// =========================================================
// Sanitize Shop
// =========================================================
function sanitizeShop(shop) {
    const out = {
        v: 2,
        categories: Array.isArray(shop?.categories) ? shop.categories : [],
    };

    out.categories = out.categories
        .map((c) => {
            const name = String(c?.name ?? "").trim();

            return {
                name,
                icon: cleanTexturePath(c?.icon || guessCategoryIconByName(name), DEFAULT_CATEGORY_ICON),
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

// =========================================================
// Search
// =========================================================
function searchTokens(raw) {
    return String(raw ?? "")
        .toLowerCase()
        .replace(/^minecraft:/, "")
        .replace(/[_:\-]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
}

function buildSearchText(itemId, categoryName = "", it = null) {
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

function findItemInShop(shop, rawQuery) {
    const tokens = searchTokens(rawQuery);
    if (!tokens.length) return [];

    const matches = [];

    for (let ci = 0; ci < shop.categories.length; ci++) {
        const cat = shop.categories[ci];

        for (let ii = 0; ii < cat.items.length; ii++) {
            const it = cat.items[ii];
            const searchText = buildSearchText(it.id, cat.name, it);

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

// =========================================================
// Command registration
// =========================================================
export function registerShopCommand(customCommandRegistry) {
    customCommandRegistry.registerCommand(
        {
            name: `lilymoney:shop`,
            description: "Open the shop UI",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
            optionalParameters: [{ name: "item", type: CustomCommandParamType.String }],
        },
        (origin, itemQuery) => {
            const src = getCommandSource(origin);

            if (!(src instanceof Player)) {
                return {
                    status: CustomCommandStatus.Failure,
                    message: "Only players can open the shop.",
                };
            }

            system.run(() =>
                openShopEntry(src, itemQuery).catch((e) => {
                    console.warn(`[Shop] UI error: ${String(e)}\n${e?.stack ?? ""}`);
                }),
            );

            return { status: CustomCommandStatus.Success };
        },
    );

    try {
        world.beforeEvents.chatSend.subscribe((ev) => {
            if (!(ev.sender instanceof Player)) return;

            const msgText = String(ev.message ?? "").trim();

            if (msgText === "/shop" || msgText.startsWith("/shop ")) {
                ev.cancel = true;
                const arg = msgText.length > 5 ? msgText.slice(6) : "";

                system.run(() =>
                    openShopEntry(ev.sender, arg).catch((e) => {
                        console.warn(`[Shop] UI error: ${String(e)}\n${e?.stack ?? ""}`);
                    }),
                );
            }
        });
    } catch {}
}

// =========================================================
// Entry
// =========================================================
async function openShopEntry(player, itemQuery) {
    const shop = loadShop();

    if (!itemQuery || !String(itemQuery).trim()) {
        return openShopRoot(player);
    }

    const query = String(itemQuery ?? "").trim();
    const matches = findItemInShop(shop, query);

    if (matches.length === 0) {
        player.sendMessage("§r<§d§lLilys Money§r> §r" + `§cItem not found in shop: §f${itemQuery}`);
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

// =========================================================
// Player Shop UI
// =========================================================
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

        return openAdminMenu(player);
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

    if (admin && res.selection === 0) return openAdminMenu(player);

    const catIndex = admin ? res.selection - 1 : res.selection;
    if (catIndex < 0 || catIndex >= shop.categories.length) return;

    return openCategoryMenu(player, catIndex);
}

const DEFAULT_CATEGORY_ICON = "textures/ui/page";

function cleanTexturePath(raw, fallback = DEFAULT_ITEM_ICON) {
    const s = String(raw ?? "").trim();
    if (!s) return fallback;
    return s.replace(/\.png$/i, "");
}

function getCategoryIcon(cat) {
    return cleanTexturePath(cat?.icon || guessCategoryIconByName(cat?.name), DEFAULT_CATEGORY_ICON);
}

function getShopCategoryIconOptions() {
    return SHOP_CATEGORY_ICON_PRESETS.map((p) => p.name);
}

function getShopCategoryIconByPresetIndex(index) {
    const i = Math.floor(Number(index));
    return cleanTexturePath(SHOP_CATEGORY_ICON_PRESETS[i]?.texture, DEFAULT_CATEGORY_ICON);
}

function getShopCategoryIconPresetIndex(texture) {
    const clean = cleanTexturePath(texture, DEFAULT_CATEGORY_ICON);

    const index = SHOP_CATEGORY_ICON_PRESETS.findIndex((p) => cleanTexturePath(p.texture, DEFAULT_CATEGORY_ICON) === clean);

    return index >= 0 ? index : 0;
}

function getShopItemIcon(it) {
    return getItemIconFromShopItem(it);
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

async function askQuantity(player, title, min, max, defaultAmount = 1) {
    const minN = Math.max(1, Math.floor(Number(min) || 1));
    const maxN = Math.floor(Number(max));

    if (!Number.isFinite(maxN) || maxN < minN) {
        msg(player, "§cNo valid amount is available.");
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
        msg(player, `§cInvalid amount. Enter a whole number between ${minN}-${maxN}.`);
        return null;
    }

    const n = Math.floor(Number(raw));

    if (!Number.isFinite(n) || n < minN || n > maxN) {
        msg(player, `§cInvalid amount. Enter a whole number between ${minN}-${maxN}.`);
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

// =========================================================
// Buy / Sell
// =========================================================
async function flowBuy(player, it) {
    if (!it.allowBuy) return msg(player, "§cBuying is disabled for this item.");
    if (it.buy <= 0) return msg(player, "§cThis item has no buy price.");

    const template = getTemplateForShopItem(it);
    if (!template) return msg(player, `§cInvalid item in shop config: §f${it.id}`);

    const inv = getInventoryContainer(player);
    if (!inv) return msg(player, "§cNo inventory container.");

    const spaceLeft = getCapacityForShopItem(inv, it);
    if (spaceLeft <= 0) {
        return msg(player, "§cNot enough inventory space.");
    }

    const { dollarsObj, centsObj } = ensureMoneyObjectives();
    const bal = getBalanceCents(dollarsObj, centsObj, player);

    const affordable = getMaxAffordableAmount(bal, it.buy);
    if (affordable <= 0) {
        return msg(player, `§cNot enough money. You need at least §e${formatCents(it.buy)}§c.`);
    }

    const maxBuy = Math.min(MAX_TRADE_AMOUNT, spaceLeft, affordable);

    const qty = await askQuantity(player, "Buy Amount", 1, maxBuy, 1);
    if (!qty) return;

    const totalCost = it.buy * qty;
    if (!Number.isSafeInteger(totalCost)) return msg(player, "§cTotal cost is too large.");

    const confirmed = await confirmShopBuy(player, it, qty, totalCost, bal);
    if (!confirmed) return;

    // Re-check after the confirmation window because balance/inventory can change while the UI is open.
    const invNow = getInventoryContainer(player);
    if (!invNow) return msg(player, "§cNo inventory container.");

    const balNow = getBalanceCents(dollarsObj, centsObj, player);

    if (balNow < totalCost) {
        return msg(player, `§cNot enough money. Need §e${formatCents(totalCost)}§c but you have §e${formatCents(balNow)}§c.`);
    }

    if (!canFitExactShopItem(invNow, it, qty)) {
        return msg(player, "§cNot enough inventory space.");
    }

    if (!addExactShopItem(invNow, it, qty)) {
        return msg(player, "§cFailed to give items.");
    }

    const next = balNow - totalCost;

    setBalanceFromTotalCents(dollarsObj, centsObj, player, next);
    logMoneyEvent("SHOP_BUY", {
        player,
        itemId: it.id,
        itemName: shopItemTitle(it),
        quantity: qty,
        amountCents: totalCost,
        balanceAfter: next,
    });
    msg(player, `§2Bought §e${qty}§2 x §f${shopItemTitle(it)}§2 for §e${formatCents(totalCost)}§2. Balance: §e${formatCents(next)}§2.`);
    playMoneySound(player);
}

async function flowSell(player, it) {
    if (!it.allowSell) return msg(player, "§cSelling is disabled for this item.");

    const template = getTemplateForShopItem(it);
    if (!template) return msg(player, `§cInvalid item in shop config: §f${it.id}`);

    const inv = getInventoryContainer(player);
    if (!inv) return msg(player, "§cNo inventory container.");

    const have = countShopItems(inv, it);
    if (have <= 0) return msg(player, `§cYou have no §f${shopItemTitle(it)}§c to sell.`);

    const maxSell = Math.min(MAX_TRADE_AMOUNT, have);

    const qty = await askQuantity(player, "Sell Amount", 1, maxSell, 1);
    if (!qty) return;

    const totalPay = it.sell * qty;
    if (!Number.isSafeInteger(totalPay)) return msg(player, "§cTotal payout is too large.");

    const { dollarsObj, centsObj } = ensureMoneyObjectives();
    const bal = getBalanceCents(dollarsObj, centsObj, player);

    const confirmed = await confirmShopSell(player, it, qty, totalPay, bal);
    if (!confirmed) return;

    // Re-check after confirmation because inventory can change while the UI is open.
    const invNow = getInventoryContainer(player);
    if (!invNow) return msg(player, "§cNo inventory container.");

    const haveNow = countShopItems(invNow, it);
    if (haveNow < qty) {
        return msg(player, `§cYou do not have enough §f${shopItemTitle(it)}§c anymore.`);
    }

    const removed = removeShopItems(invNow, it, qty);
    if (removed < qty) return msg(player, "§cFailed to remove items.");

    const balNow = getBalanceCents(dollarsObj, centsObj, player);
    const next = balNow + totalPay;

    setBalanceFromTotalCents(dollarsObj, centsObj, player, next);
    logMoneyEvent("SHOP_SELL", {
        player,
        itemId: it.id,
        itemName: shopItemTitle(it),
        quantity: qty,
        amountCents: totalPay,
        balanceAfter: next,
    });
    msg(player, `§2Sold §e${qty}§2 x §f${shopItemTitle(it)}§2 for §e${formatCents(totalPay)}§2. Balance: §e${formatCents(next)}§2.`);
    playMoneySound(player);
}

// =========================================================
// Admin UI
// =========================================================
async function openAdminMenu(player) {
    const form = new ActionFormData()
        .title("§6§lShop Editor")
        .body("§8Manage categories and items.\n§8Changes save per-world.")
        .button("§2§lAdd Category", "textures/ui/color_plus")
        .button("§b§lManage Items", "textures/ui/editIcon")
        .button("§c§lRestore Default Shop", "textures/ui/refresh_light")
        .button("§4§lClear Shop (Empty)", "textures/ui/trash")
        .button("§8§lBack", "textures/ui/arrow_left");

    const res = await form.show(player);
    if (res.canceled) return;

    if (res.selection === 0) return openAddCategory(player);
    if (res.selection === 1) return openManageItems(player);
    if (res.selection === 2) return openResetShopConfirm(player);
    if (res.selection === 3) return openClearShopConfirm(player);

    return openShopRoot(player);
}

async function openClearShopConfirm(player) {
    const form = new ActionFormData()
        .title(shopConfirmTitle("§4§lClear Shop?"))
        .body("§cThis will remove ALL categories and items.\n§8The shop will become empty.\n\n§8This cannot be undone.")
        .button("§c§lCancel", "textures/ui/cancel")
        .button("§4§lClear Shop", "textures/ui/trash");

    const res = await form.show(player);
    if (res.canceled || res.selection === 0) return openAdminMenu(player);

    clearOldShopParts();

    const ok = saveShop({ v: 2, categories: [] });

    if (!ok) {
        msg(player, "§cFailed to clear shop (save error).");
        return openAdminMenu(player);
    }

    msg(player, "§aShop cleared (now empty).");
    return openAdminMenu(player);
}

async function openResetShopConfirm(player) {
    const form = new ActionFormData()
        .title(shopConfirmTitle("§c§lRestore Default Shop?"))
        .body("§cThis will restore the default shop.\n§8Your current categories/items will be overwritten.\n\n§8This cannot be undone.")
        .button("§c§lCancel", "textures/ui/cancel")
        .button("§c§lRestore Defaults", "textures/ui/refresh_light");

    const res = await form.show(player);
    if (res.canceled || res.selection === 0) return openAdminMenu(player);

    clearOldShopParts();

    const ok = saveShop(deepClone(DEFAULT_SHOP));

    if (!ok) {
        msg(player, "§cFailed to reset shop (save error).");
        return openAdminMenu(player);
    }

    msg(player, "§aShop reset to defaults.");
    return openAdminMenu(player);
}

async function openAddCategory(player) {
    const form = new ModalFormData()
        .title("Add Category")
        .textField("Category name", "ex: Blocks", { defaultValue: "" })
        .dropdown("Category icon", getShopCategoryIconOptions(), { defaultValueIndex: 0 });

    const res = await form.show(player);
    if (res.canceled) return openAdminMenu(player);

    const name = String(res.formValues?.[0] ?? "").trim();
    const icon = getShopCategoryIconByPresetIndex(res.formValues?.[1]);

    if (!name) {
        msg(player, "§cCategory name can't be empty.");
        return openAdminMenu(player);
    }

    const shop = loadShop();

    if (findCategoryIndex(shop, name) !== -1) {
        msg(player, "§cThat category already exists.");
        return openAdminMenu(player);
    }

    shop.categories.push({ name, icon, items: [] });
    SHOP_CACHE = shop;

    msg(player, `§aCategory created: §f${name}§a. Now add your first item.`);
    return openAddItem(player, shop.categories.length - 1);
}

async function openEditCategoryMeta(player, catIndex) {
    const shop = loadShop();
    const cat = shop.categories[catIndex];

    if (!cat) return openManageItems(player);

    const form = new ModalFormData()
        .title("Edit Category")
        .textField("Category name", "ex: Blocks", { defaultValue: cat.name })
        .dropdown("Category icon", getShopCategoryIconOptions(), {
            defaultValueIndex: getShopCategoryIconPresetIndex(cat.icon),
        });

    const res = await form.show(player);
    if (res.canceled) return openItemsInCategoryAdmin(player, catIndex);

    const name = String(res.formValues?.[0] ?? "").trim();
    const icon = getShopCategoryIconByPresetIndex(res.formValues?.[1]);

    if (!name) {
        msg(player, "§cCategory name can't be empty.");
        return openItemsInCategoryAdmin(player, catIndex);
    }

    const existing = findCategoryIndex(shop, name);
    if (existing !== -1 && existing !== catIndex) {
        msg(player, "§cThat category already exists.");
        return openItemsInCategoryAdmin(player, catIndex);
    }

    const before = deepClone(shop);

    cat.name = name;
    cat.icon = icon;

    if (!saveShop(shop)) {
        SHOP_CACHE = before;
        msg(player, "§cFailed to save category.");
        return openItemsInCategoryAdmin(player, catIndex);
    }

    msg(player, "§aCategory updated.");
    return openItemsInCategoryAdmin(player, catIndex);
}

async function openManageItems(player) {
    const shop = loadShop();

    if (shop.categories.length === 0) {
        msg(player, "§eNo categories yet. Add one first.");
        return openAdminMenu(player);
    }

    const form = new ActionFormData().title("Manage Items").body("§8Pick a category:").button("§8§lBack", "textures/ui/arrow_left");

    for (const c of shop.categories) {
        form.button(`§f§l${c.name} §r§8(${c.items.length})`, getCategoryIcon(c));
    }

    const res = await form.show(player);
    if (res.canceled || res.selection === 0) return openAdminMenu(player);

    const catIndex = res.selection - 1;
    if (catIndex < 0 || catIndex >= shop.categories.length) return openAdminMenu(player);

    return openItemsInCategoryAdmin(player, catIndex);
}

async function openItemsInCategoryAdmin(player, catIndex) {
    const shop = loadShop();
    const cat = shop.categories[catIndex];

    if (!cat) return openManageItems(player);

    const form = new ActionFormData()
        .title(`Items: ${cat.name}`)
        .body("§8Select an item to edit:")
        .button("§2§lAdd Item", "textures/ui/color_plus")
        .button("§e§lEdit Category", "textures/ui/editIcon")
        .button("§8§lBack", "textures/ui/arrow_left");

    for (const it of cat.items) {
        form.button(`${shopItemAdminTitle(it)}\n§r§8${formatItemLineAdmin(it)}`, getShopItemIcon(it));
    }

    const res = await form.show(player);
    if (res.canceled) return openManageItems(player);

    if (res.selection === 0) return openAddItem(player, catIndex);
    if (res.selection === 1) return openEditCategoryMeta(player, catIndex);
    if (res.selection === 2) return openManageItems(player);

    const itemIndex = res.selection - 3;
    if (itemIndex < 0 || itemIndex >= cat.items.length) return openItemsInCategoryAdmin(player, catIndex);

    return openItemAdminActions(player, catIndex, itemIndex);
}

async function openAddItem(player, catIndex) {
    const form = new ActionFormData()
        .title("Add Item")
        .body("§8How do you want to add this item?")
        .button("§2§lType item ID", "textures/items/book_writable")
        .button("§d§lSelect exact item from hotbar", "textures/ui/icon_recipe_equipment")
        .button("§8§lBack", "textures/ui/arrow_left");

    const res = await form.show(player);
    if (res.canceled) return openItemsInCategoryAdmin(player, catIndex);

    if (res.selection === 0) return openAddItemById(player, catIndex);
    if (res.selection === 1) return openSelectHotbarItem(player, catIndex);

    return openItemsInCategoryAdmin(player, catIndex);
}

async function openAddItemById(player, catIndex) {
    const shop = loadShop();
    const cat = shop.categories[catIndex];

    if (!cat) return openAdminMenu(player);

    const form = new ModalFormData()
        .title(`Add Item to ${cat.name}`)
        .textField("Item id", "ex: minecraft:diamond", { defaultValue: "minecraft:diamond" })
        .textField("Custom name (optional)", "ex: §bCool Sword", { defaultValue: "" })
        .textField("Enchantments (optional)", "ex: sharpness:5, unbreaking:3", { defaultValue: "" })
        .textField("Buy price (each)", "ex: 1.50", { defaultValue: "1.00" })
        .textField("Sell price (each)", "ex: 0.50", { defaultValue: "0.50" })
        .toggle("Allow Buy", { defaultValue: true })
        .toggle("Allow Sell", { defaultValue: true });

    const res = await form.show(player);
    if (res.canceled) return openItemsInCategoryAdmin(player, catIndex);

    const itemId = normalizeItemId(res.formValues?.[0]);

    if (!itemId) {
        return msg(player, "§cInvalid item id.") || openItemsInCategoryAdmin(player, catIndex);
    }

    const customName = String(res.formValues?.[1] ?? "").trim();
    const requestedEnchants = parseEnchantmentsText(res.formValues?.[2]);

    const buyParsed = parseUiMoneyToCents(res.formValues?.[3], false);
    const sellParsed = parseUiMoneyToCents(res.formValues?.[4], false);

    if (!buyParsed.ok || !sellParsed.ok) {
        return msg(player, "§cInvalid price (max 2 decimals).") || openItemsInCategoryAdmin(player, catIndex);
    }

    const allowBuy = !!res.formValues?.[5];
    const allowSell = !!res.formValues?.[6];

    const template = manualTemplateForItem(itemId, customName, requestedEnchants);
    const useTemplate = template && templateHasCustomData(template);

    if (!useTemplate) {
        const exists = findNormalItemGlobal(shop, itemId);

        if (exists) {
            return (
                msg(player, "§cThat normal item already exists in the shop. Edit + move instead.") ||
                openItemsInCategoryAdmin(player, catIndex)
            );
        }
    } else {
        const exists = findTemplateGlobal(shop, templateKey(template));

        if (exists) {
            return msg(player, "§cThat custom item already exists in the shop.") || openItemsInCategoryAdmin(player, catIndex);
        }
    }

    const before = deepClone(shop);

    const itemObj = {
        id: itemId,
        buy: allowBuy ? Math.max(0, buyParsed.cents) : 0,
        sell: allowSell ? Math.max(0, sellParsed.cents) : 0,
        allowBuy,
        allowSell,
    };

    if (useTemplate) itemObj.template = template;

    cat.items.push(itemObj);

    if (!saveShop(shop)) {
        SHOP_CACHE = before;
        msg(player, "§cFailed to save shop data (save error).");
        return openItemsInCategoryAdmin(player, catIndex);
    }

    msg(player, `§aAdded §f${shopItemTitle(itemObj)}§a to §f${cat.name}§a.`);
    return openItemsInCategoryAdmin(player, catIndex);
}

async function openSelectHotbarItem(player, catIndex) {
    const inv = getInventoryContainer(player);

    if (!inv) {
        msg(player, "§cNo inventory container.");
        return openItemsInCategoryAdmin(player, catIndex);
    }

    const form = new ActionFormData()
        .title("Select Hotbar Item")
        .body(
            "§8Pick the hotbar slot to copy into the shop.\n§8This stores name, lore, enchants, durability, tags, and custom data.\n§cFilled shulker boxes are not supported.",
        );

    for (let i = 0; i < 9; i++) {
        const s = inv.getItem(i);
        form.button(`§f§lSlot ${i + 1}\n§r${describeStack(s)}`, getStackIcon(s));
    }

    form.button("§8§lBack", "textures/ui/arrow_left");

    const res = await form.show(player);
    if (res.canceled) return openAddItem(player, catIndex);
    if (res.selection === 9) return openAddItem(player, catIndex);

    const picked = inv.getItem(res.selection);

    if (!picked) {
        msg(player, "§cThat hotbar slot is empty.");
        return openSelectHotbarItem(player, catIndex);
    }

    return openAddExactItemDetails(player, catIndex, picked);
}

async function openAddExactItemDetails(player, catIndex, sourceStack) {
    const shop = loadShop();
    const cat = shop.categories[catIndex];

    if (!cat) return openAdminMenu(player);

    if (isShulkerBoxId(sourceStack?.typeId)) {
        msg(player, "§cExact shulker boxes are not supported because Bedrock hides their contents from scripts.");
        return openItemsInCategoryAdmin(player, catIndex);
    }

    const template = stackToTemplate(sourceStack);

    if (!template) {
        msg(player, "§cCould not copy that item.");
        return openItemsInCategoryAdmin(player, catIndex);
    }

    const itemName = template.nameTag || shortItemName(template.typeId);

    const form = new ModalFormData()
        .title("Add Exact Item")
        .textField("Buy price (each)", "ex: 10.50", { defaultValue: "1.00" })
        .textField("Sell price (each)", "ex: 5.25", { defaultValue: "0.50" })
        .toggle("Allow Buy", { defaultValue: true })
        .toggle("Allow Sell", { defaultValue: true });

    const res = await form.show(player);
    if (res.canceled) return openItemsInCategoryAdmin(player, catIndex);

    const buyParsed = parseUiMoneyToCents(res.formValues?.[0], false);
    const sellParsed = parseUiMoneyToCents(res.formValues?.[1], false);

    if (!buyParsed.ok || !sellParsed.ok) {
        msg(player, "§cInvalid price (max 2 decimals).");
        return openItemsInCategoryAdmin(player, catIndex);
    }

    const allowBuy = !!res.formValues?.[2];
    const allowSell = !!res.formValues?.[3];

    const key = templateKey(template);
    const exists = findTemplateGlobal(shop, key);

    if (exists) {
        msg(player, "§cThat exact custom item is already in the shop.");
        return openItemsInCategoryAdmin(player, catIndex);
    }

    const before = deepClone(shop);

    cat.items.push({
        id: template.typeId,
        template,
        buy: allowBuy ? Math.max(0, buyParsed.cents) : 0,
        sell: allowSell ? Math.max(0, sellParsed.cents) : 0,
        allowBuy,
        allowSell,
    });

    if (!saveShop(shop)) {
        SHOP_CACHE = before;
        msg(player, "§cFailed to save custom item (save error). This item may have too much saved data.");
        return openItemsInCategoryAdmin(player, catIndex);
    }

    msg(player, `§aAdded exact item: §f${itemName}§a.`);
    return openItemsInCategoryAdmin(player, catIndex);
}

async function openItemAdminActions(player, catIndex, itemIndex) {
    const shop = loadShop();
    const cat = shop.categories[catIndex];
    const it = cat?.items?.[itemIndex];

    if (!cat || !it) return openItemsInCategoryAdmin(player, catIndex);

    const form = new ActionFormData()
        .title(`Edit: ${shopItemTitle(it)}`)
        .body(`§8${cat.name}\n§8${formatItemLineAdmin(it)}\n${it.template ? "§dCustom/exact item" : ""}`)
        .button("§e§lEdit / Move", "textures/ui/editIcon")
        .button("§c§lRemove Item", "textures/ui/trash")
        .button("§8§lBack", "textures/ui/arrow_left");

    const res = await form.show(player);
    if (res.canceled) return openItemsInCategoryAdmin(player, catIndex);

    if (res.selection === 0) return openItemEditModal(player, catIndex, itemIndex);
    if (res.selection === 1) return openRemoveItemConfirm(player, catIndex, itemIndex);

    return openItemsInCategoryAdmin(player, catIndex);
}

async function openItemEditModal(player, catIndex, itemIndex) {
    const shop = loadShop();
    const cat = shop.categories[catIndex];
    const it = cat?.items?.[itemIndex];

    if (!cat || !it) return openItemsInCategoryAdmin(player, catIndex);

    const catNames = shop.categories.map((c) => c.name);
    const oldTemplate = normalizeTemplate(it.template);
    const isExact = !!oldTemplate;

    const customNameDefault = oldTemplate?.nameTag ?? "";
    const enchantsDefault = enchantmentsToText(oldTemplate?.enchantments ?? []);

    const form = new ModalFormData()
        .title("Edit Item")
        .textField(isExact ? "Item id (locked for custom/exact items)" : "Item id", "minecraft:diamond", { defaultValue: it.id })
        .textField("Custom name (optional)", "ex: §bCool Sword", { defaultValue: customNameDefault })
        .textField("Enchantments (optional)", "ex: sharpness:5, unbreaking:3", { defaultValue: enchantsDefault })
        .textField("Buy price (each)", "ex: 1.50", { defaultValue: String(it.buy / 100) })
        .textField("Sell price (each)", "ex: 0.50", { defaultValue: String(it.sell / 100) })
        .toggle("Allow Buy", { defaultValue: !!it.allowBuy })
        .toggle("Allow Sell", { defaultValue: !!it.allowSell })
        .dropdown("Category", catNames, { defaultValueIndex: Math.max(0, catIndex) });

    const res = await form.show(player);
    if (res.canceled) return openItemAdminActions(player, catIndex, itemIndex);

    const newItemId = isExact ? oldTemplate?.typeId : normalizeItemId(res.formValues?.[0]);

    if (!newItemId) {
        return msg(player, "§cInvalid item id.") || openItemAdminActions(player, catIndex, itemIndex);
    }

    const customName = String(res.formValues?.[1] ?? "").trim();
    const requestedEnchants = parseEnchantmentsText(res.formValues?.[2]);

    const buyParsed = parseUiMoneyToCents(res.formValues?.[3], false);
    const sellParsed = parseUiMoneyToCents(res.formValues?.[4], false);

    if (!buyParsed.ok || !sellParsed.ok) {
        return msg(player, "§cInvalid price (max 2 decimals).") || openItemAdminActions(player, catIndex, itemIndex);
    }

    const allowBuy = !!res.formValues?.[5];
    const allowSell = !!res.formValues?.[6];
    const newCatIndex = Number(res.formValues?.[7]);

    const nextTemplate = manualTemplateForItem(newItemId, customName, requestedEnchants, oldTemplate);
    const useTemplate = nextTemplate && templateHasCustomData(nextTemplate);

    if (!useTemplate) {
        const existing = findNormalItemGlobal(shop, newItemId);

        if (existing && !(existing.ci === catIndex && existing.ii === itemIndex)) {
            msg(player, "§cAnother normal item with that id already exists in the shop.");
            return openItemAdminActions(player, catIndex, itemIndex);
        }
    } else {
        const existing = findTemplateGlobal(shop, templateKey(nextTemplate), { ci: catIndex, ii: itemIndex });

        if (existing) {
            msg(player, "§cAnother custom item with the same data already exists in the shop.");
            return openItemAdminActions(player, catIndex, itemIndex);
        }
    }

    const updated = {
        id: newItemId,
        buy: allowBuy ? Math.max(0, buyParsed.cents) : 0,
        sell: allowSell ? Math.max(0, sellParsed.cents) : 0,
        allowBuy,
        allowSell,
    };

    if (useTemplate) updated.template = nextTemplate;

    const before = deepClone(shop);

    cat.items.splice(itemIndex, 1);

    const targetCat = shop.categories[newCatIndex] ?? shop.categories[catIndex];
    targetCat.items.push(updated);

    if (!saveShop(shop)) {
        SHOP_CACHE = before;
        msg(player, "§cFailed to save shop data (save error).");
        return openAdminMenu(player);
    }

    msg(player, "§aItem updated.");
    return openManageItems(player);
}

async function openRemoveItemConfirm(player, catIndex, itemIndex) {
    const shop = loadShop();
    const cat = shop.categories[catIndex];
    const it = cat?.items?.[itemIndex];

    if (!cat || !it) {
        return openItemsInCategoryAdmin(player, catIndex);
    }

    const form = new ActionFormData()
        .use8CrafterLayout("long")
        .title("§c§lRemove Item?")
        .body(`§cRemove §f${shopItemTitle(it)}§c from §f${cat.name}§c?\n\n` + "§8This cannot be undone.")
        .button("§c§lCancel", "textures/ui/cancel")
        .button("§c§lRemove Item", "textures/ui/trash");

    const res = await form.show(player);

    if (res.canceled || res.selection === 0) {
        return openItemAdminActions(player, catIndex, itemIndex);
    }

    const before = deepClone(shop);

    cat.items.splice(itemIndex, 1);

    if (!saveShop(shop)) {
        SHOP_CACHE = before;
        msg(player, "§cFailed to save shop data (save error).");
        return openAdminMenu(player);
    }

    msg(player, "§aItem removed.");
    return openManageItems(player);
}
