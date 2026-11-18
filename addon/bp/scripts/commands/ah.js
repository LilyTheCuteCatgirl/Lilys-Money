// BP/scripts/commands/ah.js
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
import { ensureMoneyObjectives, getBalanceCents, setBalanceFromTotalCents } from "../modules/economy/balance.js";
import { parseFloatToCents, formatCents } from "../modules/economy/formatting.js";
import { getCommandSource } from "../modules/commandSource.js";
import { getInventoryContainer } from "../modules/inventory/items.js";
import { playMoneySound } from "../modules/players/preferences.js";

import { logMoneyEvent } from "../modules/logging/moneylogging.js";

import { getItemIconFromAuction, getStackIcon } from "../modules/ui/itemIcons.js";

// =========================================================
// AH SETTINGS
// These stay here for now so later we can move them into /moneysettings.
// =========================================================
const AH_PAGE_SIZE = Math.max(1, Math.floor(Number(CONFIG.AH_PAGE_SIZE ?? 20)));
const AH_MAX_ACTIVE_PER_PLAYER = Math.max(1, Math.floor(Number(CONFIG.AH_MAX_ACTIVE_PER_PLAYER ?? 20)));
const AH_MAX_EXPIRED_PER_PLAYER = Math.max(1, Math.floor(Number(CONFIG.AH_MAX_EXPIRED_PER_PLAYER ?? 20)));
const AH_ACTIVE_DAYS = Math.max(1, Math.floor(Number(CONFIG.AH_ACTIVE_DAYS ?? 30)));
const AH_EXPIRED_COLLECT_DAYS = Math.max(1, Math.floor(Number(CONFIG.AH_EXPIRED_COLLECT_DAYS ?? 100)));
const AH_MAX_PRICE_CENTS = 2147483647 * 100 + 99;

const TICKS_PER_DAY = 20 * 60 * 60 * 24;
const AH_ACTIVE_TICKS = AH_ACTIVE_DAYS * TICKS_PER_DAY;
const AH_EXPIRED_COLLECT_TICKS = AH_EXPIRED_COLLECT_DAYS * TICKS_PER_DAY;

const AH_DP_BASE = `lilymoney:ah_v1`;
const AH_DP_META = `${AH_DP_BASE}:meta`;
const AH_DP_PART = (i) => `${AH_DP_BASE}:part_${i}`;
const AH_CLOCK_DP_KEY = `${AH_DP_BASE}:clock_ticks`;

const AH_DP_MAX_CHARS = 32767;
const AH_CHUNK_SIZE = 30000;

let AH_CACHE = null;
let AH_CLOCK_CACHE = null;

const AH_MAX_PENDING_SOLD_MESSAGES_PER_PLAYER = Math.max(1, Math.floor(Number(CONFIG.AH_MAX_PENDING_SOLD_MESSAGES_PER_PLAYER ?? 20)));

// =========================================================
// AH UI style
// =========================================================
const AH_FULLSCREEN_UI = "§a§n§d§e§x§d§b§_§f§u§l§l§s§c§r§e§e§n§_§l§o§n§g§_§f§o§r§m§r";

function ahTitle(text) {
    return `${AH_FULLSCREEN_UI}${text}`;
}

world.afterEvents.playerSpawn.subscribe((ev) => {
    if (!ev.initialSpawn) return;

    system.runTimeout(() => {
        try {
            deliverAhSoldMessagesForPlayer(ev.player);
        } catch {}
    }, 60);
});

// =========================================================
// Active-world clock
// This counts only while the world/scripts are running.
// =========================================================
function getAhNowTicks() {
    if (typeof AH_CLOCK_CACHE === "number") return AH_CLOCK_CACHE;

    try {
        const raw = world.getDynamicProperty(AH_CLOCK_DP_KEY);
        const n = Number(raw);
        AH_CLOCK_CACHE = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    } catch {
        AH_CLOCK_CACHE = 0;
    }

    return AH_CLOCK_CACHE;
}

function saveAhClock() {
    try {
        world.setDynamicProperty(AH_CLOCK_DP_KEY, getAhNowTicks());
    } catch {}
}

