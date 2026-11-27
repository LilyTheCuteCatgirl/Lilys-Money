import { formatCents } from "../../addon/bp/scripts/modules/economy/formatting.js";
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
    const read = await captureHud(f);
    f.forms(2);
    await f.flowSell(f.buyer, offer);
    assert.deepEqual(read(f.buyer), []);
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

async function captureHud(f) {
    const { syncMoneyHud } = await f.load("scripts/modules/hud/manager.js");
    const titles = new Map();

    for (const player of [f.buyer, f.seller]) {
        player.onScreenDisplay = {
            setTitle(text) {
                titles.set(player, text);
            },
        };
        syncMoneyHud(player);
    }

    return (player) => {
        for (const timer of f.intervals.values()) if (timer.ticks === 1) timer.callback();
        const [wallet, ...rows] = titles.get(player).split("\n");
        assert.equal(wallet.slice("~LM3:B§f§l".length).trim(), formatCents(f.balance(player)));

        return rows.map((row) => row.slice(1).replace(/~+$/, "").replace(/§./g, ""));
    };
}

test("shop receipts report actual buys and sells and survive the next poll", async (t) => {
    const f = await shopFixture(t);
    const read = await captureHud(f);
    f.forms(2);
    await f.flowBuy(f.buyer, offer);
    assert.deepEqual(read(f.buyer), ["Shop: bought 2 Stone -2.50"]);
    assert.match(f.buyer.messages.join(" "), /Bought .*\$2\.50/);
    f.forms(1);
    await f.flowSell(f.buyer, offer);
    f.system.currentTick += 20;
    assert.deepEqual(read(f.buyer), ["Shop: bought 2 Stone -2.50", "Shop: sold 1 Stone +0.35"]);
    assert.match(f.buyer.messages.join(" "), /Sold .*\$0\.35/);
});

test("auction cards appear for both players only after commit", async (t) => {
    const f = await auctionFixture(t);
    const read = await captureHud(f);
    f.online.push(f.buyer, f.seller);
    f.list();
    const write = f.world.setDynamicProperty;
    f.world.setDynamicProperty = () => {
        throw Error("storage unavailable");
    };
    f.buyAuction(f.buyer, "1");
    assert.deepEqual(read(f.buyer), []);
    assert.deepEqual(read(f.seller), []);
    f.world.setDynamicProperty = write;
    f.buyAuction(f.buyer, "1");
    f.system.currentTick += 20;
    assert.deepEqual(read(f.buyer), ["Auction: bought Stone -1.25"]);
    assert.deepEqual(read(f.seller), ["Auction: sold Stone +1.25"]);
    assert.match(f.buyer.messages.join(" "), /Bought .*\$1\.25/);
    assert.match(f.seller.messages.join(" "), /bought your .*\$1\.25/);
});

test("pay checks funds and posts one signed receipt for each party", async (t) => {
    const f = await commerceFixture(t);
    const read = await captureHud(f);
    const { registerPayCommand } = await f.load("scripts/commands/pay.js");
    let pay;
    registerPayCommand({
        registerCommand(_def, callback) {
            pay = callback;
        },
    });
    pay({ sourceEntity: f.buyer }, [f.seller], 100);
    f.scheduled.pop()();
    assert.deepEqual(read(f.buyer), []);
    assert.deepEqual(read(f.seller), []);
    pay({ sourceEntity: f.buyer }, [f.seller], 1.25);
    f.scheduled.pop()();
    f.system.currentTick += 20;
    assert.deepEqual(read(f.buyer), ["Paid Seller -1.25"]);
    assert.deepEqual(read(f.seller), ["Received from Buyer +1.25"]);
    assert.match(f.buyer.messages.join(" "), /Paid .*Seller/);
    assert.match(f.seller.messages.join(" "), /received .*Buyer/);
});

