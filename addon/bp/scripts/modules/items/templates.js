import { stripColors, normalizeItemId, getItemType } from "./identifiers.js";
import { normalizeEnchantId, mergeEnchantments, getEnchantType } from "./enchantments.js";
import { ItemStack } from "@minecraft/server";

function isOldFakeEnchantLore(line) {
    const plain = stripColors(line).trim().toLowerCase();
    return plain.startsWith("enchant:");
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

export function normalizeTemplate(template) {
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

export function templateHasCustomData(template) {
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

export function stackToTemplate(stack) {
    if (!stack || isPotionItem(stack.typeId)) return null;

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
    } catch {
        return null;
    }
    try {
        template.lore = (stack.getLore?.() ?? []).map(String).filter((line) => !isOldFakeEnchantLore(line));
    } catch {
        return null;
    }
    try {
        template.canDestroy = stack.getCanDestroy?.() ?? [];
    } catch {
        return null;
    }
    try {
        template.canPlaceOn = stack.getCanPlaceOn?.() ?? [];
    } catch {
        return null;
    }
    try {
        template.keepOnDeath = stack.keepOnDeath === true;
    } catch {
        return null;
    }
    try {
        template.lockMode = stack.lockMode;
    } catch {
        return null;
    }

    try {
        const dura = stack.getComponent("minecraft:durability");
        if (dura && Number.isInteger(dura.damage) && dura.damage > 0) {
            template.durabilityDamage = dura.damage;
        }
    } catch {
        return null;
    }

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
    } catch {
        return null;
    }

    try {
        const ids = stack.getDynamicPropertyIds?.() ?? [];
        ids.sort((a, b) => String(a).localeCompare(String(b)));

        for (const id of ids) {
            const v = normalizeDynamicValue(stack.getDynamicProperty(id));
            if (v === undefined) return null;
            template.dynamicProperties[String(id)] = v;
        }
    } catch {
        return null;
    }

    return normalizeTemplate(template);
}

export function templateToStack(template, amount = 1) {
    const t = normalizeTemplate(template);
    if (!t || isPotionItem(t.typeId)) return null;

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

    const restored = stackToTemplate(stack);
    if (!restored) return null;
    if (t.lockMode === undefined && restored.lockMode === "none") restored.lockMode = undefined;
    return templateKey(restored) === templateKey(t) ? stack : null;
}

export function templateKey(template) {
    const t = normalizeTemplate(template);
    return t ? JSON.stringify(t) : "";
}

export function isPotionItem(id) {
    return ["minecraft:potion", "minecraft:splash_potion", "minecraft:lingering_potion"].includes(id);
}