const AH_CLOCK_INTERVAL_TICKS = Math.max(1, Math.floor(Number(CONFIG.AH_CLOCK_INTERVAL_TICKS ?? 1200)));

system.runInterval(() => {
    AH_CLOCK_CACHE = getAhNowTicks() + AH_CLOCK_INTERVAL_TICKS;
    saveAhClock();

    // Heavy scan. Only runs once per AH clock interval.
    processAhExpirations();
}, AH_CLOCK_INTERVAL_TICKS);

// =========================================================
// Storage helpers
// =========================================================
function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function splitChunks(str, size) {
    const out = [];
    for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
    return out;
}

function readAhRawFromDP() {
    try {
        const metaRaw = world.getDynamicProperty(AH_DP_META);
        if (typeof metaRaw === "string" && metaRaw.length) {
            const meta = JSON.parse(metaRaw);
            const parts = Math.max(0, Math.floor(meta?.parts ?? 0));
            if (parts === 0) return "";

            if (parts > 0 && parts < 300) {
                let full = "";
                for (let i = 0; i < parts; i++) {
                    const part = world.getDynamicProperty(AH_DP_PART(i));
                    if (typeof part !== "string") return null;
                    full += part;
                }
                return full;
            }
        }
    } catch {}

    try {
        const legacy = world.getDynamicProperty(AH_DP_BASE);
        if (typeof legacy === "string" && legacy.length) return legacy;
    } catch {}

    return null;
}

function saveAh(ahObj) {
    try {
        const cleaned = sanitizeAh(ahObj);
        const json = JSON.stringify(cleaned);
        const parts = splitChunks(json, AH_CHUNK_SIZE);

        if (parts.some((p) => p.length > AH_DP_MAX_CHARS)) return false;

        let oldParts = 0;
        try {
            const oldMetaRaw = world.getDynamicProperty(AH_DP_META);
            if (typeof oldMetaRaw === "string" && oldMetaRaw.length) {
                const oldMeta = JSON.parse(oldMetaRaw);
                oldParts = Math.max(0, Math.floor(oldMeta?.parts ?? 0));
            }
        } catch {}

        for (let i = 0; i < parts.length; i++) {
            world.setDynamicProperty(AH_DP_PART(i), parts[i]);
        }

        for (let i = parts.length; i < oldParts; i++) {
            try {
                world.setDynamicProperty(AH_DP_PART(i), "");
            } catch {}
        }

        world.setDynamicProperty(AH_DP_META, JSON.stringify({ v: 1, parts: parts.length }));
        AH_CACHE = cleaned;
        return true;
    } catch (e) {
        console.warn(`[AH] saveAh error: ${String(e)}\n${e?.stack ?? ""}`);
        return false;
    }
}

function loadAh() {
    if (AH_CACHE) return AH_CACHE;

    try {
        const raw = readAhRawFromDP();

        if (raw === "") {
            AH_CACHE = {
                v: 1,
                nextId: 1,
                nextSoldMessageId: 1,
                auctions: [],
                soldMessages: [],
            };
            return AH_CACHE;
        }

        if (typeof raw === "string" && raw.length) {
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.auctions)) {
                AH_CACHE = sanitizeAh(parsed);
                return AH_CACHE;
            }
        }
    } catch (e) {
        console.warn(`[AH] loadAh parse error: ${String(e)}`);
    }

    AH_CACHE = {
        v: 1,
        nextId: 1,
        nextSoldMessageId: 1,
        auctions: [],
        soldMessages: [],
    };
    saveAh(AH_CACHE);
    return AH_CACHE;
}

function nextAuctionId(ah) {
    const n = Math.max(1, Math.floor(Number(ah.nextId ?? 1)));
    ah.nextId = n + 1;
    return String(n);
}