async function command(f, module, register, origin, ...args) {
    let callback;
    (await f.load("scripts/commands/" + module + ".js"))[register]({
        registerCommand(_def, fn) {
            callback = fn;
        },
    });
    callback(origin, ...args);
    f.scheduled.pop()();
}

test("command-block adjustments use the actual signed change including unchanged and capped balances", async (t) => {
    const f = await commerceFixture(t);
    const read = await captureHud(f);
    const origin = { sourceBlock: {} };
    const target = [f.buyer];
    await command(f, "setmoney", "registerSetMoneyCommand", origin, target, -2);
    await command(f, "setmoney", "registerSetMoneyCommand", origin, target, -2);
    await command(f, "addmoney", "registerAddMoneyCommand", origin, target, 0.5);
    await command(f, "removemoney", "registerRemoveMoneyCommand", origin, target, 1.25);
    f.system.currentTick += 20;
    assert.deepEqual(read(f.buyer), ["Balance set -12.00", "Money added +0.50", "Money removed -1.25"]);
    f.system.currentTick += 100;
    f.dollars.setScore(f.buyer.scoreboardIdentity, 2147483647);
    f.cents.setScore(f.buyer.scoreboardIdentity, 97);
    read(f.buyer);
    await command(f, "addmoney", "registerAddMoneyCommand", origin, target, 1);
    assert.ok(read(f.buyer).includes("Money added +0.02"));
});

test("command-block item trades report only real inventory transactions", async (t) => {
    const f = await commerceFixture(t);
    const read = await captureHud(f);
    const origin = { sourceBlock: {} };
    f.online.push(f.buyer);
    const args = [origin, "Buyer", { id: "minecraft:stone" }, 2, 0.75];
    await command(f, "sell", "registerSellCommand", ...args);
    assert.deepEqual(read(f.buyer), []);
    await command(f, "buy", "registerBuyCommand", ...args);
    await command(f, "sell", "registerSellCommand", ...args);
    assert.deepEqual(read(f.buyer), ["Bought Stone -1.50", "Sold Stone +1.50"]);
});

test("offline sale records produce one combined card on reconnect and survive a failed receipt save", async (t) => {
    const f = await auctionFixture(t);

    for (const id of ["1", "2"]) {
        f.seller.inventory.setItem(0, new f.ItemStack("minecraft:stone", 2));
        f.list();
        f.buyAuction(f.buyer, id);
    }
    assert.equal(f.loadAh().soldMessages.length, 2);
    f.online.push(f.seller);
    const read = await captureHud(f);
    const join = () => {
        f.world.afterEvents.playerSpawn.emit({ player: f.seller, initialSpawn: true });
        f.scheduled.pop()();
    };
    const write = f.world.setDynamicProperty;
    f.world.setDynamicProperty = () => {
        throw Error("unavailable");
    };
    join();
    assert.deepEqual(read(f.seller), []);
    f.world.setDynamicProperty = write;
    join();
    assert.deepEqual(read(f.seller), ["Auction: sold Stone x2 +2.50"]);
    const chatCount = f.seller.messages.length;
    f.world.afterEvents.playerLeave.emit({ playerId: f.seller.id });
    join();
    assert.deepEqual(read(f.seller), []);
    assert.equal(f.seller.messages.length, chatCount);
});

test("a partial legacy payment produces no success receipt for either player", async (t) => {
    const f = await commerceFixture(t);
    const read = await captureHud(f);
    const write = f.cents.setScore;
    f.cents.setScore = (id, v) => {
        if (id === f.seller.scoreboardIdentity) throw Error("write failed");
        write(id, v);
    };
    await command(f, "pay", "registerPayCommand", { sourceEntity: f.buyer }, [f.seller], 1.25);
    f.system.currentTick += 20;
    assert.deepEqual(read(f.seller), []);
    assert.deepEqual(read(f.buyer), []);
});

