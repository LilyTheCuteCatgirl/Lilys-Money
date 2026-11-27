import test from "node:test";
import assert from "node:assert/strict";
import { packFixture } from "./packFixture.mjs";

test("Shared item templates preserve the saved item template fields and canonical matching key", async (t) => {
    const { load } = await packFixture(t);
    const { stackToTemplate, templateToStack, templateKey } = await load("scripts/modules/items/templates.js");
    const template = {
        typeId: "minecraft:diamond_sword",
        nameTag: "Custom",
        lore: ["line"],
        canDestroy: ["minecraft:stone"],
        canPlaceOn: ["minecraft:dirt"],
        keepOnDeath: true,
        lockMode: "slot",
        durabilityDamage: 8,
        enchantments: [{ id: "minecraft:sharpness", level: 3 }],
        dynamicProperties: { count: 2, flag: true, label: "text", pos: { __type: "Vector3", x: 1, y: 2, z: 3 } },
    };
    const restored = templateToStack(template);
    assert.equal(restored.maxAmount, 1);
    assert.deepEqual(stackToTemplate(restored), template);
    assert.equal(templateKey(stackToTemplate(restored)), templateKey(template));
});

test("known potion variants and unreadable stack metadata are rejected", async (t) => {
    const { load } = await packFixture(t);
    const { ItemStack } = await load("node_modules/@minecraft/server/index.js");
    const { stackToTemplate, templateToStack } = await load("scripts/modules/items/templates.js");

    for (const typeId of ["minecraft:potion", "minecraft:splash_potion", "minecraft:lingering_potion"]) {
        assert.equal(stackToTemplate(new ItemStack(typeId)), null);
        assert.equal(templateToStack({ typeId }), null);
    }
    const source = new ItemStack("minecraft:stone");
    source.properties.hidden = { unsupported: 42 };
    assert.equal(stackToTemplate(source), null);
    source.getDynamicPropertyIds = () => {
        throw Error("unreadable");
    };
    assert.equal(stackToTemplate(source), null);
    const original = ItemStack.prototype.setLore;
    ItemStack.prototype.setLore = () => {
        throw Error("rejected");
    };
    try {
        assert.equal(templateToStack({ typeId: "minecraft:stone", lore: ["must survive"] }), null);
    } finally {
        ItemStack.prototype.setLore = original;
    }
});

test("capacity uses exact metadata and native stackability", async (t) => {
    const { load } = await packFixture(t);
    const { ItemStack } = await load("node_modules/@minecraft/server/index.js");
    const { stackToTemplate } = await load("scripts/modules/items/templates.js");
    const { getCapacityForTemplate, stackMatchesTemplate } = await load("scripts/modules/inventory/templateInventory.js");
    const a = new ItemStack("minecraft:stone", 62);
    const b = new ItemStack("minecraft:stone", 1);
    b.nameTag = "Private";
    const container = { size: 3, getItem: (i) => [a, b][i] };
    assert.equal(getCapacityForTemplate(container, stackToTemplate(a)), 66);
    assert.equal(getCapacityForTemplate(container, { typeId: a.typeId }), 66);
    assert.equal(getCapacityForTemplate(container, stackToTemplate(b)), 1);
    assert.equal(stackMatchesTemplate(a, stackToTemplate(b)), false);
});
