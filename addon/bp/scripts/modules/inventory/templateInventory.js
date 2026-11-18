import { stackToTemplate, templateKey, templateToStack } from "../items/templates.js";

export function stackMatchesTemplate(stack, template) {
    if (!stack || !template) return false;
    const current = stackToTemplate(stack);
    return current !== null && templateKey(current) === templateKey(template);
}

export function getCapacityForTemplate(container, template) {
    const probe = templateToStack(template, 1);
    if (!probe) return 0;
    const restoredTemplate = stackToTemplate(probe);
    const stackLimit = probe.isStackable ? probe.maxAmount : 1;
    let capacity = 0;
    for (let i = 0; i < container.size; i++) {
        const stack = container.getItem(i);
        if (!stack) capacity += stackLimit;
        else if (stack.amount < stackLimit && stack.isStackableWith(probe) && stackMatchesTemplate(stack, restoredTemplate))
            capacity += stackLimit - stack.amount;
    }
    return capacity;
}

function writeTradeSlot(container, slot, next, onRollback) {
    const original = container.getItem(slot);
    container.setItem(slot, next);
    onRollback(() => container.setItem(slot, original));
}

export function addTemplateItems(container, template, amount, onRollback) {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Invalid item count.");
    const probe = templateToStack(template, 1);
    if (!probe) throw new Error("Item cannot be reconstructed.");
    const restoredTemplate = stackToTemplate(probe);
    const stackLimit = probe.isStackable ? probe.maxAmount : 1;
    let remaining = amount;
    for (let i = 0; i < container.size && remaining; i++) {
        const stack = container.getItem(i);
        if (!stack || stack.amount >= stackLimit || !stack.isStackableWith(probe) || !stackMatchesTemplate(stack, restoredTemplate))
            continue;
        const count = Math.min(remaining, stackLimit - stack.amount);
        const next = stack.clone();
        next.amount += count;
        writeTradeSlot(container, i, next, onRollback);
        remaining -= count;
    }
    for (let i = 0; i < container.size && remaining; i++) {
        if (container.getItem(i)) continue;
        const count = Math.min(stackLimit, remaining);
        const next = probe.clone();
        next.amount = count;
        writeTradeSlot(container, i, next, onRollback);
        remaining -= count;
    }
    if (remaining) throw new Error("Not enough inventory space.");
}

export function takeFromSlot(container, index, amount, onRollback) {
    const stack = container.getItem(index);
    if (!Number.isSafeInteger(amount) || amount <= 0 || !stack || stack.amount < amount) throw new Error("Slot changed.");
    if (stack.amount === amount) writeTradeSlot(container, index, undefined, onRollback);
    else {
        const next = stack.clone();
        next.amount -= amount;
        writeTradeSlot(container, index, next, onRollback);
    }
}