test("a disabled HUD does not replay earlier payments on enable", async (t) => {
    const f = await commerceFixture(t);
    const read = await captureHud(f);
    const { syncMoneyHud } = await f.load("scripts/modules/hud/manager.js");
    (await f.load("scripts/modules/players/preferences.js")).setMoneyPersonalDefaults({ notifications: false });
    f.buyer.hasTag = (tag) => tag === f.CONFIG.PLAYER_HUD_OFF_TAG;
    syncMoneyHud(f.buyer);
    await command(f, "pay", "registerPayCommand", { sourceEntity: f.buyer }, [f.seller], 1.25);
    f.buyer.hasTag = () => false;
    syncMoneyHud(f.buyer);
    assert.deepEqual(read(f.buyer), []);
    assert.deepEqual(read(f.seller), ["Received from Buyer +1.25"]);
});

test("initial spawn awards starting money once and respawn generates no card", async (t) => {
    const f = await commerceFixture(t);
    await f.load("scripts/main.js");
    const tags = new Set();
    f.buyer.hasTag = (tag) => tags.has(tag);
    f.buyer.addTag = (tag) => tags.add(tag);
    f.properties.set(f.CONFIG.START_MONEY_CENTS_DP_KEY, 123);
    const read = await captureHud(f);
    function spawn(initialSpawn) {
        const start = f.scheduled.length;
        f.world.afterEvents.playerSpawn.emit({ player: f.buyer, initialSpawn });
        for (const fn of f.scheduled.splice(start)) fn();
    }
    spawn(true);
    assert.deepEqual(read(f.buyer), ["Starting money +1.23"]);
    spawn(false);
    assert.deepEqual(read(f.buyer), []);
    spawn(true);
    assert.deepEqual(read(f.buyer), []);
    assert.equal(f.balance(f.buyer), 1123);
});

test("shop inventory failure after debit rolls the wallet back without a HUD receipt", async (t) => {
    const f = await shopFixture(t);
    const read = await captureHud(f);
    f.buyer.inventory.setItem = () => {
        throw Error("locked");
    };
    f.forms(2);
    await f.flowBuy(f.buyer, offer);
    f.system.currentTick += 20;
    assert.equal(f.balance(f.buyer), 1000);
    assert.deepEqual(read(f.buyer), []);
});

test("legacy sell slot-clear failure retains its financial behavior but suppresses the sale card", async (t) => {
    const f = await commerceFixture(t);
    const read = await captureHud(f);
    f.online.push(f.buyer);
    f.buyer.inventory.setItem(0, new f.ItemStack("minecraft:stone", 1));
    f.buyer.inventory.setItem = () => {
        throw Error("locked");
    };
    await command(f, "sell", "registerSellCommand", { sourceBlock: {} }, "Buyer", { id: "minecraft:stone" }, 1, 0.75);
    f.system.currentTick += 20;
    assert.equal(f.buyer.inventory.getItem(0).amount, 1);
    assert.equal(f.balance(f.buyer), 1075);
    assert.deepEqual(read(f.buyer), []);
});

test("normalization preserves an existing balance without a HUD card", async (t) => {
    const f = await commerceFixture(t);
    f.cents.setScore(f.buyer.scoreboardIdentity, -12);
    const read = await captureHud(f);
    const { normalizePlayerIfNeeded } = await f.load("scripts/modules/economy/balance.js");
    normalizePlayerIfNeeded(f.dollars, f.cents, f.buyer);
    f.system.currentTick += 20;
    assert.equal(f.balance(f.buyer), 988);
    assert.deepEqual(read(f.buyer), []);
});

