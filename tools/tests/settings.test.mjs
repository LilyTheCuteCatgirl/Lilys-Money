import assert from "node:assert/strict";
import test from "node:test";
import { pages, ROOT } from "../../addon/bp/scripts/modules/settings/pages.js";

const expected = {
    "Lily's Money - Settings": ["Personal Settings", "Server Settings"],
    "Personal Settings": ["HUD & Appearance", "Notifications", "Sounds", "Number Formatting", "Shop Purchases", "Auction House"],
    "HUD & Appearance": ["Basic HUD Settings", "HUD Theme & Effects"],
    Notifications: ["General Notifications", "Notification Categories", "Notification Details"],
    Sounds: ["General Sound Settings", "Sound Events"],
    "Server Settings": [
        "General Economy",
        "Default Player Settings",
        "Shop Settings",
        "Auction House Settings",
        "Jobs Settings",
        "Logging & History",
        "Advanced Performance",
    ],
    "Auction House Settings": ["General Auction Settings", "Limits & Durations"],
    "Advanced Performance": ["Continue to Advanced Settings"],
    "Continue to Advanced Settings": ["HUD & Economy Timing", "Jobs & Auction Timing", "Startup & Initialization Timing"],
};

test("settings navigation preserves button order and supplies explicit texture paths", () => {
    assert.equal(ROOT, "Lily's Money - Settings");
    for (const [name, labels] of Object.entries(expected)) {
        assert.deepEqual(
            pages[name].links.map(([label]) => label),
            labels,
        );
        for (const [, icon] of pages[name].links) assert.match(icon, /^textures\/(items|ui|blocks)\/[a-zA-Z0-9_]+$/);
    }
});

import { newHudSession, observeBalance, enqueueCard, updateHud } from "../../addon/bp/scripts/modules/hud/session.js";
import { packFixture } from "./packFixture.mjs";

test("filtered cards advance the observed wallet and never enter the queue", () => {
    const s = newHudSession();
    s.options = { job: false, duration: 1, combine: false, animate: false, names: false, quantity: false };
    observeBalance(s, 0, 0);
    observeBalance(s, 100, 1, "mined Stone", "job:break:stone");
    assert.equal(s.observed, 100);
    assert.equal(s.rows.length, 0);
    for (let i = 0; i < 7; i++) enqueueCard(s, 10, "Shop: sold Stone", 2);
    assert.equal(s.rows.length, 6);
    assert.equal(s.waiting.length, 1);
    assert.equal(s.rows[0].holdUntil, 26);
    s.wallet = false;
    let title;
    updateHud(s, 2, (t) => (title = t));
    assert.doesNotMatch(title, /Stone|\$1\.00/);
    assert.match(title, /\nS§aShop transaction/);
    updateHud(s, 36, () => {});
    assert.equal(s.rows.length, 1);
    assert.equal(s.waiting.length, 0);
});

test("personal display overrides follow player properties through reload and remain independent of defaults", async (t) => {
    const f = await packFixture(t);
    const pref = await f.load("scripts/modules/players/preferences.js");
    const props = new Map();
    const first = { getDynamicProperty: (k) => props.get(k), setDynamicProperty: (k, v) => props.set(k, v) };
    pref.saveDisplayOptions(first, { notifications: false, duration: 7 });
    pref.setMoneyPersonalDefaults({ duration: 5 });
    assert.equal(pref.getDisplayOptions({ ...first, name: "Renamed" }).duration, 7);
    assert.equal(pref.getDisplayOptions(first).notifications, false);
    assert.equal(pref.getDisplayOptions({}).duration, 5);
});

import { formatDisplayMoney } from "../../addon/bp/scripts/modules/economy/formatting.js";

test("localized amounts keep the 28-byte wallet header for every route", () => {
    const options = { group: "Space", decimal: "Comma", color: "Pink", cents: "Always" };
    assert.equal(formatDisplayMoney(-123456, options), "-$1 234,56");
    for (const route of "BCDE") {
        const s = newHudSession();
        Object.assign(s, { options, route });
        observeBalance(s, 123456, 0);
        enqueueCard(s, 2, "Test receipt", 0);
        let title;
        updateHud(s, 0, (t) => (title = t));
        assert.equal(Buffer.byteLength(title.split("\n")[0]), 28);
        assert.match(title, /§d.*1\u00a0234,56/);
        s.wallet = false;
        s.nextFrame = 0;
        updateHud(s, 1, (t) => (title = t));
        assert.equal(title.split("\n")[0], "~LM3:" + route + "_".repeat(22));
    }
});

import { commerceFixture } from "./commerceFixture.mjs";

