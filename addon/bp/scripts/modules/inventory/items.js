import { ItemTypes, ItemStack } from "@minecraft/server";

/* =========================================================
   INVENTORY HELPERS (prepared for buy/sell later)
========================================================= */
export function getInventoryContainer(player) {
    return player?.getComponent("minecraft:inventory")?.container ?? null;
}

export function getMaxStack(itemId) {
    const itemType = ItemTypes.get(itemId);
    if (!itemType) return 64;
    const probe = new ItemStack(itemType, 1);
    return Math.max(1, probe.maxAmount ?? 64);
}

export function getCapacityForItem(container, itemId) {
    const maxStack = getMaxStack(itemId);
    let capacity = 0;
    for (let i = 0; i < container.size; i++) {
        const s = container.getItem(i);
        if (!s) capacity += maxStack;
        else if (s.typeId === itemId && s.amount < maxStack) capacity += maxStack - s.amount;
    }
    return capacity;
}

export function canFitExact(container, itemId, amount) {
    return getCapacityForItem(container, itemId) >= amount;
}

export function addExactItems(container, itemId, amount) {
    const itemType = ItemTypes.get(itemId);
    if (!itemType) return false;

    const maxStack = getMaxStack(itemId);
    let remaining = amount;

    for (let i = 0; i < container.size && remaining > 0; i++) {
        const s = container.getItem(i);
        if (!s || s.typeId !== itemId) continue;
        if (s.amount >= maxStack) continue;

        const add = Math.min(maxStack - s.amount, remaining);
        s.amount += add;
        container.setItem(i, s);
        remaining -= add;
    }

    for (let i = 0; i < container.size && remaining > 0; i++) {
        const s = container.getItem(i);
        if (s) continue;

        const stackSize = Math.min(maxStack, remaining);
        container.setItem(i, new ItemStack(itemType, stackSize));
        remaining -= stackSize;
    }

    return remaining === 0;
}

export function countItems(container, itemId) {
    let count = 0;
    for (let i = 0; i < container.size; i++) {
        const s = container.getItem(i);
        if (s && s.typeId === itemId) count += s.amount;
    }
    return count;
}

export function removeItems(container, itemId, amount) {
    let remaining = amount;

    for (let i = 0; i < container.size && remaining > 0; i++) {
        const s = container.getItem(i);
        if (!s || s.typeId !== itemId) continue;

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