test("turning auctions off preserves ownership, deadlines and recovery", async (t) => {
    const f = await auctionFixture(t);
    const { saveServerOptions } = await f.load("scripts/modules/settings/server.js");
    saveServerOptions({ days: 1, collect: 7 });
    f.list();
    const listing = f.loadAh().auctions[0];
    assert.equal(listing.expiresAt, 1728000);
    assert.equal(listing.collectUntil, 8 * 1728000);
    saveServerOptions({ auctions: false, days: 30, collect: 100 });
    f.buyAuction(f.buyer, listing.id);
    assert.equal(f.balance(f.buyer), 1000);
    assert.deepEqual(f.loadAh().auctions[0], listing);
    f.cancelAuction(f.seller, listing.id);
    f.list();
    assert.equal(f.loadAh().auctions.length, 0);
    assert.equal(f.seller.inventory.getItem(0).amount, 2);
});
test("disabled payments leave both wallets untouched", async (t) => {
    const f = await commerceFixture(t);
    (await f.load("scripts/modules/settings/server.js")).saveServerOptions({ pay: false });
    await command(f, "pay", "registerPayCommand", { sourceEntity: f.buyer }, [f.seller], 1);
    assert.equal(f.balance(f.buyer), 1000);
    assert.equal(f.balance(f.seller), 0);
});

test("shop policy changed during a purchase takes effect before settlement", async (t) => {
    const f = await shopFixture(t);
    const { saveServerOptions } = await f.load("scripts/modules/settings/server.js");
    f.forms(2, () => saveServerOptions({ maxItems: 1 }));
    await f.flowBuy(f.buyer, offer);
    assert.equal(f.balance(f.buyer), 1000);
    assert.equal(f.buyer.inventory.getItem(0), undefined);
    (await f.load("scripts/modules/players/preferences.js")).setMoneyPersonalDefaults({ confirmBuy: false });
    f.forms(1, () => assert.fail("unexpected confirmation"));
    await f.flowBuy(f.buyer, offer);
    assert.equal(f.balance(f.buyer), 875);
    saveServerOptions({ sell: false });
    await f.flowSell(f.buyer, offer);
    assert.equal(f.buyer.inventory.getItem(0).amount, 1);
});

test("skipping a purchase confirmation is personal and leaves sale confirmation enabled", async (t) => {
    const f = await shopFixture(t);
    const { saveDisplayOptions, getDisplayOptions } = await f.load("scripts/modules/players/preferences.js");
    const props = new Map();
    f.buyer.setDynamicProperty = (k, v) => props.set(k, v);
    f.buyer.getDynamicProperty = (k) => props.get(k);
    saveDisplayOptions(f.buyer, { confirmBuy: false });
    assert.equal(getDisplayOptions(f.seller).confirmBuy, true);
    f.forms(1, () => assert.fail("unexpected buy confirmation"));
    await f.flowBuy(f.buyer, offer);
    assert.equal(f.balance(f.buyer), 875);
    let asked = false;
    f.forms(1, () => {
        asked = true;
    });
    await f.flowSell(f.buyer, offer);
    assert.equal(asked, true);
    assert.equal(f.balance(f.buyer), 910);
});

test("a personal sale override skips only the sale prompt and records the full stack quantity", async (t) => {
    const f = await shopFixture(t);
    const pref = await f.load("scripts/modules/players/preferences.js");
    f.buyer.getDynamicProperty = () => '{"confirmSell":false}';
    assert.equal(pref.getDisplayOptions(f.buyer).confirmBuy, true);
    const read = await captureHud(f);
    f.buyer.inventory.setItem(0, new f.ItemStack("minecraft:stone", 64));
    f.forms(64, () => assert.fail("unexpected sale confirmation"));
    await f.flowSell(f.buyer, offer);
    assert.deepEqual(read(f.buyer), ["Shop: sold 64 Stone +22.40"]);
});

test("combined Shop receipts sum traded units and signed costs across different stack sizes", async (t) => {
    const f = await shopFixture(t);
    f.dollars.setScore(f.buyer.scoreboardIdentity, 100);
    const read = await captureHud(f);
    f.forms(30);
    await f.flowBuy(f.buyer, offer);
    assert.deepEqual(read(f.buyer), ["Shop: bought 30 Stone -37.50"]);
    f.forms(2);
    await f.flowBuy(f.buyer, offer);
    assert.deepEqual(read(f.buyer), ["Shop: bought 32 Stone -40.00"]);
});