test("players and admins can walk every menu and cancel every editor back to its parent", async (t) => {
    const f = await commerceFixture(t);
    const ui = await f.load("node_modules/@minecraft/server-ui/index.js");
    let admin = false;
    f.buyer.hasTag = (tag) => admin && tag === f.CONFIG.ADMIN_TAG;
    for (const Type of [ui.ActionFormData, ui.ModalFormData]) {
        Type.prototype.title = function (value) {
            this.caption = value;

            return this;
        };
        Type.prototype.show = function () {
            return visit(this);
        };
        Type.prototype.button = function (label, icon) {
            (this.buttons ??= []).push([label.replace(/§./g, ""), icon]);

            return this;
        };
        for (const method of ["toggle", "dropdown", "textField"])
            Type.prototype[method] = function () {
                return this;
            };
    }
    await f.load("scripts/modules/ui/8crafterUiAuto.js");
    const { openSettings } = await f.load("scripts/modules/settings/navigation.js");
    const steps = [];
    function visit(form) {
        assert.ok(steps.length, "Unexpected form " + form.caption);
        const [name, index, buttons] = steps.shift();
        const titles = {
            Notifications: "Notification Settings",
            Sounds: "Sound Settings",
            "Continue to Advanced Settings": "Advanced Performance",
        };
        assert.equal(form.caption.replace(/§./g, ""), titles[name] ?? name);
        if (!buttons) {
            assert.ok(form instanceof ui.ModalFormData);

            return { canceled: true };
        }
        assert.deepEqual(form.buttons, buttons);

        return { selection: index };
    }
    function buttons(page) {
        const end =
            page === ROOT || (!admin && page === "Personal Settings")
                ? ["Close", "textures/ui/cancel"]
                : ["Back", "textures/ui/arrow_left"];

        return [...pages[page].links.filter(([name]) => admin || name !== "Server Settings"), end];
    }
    function walk(page) {
        if (!pages[page]) {
            steps.push([page]);

            return;
        }

        const links = buttons(page);

        for (const [index, [name]] of links.slice(0, -1).entries()) {
            steps.push([page, index, links]);
            walk(name);
        }
        steps.push([page, links.length - 1, links]);
    }
    for (admin of [false, true]) {
        walk(admin ? ROOT : "Personal Settings");
        await openSettings(f.buyer);
        assert.equal(steps.length, 0);
    }
});
test("admin forms discard invalid, stale, cancelled and deauthorized submissions", async (t) => {
    const f = await commerceFixture(t);
    const ui = await f.load("node_modules/@minecraft/server-ui/index.js");
    ui.ModalFormData.prototype.toggle = function () {
        return this;
    };
    await f.load("scripts/modules/ui/8crafterUiAuto.js");
    const { editorFor, showEditor } = await f.load("scripts/modules/settings/editors.js");
    const { getStartMoneyCents, setStartMoneyCents } = await f.load("scripts/modules/economy/balance.js");
    const { serverOptions } = await f.load("scripts/modules/settings/server.js");
    let admin = true;
    f.buyer.hasTag = () => admin;
    const show = () => showEditor(f.buyer, "General Economy", true, editorFor("General Economy", f.buyer));

    for (const input of [{ canceled: true }, { formValues: ["5.005", false, true] }, { formValues: ["5.00", "invalid", true] }]) {
        f.buyer.nextForm = () => input;
        await show();
        assert.equal(getStartMoneyCents(), 0);
        assert.equal(serverOptions().pay, true);
    }
    f.buyer.nextForm = () => {
        setStartMoneyCents(700);

        return { formValues: ["5.00", false, true] };
    };
    await show();
    assert.equal(getStartMoneyCents(), 700);
    assert.equal(serverOptions().pay, true);
    f.buyer.nextForm = () => {
        admin = false;

        return { formValues: ["5.00", false, true] };
    };
    await show();
    assert.equal(getStartMoneyCents(), 700);
    assert.equal(serverOptions().pay, true);
});

test("world-ready registration reads persisted timing and advances the auction clock by the registered interval", async (t) => {
    const f = await packFixture(t);
    const ready = [];
    f.world.afterEvents.worldLoad = { subscribe: (fn) => ready.push(fn) };
    const { saveServerOptions } = await f.load("scripts/modules/settings/server.js");
    saveServerOptions({ expiry: 18000 });
    await f.load("scripts/modules/auction/listings.js");
    assert.equal(f.intervals.size, 0);
    for (const fn of ready) fn();
    const timer = [...f.intervals.values()].find((it) => it.ticks === 18000);
    assert.ok(timer);
    timer.callback();
    const { getAhNowTicks } = await f.load("scripts/modules/auction/clock.js");
    assert.equal(getAhNowTicks(), 18000);
    saveServerOptions({ expiry: 36000 });
    timer.callback();
    assert.equal(getAhNowTicks(), 36000);
    saveServerOptions({ auctions: false });
    timer.callback();
    assert.equal(getAhNowTicks(), 36000);
});