function sanitizeAh(ah) {
    const out = {
        v: 1,
        nextId: Math.max(1, Math.floor(Number(ah?.nextId ?? 1))),
        nextSoldMessageId: Math.max(1, Math.floor(Number(ah?.nextSoldMessageId ?? 1))),
        auctions: [],
        soldMessages: [],
    };

    const arr = Array.isArray(ah?.auctions) ? ah.auctions : [];

    for (const a of arr) {
        const template = normalizeTemplate(a?.template);
        if (!template) continue;

        const amount = Math.max(1, Math.min(255, Math.floor(Number(a?.amount ?? 1))));
        const price = Math.max(0, Math.min(AH_MAX_PRICE_CENTS, Math.floor(Number(a?.price ?? 0))));
        if (price <= 0) continue;

        const status = a?.status === "expired" ? "expired" : "active";
        const sellerIdentityId = String(a?.sellerIdentityId ?? "").trim();
        const sellerName = String(a?.sellerName ?? "Unknown").trim() || "Unknown";

        if (!sellerIdentityId) continue;

        out.auctions.push({
            id: String(a?.id ?? out.nextId++),
            sellerIdentityId,
            sellerName,
            template,
            amount,
            price,
            createdAt: Math.max(0, Math.floor(Number(a?.createdAt ?? getAhNowTicks()))),
            expiresAt: Math.max(0, Math.floor(Number(a?.expiresAt ?? getAhNowTicks() + AH_ACTIVE_TICKS))),
            collectUntil: Math.max(0, Math.floor(Number(a?.collectUntil ?? getAhNowTicks() + AH_ACTIVE_TICKS + AH_EXPIRED_COLLECT_TICKS))),
            status,
        });
    }

    const messages = Array.isArray(ah?.soldMessages) ? ah.soldMessages : [];

    for (const m of messages) {
        const sellerIdentityId = String(m?.sellerIdentityId ?? "").trim();
        if (!sellerIdentityId) continue;

        out.soldMessages.push({
            id: String(m?.id ?? out.nextSoldMessageId++),
            sellerIdentityId,
            buyerName: String(m?.buyerName ?? "Someone").trim() || "Someone",
            itemName: String(m?.itemName ?? "Unknown Item").trim() || "Unknown Item",
            amount: Math.max(1, Math.floor(Number(m?.amount ?? 1))),
            price: Math.max(0, Math.floor(Number(m?.price ?? 0))),
            createdAt: Math.max(0, Math.floor(Number(m?.createdAt ?? getAhNowTicks()))),
        });
    }

    return out;
}

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

