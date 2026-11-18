import test from "node:test";
import assert from "node:assert/strict";
import { commerceFixture } from "./commerceFixture.mjs";

async function auctionFixture(t) {
    const f = await commerceFixture(t);
    const { load, seller, ItemStack } = f;
    const trading = await load("scripts/modules/auction/trading.js");
    const { loadAh } = await load("scripts/modules/auction/storage.js");
    const { stackToTemplate } = await load("scripts/modules/items/templates.js");
    const stack = new ItemStack("minecraft:stone", 2);
    seller.inventory.setItem(0, stack);
    const list = () => trading.listAuctionFromSlot(seller, 0, stackToTemplate(stack), 2, 125);
    return { ...f, ...trading, loadAh, list };
}

test("offline auction sale credits cents, consumes the listing once and delivers one reconnect message", async (t) => {
    const f = await auctionFixture(t);
    assert.equal(f.list(), "mine");
    assert.equal(f.seller.inventory.getItem(0), undefined);
    f.buyAuction(f.buyer, "1");
    f.buyAuction(f.buyer, "1");
    assert.equal(f.balance(f.seller), 125);
    assert.equal(f.balance(f.buyer), 875);
    assert.equal(f.buyer.inventory.getItem(0).amount, 2);
    assert.equal(f.loadAh().auctions.length, 0);
    assert.equal(f.loadAh().soldMessages.length, 1);
    f.online.push(f.seller);
    f.world.afterEvents.playerSpawn.emit({ initialSpawn: true, player: f.seller });
    f.scheduled.pop()();
    assert.equal(f.loadAh().soldMessages.length, 0);
    assert.ok(f.seller.messages.some((text) => text.includes("Buyer")));
});

test("failed listing save returns original slot, including its complete stack", async (t) => {
    const f = await auctionFixture(t);
    f.world.setDynamicProperty = () => {
        throw Error("read only");
    };
    f.list();
    assert.equal(f.seller.inventory.getItem(0).amount, 2);
    assert.deepEqual(f.loadAh().auctions, []);
});
for (const failure of ["seller score", "inventory", "storage", "offline identity", "no money", "full inventory", "disconnect"]) {
    test("auction purchase with " + failure + " failure preserves listing, items and balances", async (t) => {
        const f = await auctionFixture(t);
        f.list();
        if (failure === "seller score") {
            const write = f.cents.setScore;
            f.cents.setScore = (id, n) => {
                if (id === f.seller.scoreboardIdentity) throw Error("score error");
                write(id, n);
            };
        }
        if (failure === "inventory")
            f.buyer.inventory.setItem = () => {
                throw Error("slot error");
            };
        if (failure === "storage")
            f.world.setDynamicProperty = () => {
                throw Error("write error");
            };
        if (failure === "offline identity") f.cents.getParticipants = f.dollars.getParticipants = () => [];
        if (failure === "no money") f.dollars.setScore(f.buyer.scoreboardIdentity, 0);
        if (failure === "full inventory") for (let i = 0; i < 3; i++) f.buyer.inventory.setItem(i, new f.ItemStack("minecraft:dirt", 64));
        if (failure === "disconnect") f.buyer.getComponent = () => undefined;
        const before = f.balance(f.buyer);
        f.buyAuction(f.buyer, "1");
        assert.equal(f.loadAh().auctions.length, 1);
        assert.equal(f.loadAh().soldMessages.length, 0);
        assert.equal(f.balance(f.seller), 0);
        assert.equal(f.balance(f.buyer), before);
        assert.equal(f.buyer.inventory.getItem(0)?.typeId, failure === "full inventory" ? "minecraft:dirt" : undefined);
    });
}
test("cancel and expired claim return an item only to its seller once", async (t) => {
    const f = await auctionFixture(t);
    f.list();
    f.cancelAuction(f.buyer, "1");
    f.cancelAuction(f.seller, "1");
    assert.equal(f.seller.inventory.getItem(0).amount, 2);
    f.list();
    const { advanceAhClock, AH_ACTIVE_TICKS, AH_CLOCK_INTERVAL_TICKS } = await f.load("scripts/modules/auction/clock.js");
    for (let tick = 0; tick < AH_ACTIVE_TICKS; tick += AH_CLOCK_INTERVAL_TICKS) advanceAhClock();
    const { processAhExpirations } = await f.load("scripts/modules/auction/listings.js");
    processAhExpirations();
    assert.equal(f.loadAh().auctions[0].status, "expired");
    f.buyAuction(f.buyer, "2");
    f.claimExpiredAuction(f.seller, "2");
    f.claimExpiredAuction(f.seller, "2");
    assert.equal(f.loadAh().auctions.length, 0);
    assert.equal(f.seller.inventory.getItem(0).amount, 2);
});