test("sound filters, level, preset and rapid-repeat suppression affect playback per player", async (t) => {
    const f = await commerceFixture(t);
    const { saveDisplayOptions, playMoneySound } = await f.load("scripts/modules/players/preferences.js");
    let data;
    const sounds = [];
    f.buyer.getDynamicProperty = () => data;
    f.buyer.setDynamicProperty = (_, value) => {
        data = value;
    };
    f.buyer.playSound = (id, options) => sounds.push([id, options]);
    saveDisplayOptions(f.buyer, {
        volume: 50,
        effect: "Coin",
        combineSound: true,
        spendSound: false,
        jobSound: false,
        auctionSound: false,
    });
    for (const type of ["spend", "job", "auction", "receive", "receive"]) playMoneySound(f.buyer, type);
    assert.deepEqual(sounds, [["random.orb", { volume: 0.5, pitch: 1.7 }]]);
    f.system.currentTick += 4;
    playMoneySound(f.buyer);
    assert.equal(sounds.length, 2);
});

test("all five wallet colors honor the bold preference without shifting receipts", () => {
    for (const [color, code] of Object.entries({ White: "§f", Pink: "§d", Purple: "§5", Gold: "§6", Green: "§a" })) {
        for (const boldBalance of [true, false]) {
            const state = newHudSession();
            state.options = { color, boldBalance, highlight: true };
            observeBalance(state, 100, 0);
            observeBalance(state, 110, 1);
            updateHud(state, 1, (title) => {
                const [wallet, receipt] = title.split("\n");
                assert.equal(wallet, "~LM3:B" + (boldBalance ? code + "§l" : "§r" + code) + "$1.10".padStart(16));
                assert.equal(Buffer.byteLength(wallet), 28);
                assert.match(receipt, /Money received/);
            });
        }
    }
});
test("job cooldown chat reports time remaining and releases at expiry", async (t) => {
    const f = await commerceFixture(t);
    const { saveServerOptions } = await f.load("scripts/modules/settings/server.js");
    const { setJob } = await f.load("scripts/modules/jobs/rewards.js");
    saveServerOptions({ cooldown: 5 });
    const last = 1800000000000;
    let now = last + 226001;
    t.mock.method(Date, "now", () => now);
    f.buyer.getDynamicProperty = () => last;
    assert.equal(setJob(f.buyer, "miner"), false);
    assert.equal(f.buyer.messages.at(-1), "<§dLily's money§r> §rYou can change jobs again in 1m 14s.");
    now = last + 299999;
    assert.equal(setJob(f.buyer, null), false);
    assert.match(f.buyer.messages.at(-1), /in 1s/);
    now++;
    assert.equal(setJob(f.buyer, "miner"), true);
});

test("revoked admin access routes stale server selections to Personal Settings and closes on cancel", async (t) => {
    const f = await commerceFixture(t);
    const { ActionFormData } = await f.load("node_modules/@minecraft/server-ui/index.js");
    const seen = [];
    ActionFormData.prototype.title = function (text) {
        this.caption = text;

        return this;
    };
    ActionFormData.prototype.show = function (player) {
        seen.push(this.caption.replace(/§./g, ""));

        return player.nextForm();
    };
    await f.load("scripts/modules/ui/8crafterUiAuto.js");
    const { openSettings } = await f.load("scripts/modules/settings/navigation.js");
    let admin = true;
    f.buyer.hasTag = () => admin;
    f.buyer.nextForm = () => {
        if (admin) {
            admin = false;

            return { selection: 1 };
        }

        return { canceled: true };
    };
    await openSettings(f.buyer);
    assert.deepEqual(seen, [ROOT, "Personal Settings"]);
});

test("legacy confirmBuy persists across reconnects while missing preferences inherit the current world defaults", async (t) => {
    const f = await packFixture(t);
    const prefs = await f.load("scripts/modules/players/preferences.js");
    let stored = JSON.stringify({ confirmBuy: false, color: "Pink" });
    const reconnect = () => ({ getDynamicProperty: () => stored, setDynamicProperty: (_, value) => (stored = value) });
    const keys = ["confirmBuy", "confirmSell", "confirmAuctionBuy", "confirmAuctionList"];
    const flags = (p) => keys.map((k) => prefs.getDisplayOptions(p)[k]);
    assert.deepEqual(flags({}), [true, true, true, true]);
    assert.deepEqual(flags(reconnect()), [false, true, true, true]);
    prefs.setMoneyPersonalDefaults({ confirmSell: false, confirmAuctionList: false });
    prefs.saveDisplayOptions(reconnect(), { confirmSell: true, confirmAuctionBuy: false });
    assert.deepEqual(flags({}), [true, false, true, false]);
    assert.deepEqual(flags(reconnect()), [false, true, false, false]);
    assert.equal(prefs.getDisplayOptions(reconnect()).color, "Pink");
});
