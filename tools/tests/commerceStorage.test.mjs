import test from "node:test";
import assert from "node:assert/strict";
import { packFixture } from "./packFixture.mjs";
const stores = [
    {
        name: "shop",
        suffix: "Shop",
        version: 2,
        key: "lilymoney:shop_v2",
        data: {
            v: 2,
            categories: [
                {
                    name: "Custom",
                    icon: "textures/ui/page",
                    items: [{ id: "minecraft:stone", buy: 123, sell: 45, allowBuy: true, allowSell: true }],
                },
            ],
        },
    },
    {
        name: "ah",
        suffix: "Ah",
        version: 1,
        key: "lilymoney:ah_v1",
        data: {
            v: 1,
            nextId: 5,
            nextSoldMessageId: 2,
            auctions: [],
            soldMessages: [{ id: "1", sellerIdentityId: "7", buyerName: "Buyer", itemName: "Stone", amount: 1, price: 123, createdAt: 4 }],
        },
    },
];
async function setup(t, store) {
    const { load, world, properties } = await packFixture(t);
    const get = "load" + store.suffix,
        save = "save" + store.suffix;
    const mod = await load("scripts/modules/" + (store.name === "ah" ? "auction" : "shop") + "/storage.js");
    return { get: mod[get], save: mod[save], world, properties };
}
for (const store of stores) {
    test(store.name + " reads legacy and chunked documents", async (t) => {
        for (const chunked of [false, true]) {
            const { get, properties } = await setup(t, store);
            const json = JSON.stringify(store.data);
            if (chunked) {
                properties.set(store.key + ":meta", JSON.stringify({ v: store.version, parts: 2 }));
                properties.set(store.key + ":part_0", json.slice(0, 25));
                properties.set(store.key + ":part_1", json.slice(25));
            } else properties.set(store.key, json);
            assert.deepEqual(get(), store.data);
        }
    });
}

for (const store of stores) {
    test(store.name + " distinguishes new and deliberately empty databases", async (t) => {
        const { get, properties } = await setup(t, store);
        const initial = get();
        assert.equal(properties.size, 0);
        if (store.name === "shop") assert.ok(initial.categories.length > 0);
        const other = await setup(t, store);
        other.properties.set(store.key + ":meta", JSON.stringify({ v: store.version, parts: 0 }));
        const empty = other.get();
        assert.deepEqual(empty.categories ?? empty.auctions, []);
    });
    for (const [type, seed] of [
        ["broken JSON", (s) => [[s.key, "{bad"]]],
        [
            "invalid metadata",
            (s) => [
                [s.key + ":meta", '{"parts":3.5}'],
                [s.key, JSON.stringify(s.data)],
            ],
        ],
        [
            "missing chunk",
            (s) => [
                [s.key + ":meta", JSON.stringify({ v: s.version, parts: 2 })],
                [s.key + ":part_0", JSON.stringify(s.data)],
            ],
        ],
        ["orphan chunk", (s) => [[s.key + ":part_0", "recoverable"]]],
        ["unsupported stored fields", (s) => [[s.key, JSON.stringify({ ...s.data, extra: "keep me" })]]],
    ]) {
        test(store.name + " preserves original bytes on " + type, async (t) => {
            const { properties, get, save } = await setup(t, store);
            for (const [k, v] of seed(store)) properties.set(k, v);
            const before = new Map(properties);
            assert.throws(get);
            assert.equal(save(store.data), false);
            assert.deepEqual(properties, before);
        });
    }
    test(store.name + " retries reads and restores a partial write before retrying", async (t) => {
        const { world, properties, get, save } = await setup(t, store);
        properties.set(store.key, JSON.stringify(store.data));
        const read = world.getDynamicProperty;
        world.getDynamicProperty = () => {
            throw Error("Unavailable");
        };
        assert.throws(get);
        assert.equal(save(store.data), false);
        world.getDynamicProperty = read;
        const draft = get();
        const before = new Map(properties);
        const write = world.setDynamicProperty;
        world.setDynamicProperty = (k, v) => {
            if (k.endsWith(":meta")) throw Error("meta write failed");
            write(k, v);
        };
        assert.equal(save(draft), false);
        assert.deepEqual(properties, before);
        assert.deepEqual(get(), store.data);
        world.setDynamicProperty = write;
        assert.ok(save(draft));
        const next = await setup(t, store);
        for (const [k, v] of properties) next.properties.set(k, v);
        assert.deepEqual(next.get(), store.data);
    });
    test(store.name + " rejects stale editor copies and externally changed bytes", async (t) => {
        const { properties, get, save } = await setup(t, store);
        properties.set(store.key, JSON.stringify(store.data));
        const first = get(),
            second = get();
        assert.ok(save(first));
        assert.equal(save(second), false);
        const draft = get();
        properties.set(store.key + ":part_0", "{damaged");
        assert.equal(save(draft), false);
        assert.equal(properties.get(store.key + ":part_0"), "{damaged");
    });
}

test("shop saves multibyte text across pages and restores the first page if the second write fails", async (t) => {
    const store = stores[0],
        { world, get, save, properties } = await setup(t, store);
    properties.set(store.key, JSON.stringify(store.data));
    const draft = get();
    draft.categories[0].name = "猫🙂".repeat(6500);
    assert.equal(save(draft), true);
    const part0 = store.key + ":part_0",
        part1 = store.key + ":part_1";
    assert.ok(Buffer.byteLength(properties.get(part0)) <= 30000);
    assert.ok(Buffer.byteLength(properties.get(part1)) <= 30000);
    assert.equal(JSON.parse(properties.get(part0) + properties.get(part1)).categories[0].name, draft.categories[0].name);
    const before = new Map(properties),
        next = get();
    next.categories[0].name = "魚🙂".repeat(6400);
    const write = world.setDynamicProperty;
    world.setDynamicProperty = (k, v) => {
        if (k === part1) throw Error("page unavailable");
        write(k, v);
    };
    assert.equal(save(next), false);
    assert.deepEqual(properties, before);
});

test("the bundled catalog version is accepted in the legacy single-property shop", async (t) => {
    const store = stores[0],
        { get, properties } = await setup(t, store);
    const original = JSON.stringify({ ...store.data, v: 4 });
    properties.set(store.key, original);
    assert.deepEqual(get(), store.data);
    assert.equal(properties.get(store.key), original);
});
