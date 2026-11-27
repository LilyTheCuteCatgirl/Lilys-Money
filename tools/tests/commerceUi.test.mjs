import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { commerceFixture } from "./commerceFixture.mjs";

async function uiFixture(t) {
    const f = await commerceFixture(t);
    const ui = await f.load("node_modules/@minecraft/server-ui/index.js");
    const clean = (text) => text.replace(/§./g, "");

    for (const Type of [ui.ActionFormData, ui.ModalFormData]) {
        Type.prototype.title = function (text) {
            this.caption = clean(text);

            return this;
        };
        Type.prototype.body = function (text) {
            this.description = clean(text);

            return this;
        };
        Type.prototype.button = function (text, icon) {
            (this.buttons ??= []).push({ text: clean(text), icon });

            return this;
        };
        Type.prototype.show = function (player) {
            return player.nextForm(this);
        };
    }
    await f.load("scripts/modules/ui/8crafterUiAuto.js");
    async function walk(player, open, steps) {
        player.nextForm = (form) => {
            const step = steps.shift();
            assert.ok(step, "Unexpected form " + form.caption);
            const [title, choice, inspect] = step;
            assert.equal(form.caption, title);
            inspect?.(form);
            if (choice === undefined) return { canceled: true };
            if (Array.isArray(choice)) return { formValues: choice };

            const selection = form.buttons.findIndex((b) => b.text.split("\n")[0] === choice);
            assert.notEqual(selection, -1, `Missing ${choice} in ${title}`);

            return { selection };
        };
        await open();
        assert.equal(steps.length, 0);
    }

    return { ...f, walk };
}

test("Shop Back follows category, search query and single-result entry through item details", async (t) => {
    const f = await uiFixture(t);
    const item = (id) => ({ id: "minecraft:" + id, buy: 50, sell: 10, allowBuy: true, allowSell: true });
    f.properties.set(
        "lilymoney:shop_v2",
        JSON.stringify({ v: 2, categories: [{ name: "Blocks", items: [item("stone"), item("redstone")] }] }),
    );
    const { openShopEntry } = await f.load("scripts/modules/shop/ui.js");
    const open = (query, steps) => f.walk(f.buyer, () => openShopEntry(f.buyer, query), steps);
    await open("", [["Shop", "Blocks"], ["Shop - Blocks", "Stone"], ["Stone", "Back"], ["Shop - Blocks"]]);
    const results = (form) => {
        assert.match(form.description, /Matches for stone/);
        assert.equal(form.buttons.length, 3);
    };
    await open("stone", [
        ["Shop Search", "Stone", results],
        ["Stone", "Buy"],
        ["Buy Amount"],
        ["Stone", "Back"],
        ["Shop Search", undefined, results],
    ]);
    await open("redstone", [["Redstone", "Back"], ["Shop"]]);
});

for (const confirm of [true, false]) {
    test(`Auction listing and purchase from forms with confirmations ${confirm ? "on" : "off"}`, async (t) => {
        const f = await uiFixture(t);
        const { openAhEntry } = await f.load("scripts/modules/auction/ui.js");
        const { loadAh } = await f.load("scripts/modules/auction/storage.js");
        const { setMoneyPersonalDefaults } = await f.load("scripts/modules/players/preferences.js");
        setMoneyPersonalDefaults({ confirmAuctionBuy: !confirm, confirmAuctionList: !confirm });
        f.seller.getDynamicProperty = f.buyer.getDynamicProperty = () =>
            JSON.stringify({ confirmAuctionBuy: confirm, confirmAuctionList: confirm });
        f.seller.inventory.setItem(0, new f.ItemStack("minecraft:stone", 2));
        const my = ["Auction House", "My Items"];
        const sell = [
            "My AH Items",
            "Sell Item",
            (form) => {
                const icon = form.buttons.find((b) => b.text === "Sell Item").icon;
                assert.ok(existsSync(new URL("../../addon/rp/" + icon + ".png", import.meta.url)));
            },
        ];
        await f.walk(f.seller, () => openAhEntry(f.seller), [
            my,
            sell,
            ["Sell Item", "Back"],
            sell,
            ["Sell Item", "Slot 1"],
            ["Sell on AH", ["1.25"]],
            ...(confirm ? [["List Auction?", "List Item"]] : []),
            ["My AH Items", "Back"],
            ["Auction House", "Close"],
        ]);
        assert.equal(loadAh().auctions.length, 1);
        assert.equal(f.seller.inventory.getItem(0), undefined);
        await f.walk(f.seller, () => openAhEntry(f.seller), [
            my,
            ["My AH Items", "Stone x2"],
            ["Stone", "Cancel Listing"],
            ["Cancel Auction?", "Back"],
            ["Stone", "Back"],
            ["My AH Items", "Back"],
            ["Auction House", "Close"],
        ]);
        await f.walk(f.buyer, () => openAhEntry(f.buyer), [
            ["Auction House", "Stone x2"],
            ["Stone", "Buy"],
            ...(confirm ? [["Buy Auction?", "Buy"]] : []),
            ["Auction House", "Close"],
        ]);
        assert.equal(loadAh().auctions.length, 0);
        assert.equal(f.buyer.inventory.getItem(0).amount, 2);
        assert.equal(f.balance(f.buyer), 875);
        assert.equal(f.balance(f.seller), 125);
    });
}

test("Auction results keep listing details with zero, one and many enchantments, and My Items retains its page after Sell", async (t) => {
    const f = await uiFixture(t);
    const { openAhEntry } = await f.load("scripts/modules/auction/ui.js");
    const { saveAh } = await f.load("scripts/modules/auction/storage.js");
    const auctions = Array.from({ length: 21 }, (_, i) => ({
        id: String(i + 1),
        createdAt: i,
        sellerIdentityId: "7",
        sellerName: "Seller",
        amount: 1,
        price: 125,
        template: {
            typeId: i === 20 ? "minecraft:enchanted_book" : i === 19 ? "minecraft:diamond_sword" : "minecraft:stone",
            enchantments: ["mending", "sharpness", "unbreaking"]
                .slice(0, i === 20 ? 3 : i === 19 ? 1 : 0)
                .map((id) => ({ id: "minecraft:" + id, level: 1 })),
        },
    }));
    saveAh({ v: 1, nextId: 22, nextSoldMessageId: 1, auctions, soldMessages: [] });
    const inspect = (form) => {
        const labels = form.buttons.slice(1, 4).map((b) => b.text);
        assert.deepEqual(labels, [
            "Enchanted Book x1 Mending I +2 more\n$1.25 | Seller",
            "Diamond Sword x1 Mending I\n$1.25 | Seller",
            "Stone x1\n$1.25 | Seller",
        ]);
    };
    await f.walk(f.seller, () => openAhEntry(f.seller), [
        ["Auction House", "My Items", inspect],
        ["My AH Items", "Next Page"],
        ["My AH Items", "Sell Item"],
        ["Sell Item", "Back"],
        ["My AH Items", "Previous Page", (form) => assert.match(form.description, /Page 2\/2/)],
        ["My AH Items", "Back"],
        ["Auction House", "Close"],
    ]);
});