function queueAhSoldMessage(ah, auction, buyerName) {
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

function deliverAhSoldMessagesForIdentity(identityId) {
    const seller = getOnlinePlayerByIdentityId(identityId);
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

    playMoneySound(seller);
    return true;
}

function deliverAhSoldMessagesForPlayer(player) {
    if (!(player instanceof Player)) return false;

    const id = getPlayerIdentityId(player);
    if (!id) return false;

    return deliverAhSoldMessagesForIdentity(id);
}

// =========================================================
// Basic helpers
// =========================================================
function msg(player, text) {
    try {
        player.sendMessage("§r<§d§lLilys Money§r> §r" + text);
    } catch {}
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
    return shortItemName(id)
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
    if (!s) return { ok: false, error: "Price cannot be empty." };

    const num = Number(s.replace(",", "."));
    if (!Number.isFinite(num)) return { ok: false, error: "Invalid number." };

    const parsed = parseFloatToCents(num, allowNegative);
    if (!parsed.ok) return parsed;
    if (parsed.cents <= 0) return { ok: false, error: "Price must be above $0.00." };
    if (parsed.cents > AH_MAX_PRICE_CENTS) return { ok: false, error: "Price is too large." };

    return parsed;
}

function getPlayerIdentityId(player) {
    try {
        return String(player?.scoreboardIdentity?.id ?? "");
    } catch {
        return "";
    }
}

function sameSeller(player, auction) {
    const pid = getPlayerIdentityId(player);
    return pid && pid === String(auction?.sellerIdentityId ?? "");
}

function isShulkerBoxId(id) {
    const s = String(id ?? "").toLowerCase();
    return s === "minecraft:shulker_box" || s.endsWith("_shulker_box");
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

// =========================================================
// Exact item templates
// =========================================================
function normalizeEnchantId(raw) {
    const s = String(raw ?? "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "_");
    if (!s) return "";
    return s.includes(":") ? s : `minecraft:${s}`;
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

function mergeEnchantments(a, b) {
    const map = new Map();

    for (const e of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
        const id = normalizeEnchantId(e?.id);
        const level = Math.floor(Number(e?.level ?? 1));
        if (!id || level <= 0) continue;
        map.set(id, { id, level: Math.min(32767, level) });
    }

    return [...map.values()].sort((x, y) => x.id.localeCompare(y.id));
}

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

function isOldFakeEnchantLore(line) {
    const plain = stripColors(line).trim().toLowerCase();
    return plain.startsWith("enchant:");
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
        .map((e) => ({ id: e.id, level: Math.min(32767, e.level) }))
        .sort((a, b) => a.id.localeCompare(b.id));

    const dyn = template.dynamicProperties && typeof template.dynamicProperties === "object" ? template.dynamicProperties : {};

    for (const key of Object.keys(dyn).sort((a, b) => a.localeCompare(b))) {
        const v = normalizeDynamicValue(dyn[key]);
        if (v !== undefined) out.dynamicProperties[key] = v;
    }

    return out;
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
                    ench.addEnchantment({ type: enchType, level: e.level });
                } catch {}
            }
        }
    } catch {}

    try {
        if (Array.isArray(t.lore) && t.lore.length) stack.setLore(t.lore);
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

function stackMatchesTemplate(stack, template) {
    if (!stack) return false;
    const current = stackToTemplate(stack);
    const wanted = normalizeTemplate(template);
    if (!current || !wanted) return false;
    return templateKey(current) === templateKey(wanted);
}

function getMaxStackFromTemplate(template) {
    const probe = templateToStack(template, 1);
    if (!probe) return 64;
    return Math.max(1, probe.maxAmount ?? 64);
}

function getCapacityForTemplate(container, template) {
    const t = normalizeTemplate(template);
    if (!t) return 0;

    const maxStack = getMaxStackFromTemplate(t);
    let capacity = 0;

    for (let i = 0; i < container.size; i++) {
        const s = container.getItem(i);

        if (!s) {
            capacity += maxStack;
            continue;
        }

        if (stackMatchesTemplate(s, t) && s.amount < maxStack) {
            capacity += maxStack - s.amount;
        }
    }

    return capacity;
}

function canFitTemplate(container, template, amount) {
    return getCapacityForTemplate(container, template) >= amount;
}

function addTemplateItems(container, template, amount) {
    const t = normalizeTemplate(template);
    if (!t) return false;

    const maxStack = getMaxStackFromTemplate(t);
    let remaining = Math.max(0, Math.floor(amount));

    for (let i = 0; i < container.size && remaining > 0; i++) {
        const s = container.getItem(i);
        if (!s || !stackMatchesTemplate(s, t)) continue;
        if (s.amount >= maxStack) continue;

        const add = Math.min(maxStack - s.amount, remaining);
        s.amount += add;
        container.setItem(i, s);
        remaining -= add;
    }

    for (let i = 0; i < container.size && remaining > 0; i++) {
        if (container.getItem(i)) continue;

        const stackSize = Math.min(maxStack, remaining);
        const newStack = templateToStack(t, stackSize);
        if (!newStack) return false;

        container.setItem(i, newStack);
        remaining -= stackSize;
    }

    return remaining === 0;
}

function removeFromSlot(container, slotIndex, template, amount) {
    const s = container.getItem(slotIndex);
    if (!s) return false;
    if (!stackMatchesTemplate(s, template)) return false;
    if (s.amount < amount) return false;

    if (s.amount > amount) {
        s.amount -= amount;
        container.setItem(slotIndex, s);
        return true;
    }

    try {
        if (typeof container.clearItem === "function") container.clearItem(slotIndex);
        else container.setItem(slotIndex, undefined);
    } catch {
        try {
            container.setItem(slotIndex, null);
        } catch {}
    }

    return true;
}

function getAuctionIcon(auctionOrTemplate) {
    return getItemIconFromAuction(auctionOrTemplate);
}

function auctionTitle(a) {
    const t = normalizeTemplate(a?.template);
    if (!t) return "Unknown Item";
    return t.nameTag || niceIdName(t.typeId);
}

function auctionButtonText(a, includeSeller = true) {
    const seller = includeSeller ? ` §8| §b${a.sellerName}` : "";

    return `§8§l${auctionTitle(a)} x${a.amount}\n` + `§r§d${formatCents(a.price)}${seller}`;
}

function buildAuctionDetailsBody(player, a) {
    const t = normalizeTemplate(a?.template);
    const lines = [];

    lines.push(`§8Item: §f${auctionTitle(a)} §lx${a.amount}`);
    lines.push(`§8Price: §e${formatCents(a.price)} §l(total)`);
    lines.push(`§8Seller: §f${a.sellerName}`);
    lines.push(`§8Status: ${a.status === "expired" ? "§cExpired" : "§2§lActive"}`);

    if (a.status === "active") lines.push(`§8Expires in: §f${daysLeftText(a.expiresAt)}`);
    if (a.status === "expired") lines.push(`§8Claim/delete in: §f${daysLeftText(a.collectUntil)}`);

    if (sameSeller(player, a)) lines.push("", "§2§lThis is your auction.");

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

// =========================================================
// Expiration / player listing limits
// =========================================================
function getPlayerAuctions(ah, player) {
    const id = getPlayerIdentityId(player);
    if (!id) return [];
    return ah.auctions.filter((a) => String(a.sellerIdentityId) === id);
}

function countActivePlayerAuctions(ah, player) {
    return getPlayerAuctions(ah, player).filter((a) => a.status === "active").length;
}

function enforceExpiredCapForSeller(ah, sellerIdentityId) {
    const expired = ah.auctions
        .filter((a) => a.status === "expired" && String(a.sellerIdentityId) === String(sellerIdentityId))
        .sort((a, b) => a.expiresAt - b.expiresAt);

    while (expired.length > AH_MAX_EXPIRED_PER_PLAYER) {
        const remove = expired.shift();
        const index = ah.auctions.findIndex((a) => a.id === remove.id);
        if (index !== -1) ah.auctions.splice(index, 1);
    }
}

function processAhExpirations() {
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
    ah.auctions = ah.auctions.filter((a) => a.status !== "expired" || now < a.collectUntil);
    if (ah.auctions.length !== beforeCount) changed = true;

    for (const id of touchedSellers) enforceExpiredCapForSeller(ah, id);

    if (changed) saveAh(ah);
}

// =========================================================
// Offline-safe money helpers
// =========================================================
function findParticipantByIdentityId(obj, identityId) {
    const id = String(identityId ?? "");
    if (!id || !obj?.getParticipants) return null;

    try {
        const parts = obj.getParticipants();
        for (const p of parts) {
            if (String(p?.id ?? "") === id) return p;
        }
    } catch {}

    return null;
}

function getScoreSafe(obj, target) {
    if (!obj || !target) return 0;
    try {
        const v = obj.getScore(target);
        return typeof v === "number" ? v : 0;
    } catch {
        return 0;
    }
}

function setBalanceForTarget(dollarsObj, centsObj, target, totalCents) {
    const min = -2147483647 * 100;
    const max = 2147483647 * 100 + 99;
    const total = Math.max(min, Math.min(max, Math.floor(Number(totalCents) || 0)));

    const dollars = Math.floor(total / 100);
    const cents = total - dollars * 100;

    try {
        dollarsObj.setScore(target, dollars);
    } catch {}
    try {
        centsObj.setScore(target, cents);
    } catch {}
}

function paySellerOfflineSafe(auction) {
    const { dollarsObj, centsObj } = ensureMoneyObjectives();
    if (!dollarsObj || !centsObj) return false;

    let target = findParticipantByIdentityId(dollarsObj, auction.sellerIdentityId);

    // If the seller is currently online but the objective did not return the participant, use the Player.
    if (!target) {
        for (const p of world.getAllPlayers()) {
            if (getPlayerIdentityId(p) === String(auction.sellerIdentityId)) {
                target = p;
                break;
            }
        }
    }

    // Last fallback. This may create a named scoreboard entry, but normally the identity participant exists.
    if (!target) target = String(auction.sellerName ?? "Unknown");

    const current = getScoreSafe(dollarsObj, target) * 100 + getScoreSafe(centsObj, target);
    setBalanceForTarget(dollarsObj, centsObj, target, current + auction.price);
    return true;
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

function searchAuctions(query) {
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

// =========================================================
// Command registration
// =========================================================
export function registerAhCommand(customCommandRegistry) {
    try {
        customCommandRegistry.registerEnum(`lilymoney:ah_action`, ["sell"]);
    } catch {}

    customCommandRegistry.registerCommand(
        {
            name: `lilymoney:ah`,
            description: "Open Lily's auction house",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
            optionalParameters: [
                { name: `lilymoney:ah_action`, type: CustomCommandParamType.Enum },
                { name: "price", type: CustomCommandParamType.Float },
            ],
        },
        (origin, action, price) => {
            const src = getCommandSource(origin);

            if (!(src instanceof Player)) {
                return {
                    status: CustomCommandStatus.Failure,
                    message: "Only players can use the auction house.",
                };
            }

            const args = [];

            if (action !== undefined && action !== null) {
                args.push(String(action));
            }

            if (price !== undefined && price !== null) {
                args.push(String(price));
            }

            system.run(() =>
                openAhEntry(src, args.join(" ")).catch((e) => {
                    console.warn(`[AH] UI error: ${String(e)}\n${e?.stack ?? ""}`);
                }),
            );

            return { status: CustomCommandStatus.Success };
        },
    );

    // Friendly aliases: /ah, /ah diamond sword, /ah sell 500
    try {
        world.beforeEvents.chatSend.subscribe((ev) => {
            if (!(ev.sender instanceof Player)) return;

            const msgText = String(ev.message ?? "").trim();

            if (msgText === "/ah" || msgText.startsWith("/ah ")) {
                ev.cancel = true;

                const arg = msgText.length > 3 ? msgText.slice(4).trim() : "";

                system.run(() =>
                    openAhEntry(ev.sender, arg).catch((e) => {
                        console.warn(`[AH] UI error: ${String(e)}\n${e?.stack ?? ""}`);
                    }),
                );
            }
        });
    } catch {}
}

// =========================================================
// Entry / browse
// =========================================================
async function openAhEntry(player, rawArg = "") {
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

function findAuctionById(id) {
    const ah = loadAh();
    return ah.auctions.find((a) => a.id === String(id)) ?? null;
}

async function openAuctionDetails(player, auctionId, back = { type: "browse", query: "", page: 0 }) {
    const a = findAuctionById(auctionId);
    if (!a) {
        msg(player, "§cThat auction no longer exists.");
        return openBack(player, back);
    }

    const own = sameSeller(player, a);

    const form = new ActionFormData().title(ahTitle(auctionTitle(a))).body(buildAuctionDetailsBody(player, a));

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
    if (chosen === "claim") return claimExpiredAuction(player, auctionId, back);

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
    if (res.canceled || res.selection === 0) return openAuctionDetails(player, auctionId, back);

    return buyAuction(player, auctionId, back);
}

async function buyAuction(player, auctionId, back) {
    const ah = loadAh();
    const index = ah.auctions.findIndex((a) => a.id === String(auctionId));
    const a = index >= 0 ? ah.auctions[index] : null;

    if (!a || a.status !== "active") {
        msg(player, "§cThat auction is no longer active.");
        return openBack(player, back);
    }

    if (sameSeller(player, a)) {
        msg(player, "§cYou cannot buy your own auction.");
        return openAuctionDetails(player, auctionId, back);
    }

    const inv = getInventoryContainer(player);
    if (!inv) return msg(player, "§cNo inventory container.");
    if (!canFitTemplate(inv, a.template, a.amount)) {
        msg(player, "§cYou do not have enough inventory space.");
        return openAuctionDetails(player, auctionId, back);
    }

    const { dollarsObj, centsObj } = ensureMoneyObjectives();
    const bal = getBalanceCents(dollarsObj, centsObj, player);
    if (bal < a.price) {
        msg(player, `§cNot enough money. Need §e${formatCents(a.price)}§c but you have §e${formatCents(bal)}§c.`);
        return openAuctionDetails(player, auctionId, back);
    }

    const before = deepClone(ah);

    queueAhSoldMessage(ah, a, player.name);

    ah.auctions.splice(index, 1);
    if (!saveAh(ah)) {
        AH_CACHE = before;
        msg(player, "§cFailed to save auction data.");
        return openAuctionDetails(player, auctionId, back);
    }

    if (!addTemplateItems(inv, a.template, a.amount)) {
        AH_CACHE = before;
        saveAh(before);
        msg(player, "§cFailed to give item. Auction restored.");
        return openAuctionDetails(player, auctionId, back);
    }

    setBalanceFromTotalCents(dollarsObj, centsObj, player, bal - a.price);
    paySellerOfflineSafe(a);

    logMoneyEvent("AH_BUY", {
        buyer: player,
        sellerIdentityId: a.sellerIdentityId,
        sellerName: a.sellerName,
        itemId: a?.template?.typeId ?? "",
        itemName: auctionTitle(a),
        quantity: a.amount,
        amountCents: a.price,
        buyerBalanceAfter: bal - a.price,
    });

    msg(
        player,
        `§2Bought §e${a.amount}§2 x §f${auctionTitle(a)}§2 for §e${formatCents(a.price)}§2. Balance: §e${formatCents(bal - a.price)}§2.`,
    );
    playMoneySound(player);

    // If the seller is online, this sends instantly.
    // If they are offline, the saved message stays queued until they reconnect.
    deliverAhSoldMessagesForIdentity(a.sellerIdentityId);

    return openBack(player, back);
}

// =========================================================
// My items / cancel / claim
// =========================================================
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
            `§lActive: §f${activeCount}/${AH_MAX_ACTIVE_PER_PLAYER} §l| Expired: §f${expiredCount}/${AH_MAX_EXPIRED_PER_PLAYER}\n§lPage ${page + 1}/${totalPages}`,
        );

    const actions = [];

    for (const a of shown) {
        const status = a.status === "active" ? `§2Active §8${daysLeftText(a.expiresAt)}` : `§cExpired §8${daysLeftText(a.collectUntil)}`;

        form.button(`§8§l${auctionTitle(a)} x${a.amount}\n§r${status} §8| §e${formatCents(a.price)}`, getAuctionIcon(a));

        actions.push({
            type: "view",
            id: a.id,
        });
    }
    // meow might have did an eror
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
    if (res.canceled) return openAhBrowse(player, "", 0);

    const action = actions[res.selection];
    if (!action || action.type === "back") return openAhBrowse(player, "", 0);
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

    return cancelAuction(player, auctionId, back);
}

async function cancelAuction(player, auctionId, back) {
    const ah = loadAh();
    const index = ah.auctions.findIndex((a) => a.id === String(auctionId));
    const a = index >= 0 ? ah.auctions[index] : null;

    if (!a || a.status !== "active" || !sameSeller(player, a)) return openBack(player, back);

    const inv = getInventoryContainer(player);
    if (!inv) return msg(player, "§cNo inventory container.");
    if (!canFitTemplate(inv, a.template, a.amount)) {
        msg(player, "§cYou need inventory space before cancelling this auction.");
        return openAuctionDetails(player, auctionId, back);
    }

    const before = deepClone(ah);
    ah.auctions.splice(index, 1);

    if (!saveAh(ah)) {
        AH_CACHE = before;
        msg(player, "§cFailed to save auction data.");
        return openAuctionDetails(player, auctionId, back);
    }

    if (!addTemplateItems(inv, a.template, a.amount)) {
        AH_CACHE = before;
        saveAh(before);
        msg(player, "§cFailed to return item. Auction restored.");
        return openAuctionDetails(player, auctionId, back);
    }

    msg(player, "§aAuction cancelled and item returned.");
    return openMyAhItems(player, back?.page ?? 0);
}

async function claimExpiredAuction(player, auctionId, back) {
    const ah = loadAh();
    const index = ah.auctions.findIndex((a) => a.id === String(auctionId));
    const a = index >= 0 ? ah.auctions[index] : null;

    if (!a || a.status !== "expired" || !sameSeller(player, a)) return openBack(player, back);

    const inv = getInventoryContainer(player);
    if (!inv) return msg(player, "§cNo inventory container.");
    if (!canFitTemplate(inv, a.template, a.amount)) {
        msg(player, "§cYou need inventory space to claim this item.");
        return openAuctionDetails(player, auctionId, back);
    }

    const before = deepClone(ah);
    ah.auctions.splice(index, 1);

    if (!saveAh(ah)) {
        AH_CACHE = before;
        msg(player, "§cFailed to save auction data.");
        return openAuctionDetails(player, auctionId, back);
    }

    if (!addTemplateItems(inv, a.template, a.amount)) {
        AH_CACHE = before;
        saveAh(before);
        msg(player, "§cFailed to return item. Auction restored.");
        return openAuctionDetails(player, auctionId, back);
    }

    msg(player, "§aExpired auction item claimed.");
    return openMyAhItems(player, back?.page ?? 0);
}

// =========================================================
// Selling
// =========================================================
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

async function openAhInventoryPicker(player) {
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
    if (res.canceled || res.selection === slots.length) return openAhBrowse(player, "", 0);

    const slot = slots[res.selection];
    const stack = inv.getItem(slot);
    if (!stack) {
        msg(player, "§cThat slot is empty now.");
        return openAhInventoryPicker(player);
    }

    return openAhSellHeld(player, slot, stack);
}

async function openAhSellHeld(player, slotIndex, sourceStack) {
    if (!sourceStack) return openAhInventoryPicker(player);

    if (isShulkerBoxId(sourceStack.typeId)) {
        msg(player, "§cAuction House does not support shulker boxes because Bedrock hides their contents from scripts.");
        return openAhBrowse(player, "", 0);
    }

    const template = stackToTemplate(sourceStack);
    if (!template) {
        msg(player, "§cCould not copy that item.");
        return openAhBrowse(player, "", 0);
    }

    const form = new ModalFormData().title("Sell on AH").textField("Total price", "ex: 500", { defaultValue: "1.00" });

    const res = await form.show(player);
    if (res.canceled) return openAhBrowse(player, "", 0);

    const parsed = parseUiMoneyToCents(res.formValues?.[0], false);
    if (!parsed.ok) {
        msg(player, `§c${parsed.error ?? "Invalid price."}`);
        return openAhBrowse(player, "", 0);
    }

    return openQuickSellConfirm(player, slotIndex, sourceStack, parsed.cents);
}

async function openQuickSellConfirm(player, slotIndex, sourceStack, priceCents) {
    const template = stackToTemplate(sourceStack);
    if (!template) return msg(player, "§cCould not copy that item.");

    const amount = Math.max(1, Math.floor(Number(sourceStack.amount ?? 1)));
    const itemName = template.nameTag || niceIdName(template.typeId);

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
    if (res.canceled || res.selection === 0) return openAhBrowse(player, "", 0);

    return listAuctionFromSlot(player, slotIndex, template, amount, priceCents);
}

async function listAuctionFromSlot(player, slotIndex, template, amount, priceCents) {
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
        return openAhBrowse(player, "", 0);
    }

    const now = getAhNowTicks();
    const before = deepClone(ah);

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

    if (!removeFromSlot(inv, slotIndex, template, amount)) {
        AH_CACHE = before;
        msg(player, "§cFailed to remove item from inventory.");
        return openAhBrowse(player, "", 0);
    }

    if (!saveAh(ah)) {
        AH_CACHE = before;
        saveAh(before);
        addTemplateItems(inv, template, amount);
        msg(player, "§cFailed to save auction data. Item returned if there was space.");
        return openAhBrowse(player, "", 0);
    }

    msg(player, `§aListed §e${amount}§a x §f${auctionTitle(auction)}§a for §e${formatCents(priceCents)}§a.`);
    return openMyAhItems(player, 0);
}