const offer = { id: "minecraft:stone", buy: 125, sell: 35, allowBuy: true, allowSell: true };
async function shopFixture(t) {
    const f = await commerceFixture(t);
    f.properties.set("lilymoney:shop_v2", JSON.stringify({ v: 2, categories: [{ name: "Test", items: [offer] }] }));
    const trade = await f.load("scripts/modules/shop/trading.js");
    function forms(qty, onConfirm = () => {}) {
        let count = 0;
        f.buyer.nextForm = () => {
            if (count++ === 0) return { formValues: [String(qty)] };
            onConfirm();
            return { selection: 1 };
        };
    }
    return { ...f, ...trade, forms };
}
test("shop purchase and ordinary type-ID sale use configured cent prices", async (t) => {
    const f = await shopFixture(t);
    f.forms(2);
    await f.flowBuy(f.buyer, offer);
    assert.equal(f.balance(f.buyer), 750);
    const stack = f.buyer.inventory.getItem(0);
    assert.equal(stack.amount, 2);
    stack.nameTag = "Custom";
    f.buyer.inventory.setItem(0, stack);
    f.forms(1);
    await f.flowSell(f.buyer, offer);
    assert.equal(f.balance(f.buyer), 785);
    assert.equal(f.buyer.inventory.getItem(0).amount, 1);
});
for (const reason of ["invalid quantity", "money changed", "inventory filled", "offer removed", "disconnect"]) {
    test("shop confirmation rejects " + reason, async (t) => {
        const f = await shopFixture(t);
        const store = await f.load("scripts/modules/shop/storage.js");
        f.forms(reason === "invalid quantity" ? "1.5" : 2, () => {
            if (reason === "money changed") f.dollars.setScore(f.buyer.scoreboardIdentity, 0);
            if (reason === "inventory filled")
                for (let i = 0; i < 3; i++) f.buyer.inventory.setItem(i, new f.ItemStack("minecraft:dirt", 64));
            if (reason === "offer removed") store.saveShop({ v: 2, categories: [] });
            if (reason === "disconnect") f.buyer.getComponent = () => undefined;
        });
        await f.flowBuy(f.buyer, offer);
        assert.equal(f.balance(f.buyer), reason === "money changed" ? 0 : 1000);
        assert.equal(f.buyer.inventory.getItem(0)?.typeId, reason === "inventory filled" ? "minecraft:dirt" : undefined);
    });
}
test("shop sale restores an earlier slot if removing a later slot fails", async (t) => {
    const f = await shopFixture(t);
    for (let i = 0; i < 2; i++) f.buyer.inventory.setItem(i, new f.ItemStack(offer.id, 1));
    const write = f.buyer.inventory.setItem;
    f.buyer.inventory.setItem = (i, v) => {
        if (i === 1) throw Error("locked slot");
        write(i, v);
    };
    f.forms(2);
    await f.flowSell(f.buyer, offer);
    assert.equal(f.balance(f.buyer), 1000);
    assert.equal(f.buyer.inventory.getItem(0).amount, 1);
    assert.equal(f.buyer.inventory.getItem(1).amount, 1);
});

test("quick listing rejects potions and shulker boxes before removing the stack", async (t) => {
    const f = await auctionFixture(t);
    for (const id of ["minecraft:potion", "minecraft:splash_potion", "minecraft:lingering_potion", "minecraft:red_shulker_box"]) {
        f.seller.inventory.setItem(0, new f.ItemStack(id));
        f.listAuctionFromSlot(f.seller, 0, { typeId: id }, 1, 125);
        assert.equal(f.seller.inventory.getItem(0).typeId, id);
        assert.equal(f.loadAh().auctions.length, 0);
    }
});

test("an old potion listing survives purchase, cancellation and expired collection cleanup", async (t) => {
    const f = await auctionFixture(t);
    const old = {
        id: "8",
        sellerIdentityId: "7",
        sellerName: "Seller",
        template: { typeId: "minecraft:potion" },
        amount: 1,
        price: 5,
        createdAt: 0,
        expiresAt: 1,
        collectUntil: 2,
        status: "active",
    };
    f.properties.set("lilymoney:ah_v1", JSON.stringify({ v: 1, nextId: 9, nextSoldMessageId: 1, auctions: [old], soldMessages: [] }));
    f.buyAuction(f.buyer, "8");
    f.cancelAuction(f.seller, "8");
    const clock = await f.load("scripts/modules/auction/clock.js");
    const { processAhExpirations } = await f.load("scripts/modules/auction/listings.js");
    clock.advanceAhClock();
    processAhExpirations();
    for (let i = 0; i <= clock.AH_EXPIRED_COLLECT_TICKS; i += clock.AH_CLOCK_INTERVAL_TICKS) clock.advanceAhClock();
    processAhExpirations();
    f.claimExpiredAuction(f.seller, "8");
    assert.equal(f.loadAh().auctions[0].id, "8");
    assert.equal(f.buyer.inventory.getItem(0), undefined);
    assert.equal(f.balance(f.buyer), 1000);
});
