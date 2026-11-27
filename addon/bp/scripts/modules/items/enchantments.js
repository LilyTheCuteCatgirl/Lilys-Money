import { shortItemName, getItemType } from "./identifiers.js";
import { EnchantmentTypes, ItemStack } from "@minecraft/server";

export function normalizeEnchantId(raw) {
    const s = String(raw ?? "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "_");

    if (!s) return "";

    return s.includes(":") ? s : `minecraft:${s}`;
}

export function parseEnchantmentsText(text) {
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

export function enchantmentsToText(enchantments) {
    if (!Array.isArray(enchantments) || enchantments.length === 0) return "";

    return enchantments.map((e) => `${shortItemName(e.id)}:${e.level}`).join(", ");
}

export function mergeEnchantments(a, b) {
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

export function getEnchantType(id) {
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

export function filterActuallyApplicableEnchantments(typeId, enchantments) {
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
                // Keep the enchantments the game accepts for this item type.
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
