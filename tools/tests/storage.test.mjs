import test from "node:test";
import assert from "node:assert/strict";
import { packFixture } from "./packFixture.mjs";

const databasePath = "scripts/modules/players/nameDatabase.js";
const base = "lilynames:nameDataBase";
const count = base + "Count";
const player = (id, name) => ({ scoreboardIdentity: { id }, name });

test("a join updates a legacy single-property name database and keeps offline identities", async (t) => {
    const { load, properties, scheduled } = await packFixture(t);
    properties.set(base, '{"42":"Offline"}');
    const db = await load(databasePath);
    assert.equal(db.rememberPlayerName(player(7, "New")), true);
    assert.equal(db.rememberPlayerName(player(7, "New")), false);
    assert.equal(scheduled.length, 1);
    scheduled.shift()();
    assert.deepEqual(JSON.parse(properties.get(base)), { 42: "Offline", 7: "New" });
    assert.equal(properties.get(count), 1);
    assert.equal(db.getSavedPlayerNameFromParticipant({ id: 42, displayName: "Disconnected" }), "Offline");
});

test("disabled logging skips initialization and transaction storage", async (t) => {
    const { load, world, properties } = await packFixture(t);
    const { CONFIG } = await load("scripts/config.js");
    properties.set(CONFIG.TRANSACTION_LOGGING_DP_KEY, false);
    const logger = await load("scripts/modules/logging/moneylogging.js");
    let writes = 0;
    world.setDynamicProperty = () => {
        writes++;
    };
    assert.equal(logger.initializeMoneyLogging(), false);
    assert.equal(logger.logMoneyEvent("PAY", {}), false);
    assert.equal(writes, 0);
});

test("canonical chunks override older names and legacy-only names survive a reload", async (t) => {
    const { load, properties, scheduled } = await packFixture(t);
    properties.set("lilymoney:name_cache_v1", "1\tObsolete\n2\tLegacy\ninvalid\n");
    properties.set(base, '{"1":"First","3":"Offline"}');
    properties.set(count, 2);
    properties.set(base + "2", '{"1":"Canonical"}');
    const db = await load(databasePath);
    assert.equal(db.getSavedPlayerNameByIdentityId(1), "Canonical");
    assert.equal(db.getSavedPlayerNameByIdentityId(2), "Legacy");
    assert.equal(db.getSavedPlayerNameFromParticipant({ id: 4, displayName: "Display" }), "Display");
    assert.equal(db.rememberPlayerName(player(null, "Missing")), false);
    assert.equal(db.rememberPlayerName(player(3, " ")), false);
    db.rememberPlayerName(player(3, "Renamed"));
    db.flushSavedPlayerNames();
    scheduled.shift()();
    const next = await packFixture(t);
    for (const [key, value] of properties) next.properties.set(key, value);
    const reloaded = await next.load(databasePath);
    assert.deepEqual(Object.fromEntries(reloaded.getAllSavedPlayerNameEntries().map(({ identityId, name }) => [identityId, name])), {
        1: "Canonical",
        2: "Legacy",
        3: "Renamed",
    });
    assert.equal(properties.get(base), '{"1":"First","3":"Offline"}');
});

for (const [problem, extra] of [
    ["missing chunk", [[count, 2]]],
    ["invalid count", [[count, 1.5]]],
    [
        "invalid JSON",
        [
            [count, 2],
            [base + "2", "{broken"],
        ],
    ],
    [
        "invalid name",
        [
            [count, 2],
            [base + "2", '{"9":null}'],
        ],
    ],
    [
        "unexpected extra chunk",
        [
            [count, 1],
            [base + "2", '{"3":"Orphan"}'],
        ],
    ],
]) {
    test(`preserve persisted bytes after detecting ${problem}`, async (t) => {
        const { load, properties } = await packFixture(t);
        properties.set(base, '{"1":"Offline"}');
        for (const [k, v] of extra) properties.set(k, v);
        const original = new Map(properties);
        const db = await load(databasePath);
        assert.equal(db.getSavedPlayerNameByIdentityId(1), "Offline");
        db.rememberPlayerName(player(2, "Online"));
        db.flushSavedPlayerNames();
        assert.deepEqual(properties, original);
        assert.equal(db.getSavedPlayerNameByIdentityId(2), "Online");
    });
}

test("new pages fit Unicode names and a failed count write retries without dropping later joins", async (t) => {
    const { load, properties, world, scheduled } = await packFixture(t);
    properties.set(base, JSON.stringify({ 1: "界".repeat(9996) }));
    properties.set(count, 1);
    const db = await load(databasePath);
    db.rememberPlayerName(player(2, "猫猫"));
    const save = world.setDynamicProperty;
    world.setDynamicProperty = (k, v) => {
        if (k === count) throw Error("test write failure");
        save(k, v);
    };
    scheduled.shift()();
    assert.equal(properties.get(count), 1);
    assert.deepEqual(JSON.parse(properties.get(base + "2")), { 2: "猫猫" });
    db.rememberPlayerName(player(3, "Later"));
    world.setDynamicProperty = save;
    scheduled.shift()();
    assert.equal(properties.get(count), 2);
    assert.deepEqual(JSON.parse(properties.get(base + "2")), { 2: "猫猫", 3: "Later" });
    for (const key of [base, base + "2"]) assert.ok(Buffer.byteLength(properties.get(key)) <= 30000);
});

test("temporary read failure during join preserves older names on retry", async (t) => {
    const { load, properties, world, scheduled } = await packFixture(t);
    properties.set(base, '{"1":"Old"}');
    const read = world.getDynamicProperty;
    world.getDynamicProperty = () => {
        throw Error("test read failure");
    };
    const db = await load(databasePath);
    db.rememberPlayerName(player(2, "New"));
    world.getDynamicProperty = read;
    scheduled.shift()();
    assert.deepEqual(JSON.parse(properties.get(base)), { 1: "Old", 2: "New" });
});

test("main links the pack, registers commands, installs form layouts and saves a quick departure", async (t) => {
    const { load, properties, world, system } = await packFixture(t);
    const { CONFIG } = await load("scripts/config.js");
    properties.set(CONFIG.TRANSACTION_LOGGING_DP_KEY, false);
    await load("scripts/main.js");
    const commands = [];
    system.beforeEvents.startup.emit({
        customCommandRegistry: {
            registerEnum() {},
            registerCommand(def, callback) {
                assert.equal(typeof callback, "function");
                commands.push(def.name);
            },
        },
    });
    const expected = [
        "balance",
        "bal",
        "setmoney",
        "addmoney",
        "removemoney",
        "pay",
        "topmoney",
        "baltop",
        "balancetop",
        "buy",
        "sell",
        "shop",
        "moneysettings",
        "moneyhelp",
        "job",
        "ah",
    ];
    assert.deepEqual(commands.sort(), expected.map((name) => "lilymoney:" + name).sort());
    const { ActionFormData, ModalFormData } = await load("node_modules/@minecraft/server-ui/index.js");
    for (const form of [ActionFormData, ModalFormData]) assert.equal(typeof form.prototype.use8CrafterLayout, "function");
    const p = { id: "runtime", name: "Quick", hasTag: () => false, scoreboardIdentity: undefined };
    world.afterEvents.playerSpawn.emit({ initialSpawn: true, player: p });
    p.scoreboardIdentity = { id: 0 };
    world.beforeEvents.playerLeave.emit({ player: p });
    world.afterEvents.playerLeave.emit({ playerId: p.id, playerName: p.name });
    assert.deepEqual(JSON.parse(properties.get(base)), { 0: "Quick" });
});
