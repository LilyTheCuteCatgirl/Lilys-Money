import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { commerceFixture } from "./commerceFixture.mjs";
import { updateHud, newHudSession, enqueueCard, observeBalance } from "../../addon/bp/scripts/modules/hud/session.js";

function displayLines(title) {
    return title.split("\n").map((line, i) => (i ? line.slice(1).replace(/~+$/, "") : line));
}

test("the default HUD follows personal settings through respawn, reconnect and re-enable", async (t) => {
    const { load, world, buyer, dollars, intervals, scheduled, system } = await commerceFixture(t);
    await load("scripts/modules/ui/8crafterUiAuto.js");
    const { registerMoneySettingsCommand } = await load("scripts/commands/moneysettings.js");
    const tags = new Set();
    buyer.hasTag = (tag) => tags.has(tag);
    buyer.addTag = (tag) => tags.add(tag);
    buyer.removeTag = (tag) => tags.delete(tag);
    const titles = [];
    buyer.onScreenDisplay = { setTitle: (text) => titles.push(text) };
    let open;
    registerMoneySettingsCommand({
        registerCommand(_def, fn) {
            open = fn;
        },
    });
    const { ModalFormData } = await load("node_modules/@minecraft/server-ui/index.js");
    const toggles = new Map();
    ModalFormData.prototype.toggle = function (label, options) {
        toggles.set(label, options.defaultValue);

        return this;
    };
    ModalFormData.prototype.dropdown = function (label, choices, options) {
        if (label === "HUD Position") assert.deepEqual(choices, ["Top right", "Top left", "Bottom right", "Bottom left"]);
        assert.ok(options.defaultValueIndex >= 0);

        return this;
    };
    async function save(enabled, compact = false, corner = 0) {
        const sequence = [0, 0, { formValues: [enabled, corner] }, 2, 3, { formValues: [Number(compact), 0, 0, 0] }, 5];
        buyer.nextForm = () => {
            const next = sequence.shift();

            return typeof next === "number" ? { selection: next } : next;
        };
        open({ sourceEntity: buyer });
        await scheduled.pop()();
    }
    const pulse = () => [...intervals.values()].find((i) => i.ticks === 1).callback();
    world.afterEvents.playerSpawn.emit({ player: buyer, initialSpawn: true });
    pulse();
    assert.match(titles.at(-1), /\$10\.00$/);
    world.afterEvents.playerSpawn.emit({ player: buyer, initialSpawn: false });
    pulse();
    assert.equal(titles.length, 2);
    await save(true, true);
    const prefs = await load("scripts/modules/players/preferences.js");
    prefs.setMoneyPersonalDefaults({ hud: false, position: "Bottom left" });
    assert.equal(prefs.hasMoneyHud(buyer), false);
    assert.equal(prefs.getHudPosition(buyer), "Bottom left");
    prefs.setMoneyPersonalDefaults({ hud: true, position: "Top right" });
    prefs.setMoneyPersonalDefaults({ notifications: false });
    await save(false);
    assert.equal(toggles.get("Enable Money HUD"), true);
    assert.equal(titles.at(-1), "~LM3:R");
    assert.equal(
        [...intervals.values()].some((timer) => timer.ticks === 1),
        false,
    );
    world.afterEvents.playerLeave.emit({ playerId: buyer.id });
    world.afterEvents.playerSpawn.emit({ player: buyer, initialSpawn: true });
    assert.equal(
        [...intervals.values()].some((timer) => timer.ticks === 1),
        false,
    );
    prefs.setMoneyPersonalDefaults({ notifications: true });
    await save(true);
    assert.equal(toggles.get("Enable Money HUD"), false);
    pulse();
    assert.match(titles.at(-1), /\$10\.00$/);
    system.currentTick += 20;
    dollars.setScore(buyer.scoreboardIdentity, 1250);
    pulse();
    const reward = titles.at(-1).split("\n")[1];
    await save(true, true);
    pulse();
    assert.equal(titles.at(-1).split("\n")[0].trimEnd(), "~LM3:B§f§l" + "$1.3k".padStart(16));
    assert.equal(titles.at(-1).split("\n")[1], reward);
    await save(true, false);
    pulse();
    assert.equal(titles.at(-1).split("\n")[0], "~LM3:B§f§l" + "$1250.00".padStart(16));
    for (const [i, route] of [..."BCDE"].entries()) {
        await save(true, false, i);
        pulse();
        assert.ok(titles.at(-1).startsWith("~LM3:" + route + "§f§l"));
        assert.equal(titles.at(-1).split("\n")[1], reward);
    }
    world.afterEvents.playerSpawn.emit({ player: buyer, initialSpawn: false });
    pulse();
    assert.ok(titles.at(-1).startsWith("~LM3:E"));
    world.afterEvents.playerLeave.emit({ playerId: buyer.id });
    assert.equal(
        [...intervals.values()].some((timer) => timer.ticks === 1),
        false,
    );
});

test("existing worlds default the HUD on independently of actionbar; personal overrides win on reload", async (t) => {
    const f = await commerceFixture(t);
    f.properties.set(f.CONFIG.MONEY_PERSONAL_DEFAULTS_DP_KEY, JSON.stringify({ actionbar: false, sound: false, compact: true }));
    const { getMoneyPersonalDefaults, setMoneyPersonalDefaults, hasMoneyHud } = await f.load("scripts/modules/players/preferences.js");
    assert.deepEqual(getMoneyPersonalDefaults(), {
        hud: true,
        notifications: true,
        duration: 3,
        position: "Top right",
        sound: false,
        compact: true,
        confirmBuy: true,
        confirmSell: true,
        confirmAuctionBuy: true,
        confirmAuctionList: true,
    });
    setMoneyPersonalDefaults({ hud: false, notifications: false });
    assert.deepEqual(JSON.parse(f.properties.get(f.CONFIG.MONEY_PERSONAL_DEFAULTS_DP_KEY)), {
        hud: false,
        notifications: false,
        duration: 3,
        position: "Top right",
        sound: false,
        compact: true,
        confirmBuy: true,
        confirmSell: true,
        confirmAuctionBuy: true,
        confirmAuctionList: true,
    });
    f.buyer.hasTag = (tag) => tag === f.CONFIG.PLAYER_HUD_ON_TAG;
    assert.equal(hasMoneyHud(f.buyer), true);
    assert.equal(hasMoneyHud(f.seller), false);
    const { tickMoneyDisplay } = await f.load("scripts/modules/economy/display.js");
    f.properties.set(f.CONFIG.MONEY_DISPLAY_SETTINGS_DP_KEY, JSON.stringify({ sidebar: false, belowname: false }));
    f.online.push(f.buyer, f.seller);
    const sent = [];
    f.buyer.onScreenDisplay = f.seller.onScreenDisplay = {
        setTitle(text) {
            sent.push(text);
        },
    };
    tickMoneyDisplay();
    for (const timer of f.intervals.values()) if (timer.ticks === 1) timer.callback();
    assert.deepEqual(sent, ["~LM3:B§f§l          $10.00"]);
});

test("the title itself carries the unencoded wallet and each visible earning", () => {
    const state = newHudSession();
    const frames = [];
    const send = (title) => frames.push(title);
    observeBalance(state, 20, 0);
    updateHud(state, 0, send);
    observeBalance(state, 120, 1, "Job reward");
    updateHud(state, 1, send);
    observeBalance(state, 321, 2, "Shop sale");
    updateHud(state, 2, send);
    assert.deepEqual(displayLines(frames.at(-1)), ["~LM3:B§f§l           $3.21", "§aJob reward §2§l+1.00", "§aShop sale §2§l+2.01"]);
    observeBalance(state, undefined, 6);
    updateHud(state, 6, send);
    assert.deepEqual(displayLines(frames.at(-1)), ["~LM3:B§f§l           $3.21", "§aJob reward §2§l+1.00", "§aShop sale §2§l+2.01"]);
});

test("a reward stays legible through the full hold and leaves the next reward below the wallet", () => {
    const state = newHudSession();
    observeBalance(state, 0, 0);
    enqueueCard(state, 350, "Job reward", 0);
    let title;
    const row = (t) => {
        updateHud(state, t, (v) => {
            title = v;
        });

        return displayLines(title)[1];
    };
    assert.equal(row(0), "§aJob reward §2§l+3.50");
    enqueueCard(state, 150, "Shop sale", 20);
    for (let t = 20; t <= 64; t++) assert.equal(row(t), "§aJob reward §2§l+3.50");
    for (let t = 65; t < 73; t++) assert.equal(row(t), "§aJob reward §2§l+3.50");
    assert.equal(row(73), "§aShop sale §2§l+1.50");
    assert.equal(displayLines(title).length, 2);
});
test("rapid identical credits are counted once each, including credits and debits in the same tick", () => {
    const state = newHudSession();
    observeBalance(state, 0, 0);
    for (let i = 0; i < 40; i++) {
        observeBalance(state, 35, 1, "Job reward");
        observeBalance(state, 35, 1);
        observeBalance(state, 0, 1);
    }
    assert.deepEqual(
        state.rows.map((r) => r.cents),
        [1400, -1400],
    );
    updateHud(state, 1, (s) => assert.match(s, /Job reward §cx40 §2§l\+14\.00/));
    enqueueCard(state, -120, "Shop purchase", 2);
    enqueueCard(state, -120, "Shop purchase", 3);
    updateHud(state, 3, (s) => assert.match(s, /Shop purchase §cx2 §4§l-2\.40/));
});

test("failed sends retry, sessions stay isolated, and idle refresh keeps an unchanged balance alive", () => {
    const a = newHudSession();
    const b = newHudSession();
    observeBalance(a, -1, 0);
    observeBalance(b, 214748364799, 0);
    const result = [];
    const send = (...args) => result.push(args);
    assert.throws(() =>
        updateHud(a, 0, () => {
            throw Error("unavailable");
        }),
    );
    updateHud(a, 1, send);
    updateHud(b, 1, send);
    updateHud(b, 200, send);
    updateHud(a, 601, send);
    assert.deepEqual(
        result.map((x) => x[0]),
        ["~LM3:B§f§l          -$0.01", "~LM3:B§f§l  $2147483647.99", "~LM3:B§f§l          -$0.01"],
    );
});

test("six live and cached notification boxes extract the correct UTF-8 rows beneath the wallet", () => {
    const rp = new URL("../../addon/rp/ui/", import.meta.url);
    const read = (f) => JSON.parse(fs.readFileSync(new URL(f, rp), "utf8"));
    assert.ok(read("_ui_defs.json").ui_defs.includes("ui/lily_money_hud.json"));
    assert.ok(read("hud_screen.json").root_panel.modifications[0].value[0]["lily_money_overlay@lily_money_hud.overlay"]);
    const ui = read("lily_money_hud.json");
    const label = ui.wallet.controls[1].amount;
    assert.equal(label.font_scale_factor, 0.96);
    assert.equal(ui.wallet.controls[2].last_amount.font_scale_factor, 0.96);
    assert.equal(label.anchor_to, "$corner");
    assert.equal(
        label.bindings.find((b) => b.target_property_name === "#text").source_property_name,
        "((((((('%.28s' * #hud_title_text_string) - $route) - '______________________') - '        ') - '    ') - '  ') - ' ')",
    );
    const state = newHudSession();
    observeBalance(state, 0, 0);
    const labels = ["Émeraude", "岩".repeat(60), "Coal", "Diamond", "🐑", "Cow"];
    labels.forEach((text) => enqueueCard(state, 1, text, 0));
    let bytes;
    updateHud(state, 0, (title) => {
        bytes = Buffer.from(title);
    });
    for (const baseName of ["notice_text", "last_notice_text"]) {
        const base = ui[baseName + "@lily_money_hud.card_slot"];
        assert.equal(ui.card_frame.font_scale_factor, label.font_scale_factor);
        assert.ok(ui.card_frame.controls[0]["backdrop@lily_money_hud.text_backdrop"]);
        const expression = base.bindings.find((b) => b.target_property_name === "#card_text").source_property_name;
        const padding = [...expression.matchAll(/ - '(~+)'/g)].map((m) => m[1]);

        for (const [index, text] of labels.entries()) {
            const name = baseName + "_" + (index + 1);
            const key = name + "@lily_money_hud." + baseName;
            const slot = ui.wallet.controls.find((control) => key in control)[key];
            assert.equal(slot.$slot_name, name);
            assert.deepEqual(ui.overlay.controls[1]["top_right@lily_money_hud.wallet"][slot.$position], [0, 16 + 13 * index]);
            const start = Number(slot.$start.slice(2, -1));
            const end = Number(slot.$end.slice(2, -1));
            const afterPhase = Number(slot.$after_phase.slice(2, -1));
            assert.equal(bytes.subarray(start, afterPhase).toString(), "A");
            const raw = bytes.subarray(afterPhase, end).toString();
            assert.equal(
                padding.reduce((s, p) => s.replace(p, ""), raw),
                "§a" + text + " §2§l+0.01",
            );
        }
    }
    assert.equal(ui.wallet.size[0], "100%");
    assert.ok(ui.wallet.size[1] >= 16 + 6 * 12);
    assert.deepEqual(ui.overlay.controls[1]["top_right@lily_money_hud.wallet"].$inset, [-3, 3]);
    assert.doesNotMatch(JSON.stringify(ui), /hud_subtitle_text_string|#alpha|#digit|collection_length/);
});
test("a paid block and kill in one tick reach the next HUD frame individually, even with history disabled", async (t) => {
    const { load, world, properties, scheduled, intervals, CONFIG, buyer, balance, system } = await commerceFixture(t);
    buyer.getTags = () => ["job:miner"];
    properties.set(
        "lilymoney:jobs_v2",
        JSON.stringify({
            v: 2,
            jobs: [{ id: "miner", name: "Miner", rules: { break: { "minecraft:stone": 125 }, kill: { "minecraft:zombie": 10 } } }],
        }),
    );
    await load("scripts/commands/job.js");
    scheduled.shift()();
    const tick = (n) => {
        for (const timer of [...intervals.values()]) if (timer.ticks === n) timer.callback();
    };
    tick(CONFIG.JOBS_INIT_RETRY_INTERVAL_TICKS);
    let title;
    buyer.onScreenDisplay = {
        setTitle(text) {
            title = text;
        },
    };
    const { syncMoneyHud } = await load("scripts/modules/hud/manager.js");
    syncMoneyHud(buyer);
    tick(1);
    assert.equal(title, "~LM3:B§f§l          $10.00");
    world.afterEvents.playerBreakBlock.emit({
        player: buyer,
        block: { typeId: "minecraft:stone", dimension: { id: "overworld" }, location: { x: 1, y: 2, z: 3 } },
    });
    world.afterEvents.entityDie.emit({ deadEntity: { typeId: "minecraft:zombie" }, damageSource: { damagingEntity: buyer } });
    system.currentTick++;
    tick(1);
    assert.equal(balance(buyer), 1135);
    assert.deepEqual(displayLines(title), ["~LM3:B§f§l          $11.35", "§amined stone §cx1 §2§l+1.25", "§akilled zombie §2§l+0.10"]);
    system.currentTick++;
    tick(1);
    assert.equal(displayLines(title).length, 3);
    world.scoreboard.getObjective(CONFIG.MONEY_DOLLAR_OBJECTIVE).setScore(buyer.scoreboardIdentity, 16);
    world.afterEvents.entityDie.emit({ deadEntity: { typeId: "minecraft:zombie" }, damageSource: { damagingEntity: buyer } });
    system.currentTick++;
    tick(1);
    assert.equal(balance(buyer), 1645);
    assert.deepEqual(displayLines(title), [
        "~LM3:B§f§l          $16.45",
        "§amined stone §cx1 §2§l+1.25",
        "§akilled zombie §cx2 §2§l+0.20",
        "§aMoney received §2§l+5.00",
    ]);
});

test("a fading sheep reward brightens again in its original position while the cow retains its own expiry", () => {
    const state = newHudSession();
    observeBalance(state, 0, 0);
    enqueueCard(state, 200, "Killed Sheep", 0, "job:kill:minecraft:sheep");
    enqueueCard(state, 200, "Killed Cow", 25, "job:kill:minecraft:cow");
    let title;
    const render = (t) => {
        updateHud(state, t, (v) => {
            title = v;
        });

        return displayLines(title).slice(1);
    };
    assert.deepEqual(render(66), ["§aKilled Sheep §2§l+2.00", "§aKilled Cow §2§l+2.00"]);
    enqueueCard(state, 100, "Killed Sheep", 66, "job:kill:minecraft:sheep");
    assert.deepEqual(render(70), ["§aKilled Sheep §cx2 §2§l+3.00", "§aKilled Cow §2§l+2.00"]);
    assert.deepEqual(render(99), ["§aKilled Sheep §cx2 §2§l+3.00"]);
});

test("header byte boundary separates each valid balance from smaller multiline text", () => {
    for (const cents of [0, -1, -214748364700, 214748364799]) {
        const s = newHudSession();
        observeBalance(s, cents, 0);
        enqueueCard(s, 1, "Sold Émeraude", 0);
        updateHud(s, 0, (title) => {
            const b = Buffer.from(title);
            assert.equal(b[28], 10);
            assert.equal(b.subarray(29).toString(), "A§aSold Émeraude §2§l+0.01");
        });
    }
});

test("six visible activities retain mining counts across repeats, queue promotion and expiry", () => {
    const state = newHudSession();
    observeBalance(state, 0, 0);
    const mine = (id, t) => enqueueCard(state, 35, "Mined " + id, t, "job:break:minecraft:" + id);
    let title;
    const lines = (t) => {
        updateHud(state, t, (frame) => {
            title = frame;
        });

        return displayLines(title).slice(1);
    };

    for (const id of ["Stone", "Coal", "Iron", "Gold", "Copper"]) mine(id, 0);
    enqueueCard(state, 200, "Killed Sheep", 0, "job:kill:minecraft:sheep");
    mine("Diamond", 1);
    mine("Diamond", 2);
    mine("Stone", 2);
    mine("Stone", 66);
    assert.equal(lines(66).length, 6);
    assert.match(lines(66)[0], /Mined Stone §cx3 §2§l\+1\.05/);
    assert.match(lines(66)[5], /Killed Sheep §2§l\+2\.00/);
    assert.deepEqual(lines(74), ["§aMined Stone §cx3 §2§l+1.05", "§aMined Diamond §cx2 §2§l+0.70"]);
    mine("Stone", 150);
    assert.deepEqual(lines(150), ["§aMined Stone §cx1 §2§l+0.35"]);
});

test("repeated non-mining notices keep their count in the queue and overflow summary", () => {
    const state = newHudSession();
    observeBalance(state, 0, 0);
    for (let i = 0; i < 20; i++) enqueueCard(state, 100, "Sale " + i, 0);
    enqueueCard(state, 25, "Sale 6", 1);
    const lines = (t) => {
        let title;
        updateHud(state, t, (frame) => {
            title = frame;
        });

        return displayLines(title).slice(1);
    };
    assert.equal(lines(74)[0], "§aSale 6 §cx2 §2§l+1.25");
    lines(148);
    assert.deepEqual(lines(222), ["§aOther earnings §cx2 §2§l+2.00"]);
});

test("live and cached wallet bindings remove the wire padding before the background measures the label", () => {
    const ui = JSON.parse(fs.readFileSync(new URL("../../addon/rp/ui/lily_money_hud.json", import.meta.url), "utf8"));

    for (const control of ui.wallet.controls.slice(1, 3)) {
        const label = Object.values(control)[0];
        assert.deepEqual(label.color, [1, 1, 1]);
        const expr = label.bindings.find((b) => b.target_property_name === "#text").source_property_name;
        const spaces = [...expr.matchAll(/ - '( +)'/g)].map((m) => m[1]);

        for (const value of ["$0.00", "$10.00", "-$200.04", "$2147483647.99", "-$2147483647.00"]) {
            assert.equal(
                spaces.reduce((text, pad) => text.replace(pad, ""), value.padStart(16)),
                value,
            );
        }
        assert.ok(label.controls[0]["backdrop@lily_money_hud.text_backdrop"]);
    }
});

test("each exit frame reverses from its current opacity and offset when the same reward returns", () => {
    const ui = JSON.parse(fs.readFileSync(new URL("../../addon/rp/ui/lily_money_hud.json", import.meta.url), "utf8"));
    const poses = new Map(
        ui.card_slot.controls.map((control) => {
            const pose = Object.values(control)[0];

            return [pose.$phase, { ...pose, $shift: ui.overlay.controls[1]["top_right@lily_money_hud.wallet"][pose.$shift] }];
        }),
    );
    assert.ok(ui.card_frame.propagate_alpha);
    for (const step of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const state = newHudSession();
        observeBalance(state, 0, 0);
        enqueueCard(state, 100, "Mined Stone", 0);
        let last;
        const pose = (tick) => {
            updateHud(state, tick, (title) => {
                last = title;
            });

            return poses.get(last.split("\n")[1]?.[0]);
        };
        const entrance = [0, 1, 2, 3, 4].map(pose);

        for (let i = 1; i < entrance.length; i++) {
            assert.ok(entrance[i].$opacity > entrance[i - 1].$opacity);
            assert.ok(entrance[i].$shift[1] < entrance[i - 1].$shift[1]);
        }
        enqueueCard(state, 200, "Killed Cow", 25);
        const outward = [pose(64)];

        for (let i = 1; i <= step; i++) {
            outward.push(pose(64 + i));
            assert.equal(outward[i].$opacity, 1);
            if (i < 8) assert.ok(outward[i].$shift[0] > outward[i - 1].$shift[0]);
            else assert.equal(outward[i].$shift[0], "100% + 8px");
        }
        enqueueCard(state, 50, "Mined Stone", 64 + step);
        for (let i = 0; i <= step; i++) assert.equal(pose(64 + step + i), outward[step - i]);
        assert.match(last, /Mined Stone §cx2 §2§l\+1\.50/);
        assert.equal(state.rows[1].holdUntil, 89);
        const home = 64 + 2 * step;
        assert.equal(pose(home + 60).$phase, "S");
        assert.equal(pose(home + 61).$phase, "E");
        assert.equal(pose(home + 69), undefined);
    }
});

test("idle HUD samples one score pair per 20 ticks and resends its cached wallet at the heartbeat", async (t) => {
    const f = await commerceFixture(t);
    const { syncMoneyHud } = await f.load("scripts/modules/hud/manager.js");
    let reads = 0;

    for (const objective of [f.dollars, f.cents]) {
        const get = objective.getScore;
        objective.getScore = (identity) => {
            reads++;

            return get(identity);
        };
    }
    const titles = [];
    f.buyer.onScreenDisplay = { setTitle: (v) => titles.push(v) };
    syncMoneyHud(f.buyer);
    const pulse = [...f.intervals.values()].find((i) => i.ticks === 1).callback;

    for (let i = 0; i <= 600; i++) {
        f.system.currentTick = i;
        pulse();
    }
    assert.equal(reads, 62);
    assert.deepEqual(titles, ["~LM3:B§f§l          $10.00", "~LM3:B§f§l          $10.00"]);
});

test("stable cards skip title assembly until their exit begins", () => {
    const s = newHudSession();
    observeBalance(s, 0, 0);
    enqueueCard(s, 304, "killed sheep", 0);
    let builds = 0;
    Object.defineProperty(s.rows[0], "description", {
        get() {
            builds++;

            return "killed sheep";
        },
    });
    for (let t = 0; t <= 64; t++) updateHud(s, t, () => {});
    assert.equal(builds, 5);
    updateHud(s, 65, () => {});
    assert.equal(builds, 6);
});

test("HUD visibility ignores legacy actionbar tags and cleanup respects other objectives", async (t) => {
    const f = await commerceFixture(t);
    const { tickMoneyDisplay, clearLegacyMoneyDisplaySlots } = await f.load("scripts/modules/economy/display.js");
    const { DisplaySlotId } = await f.load("node_modules/@minecraft/server/index.js");
    Object.assign(DisplaySlotId, { Sidebar: "sidebar", BelowName: "belowname" });
    f.world.scoreboard.getObjectiveAtDisplaySlot = (slot) => ({
        objective: { id: slot === "sidebar" ? "another_pack" : f.CONFIG.MONEY_DISPLAY_OBJECTIVE },
    });
    const cleared = [];
    f.world.scoreboard.clearObjectiveAtDisplaySlot = (slot) => cleared.push(slot);
    clearLegacyMoneyDisplaySlots();
    assert.deepEqual(cleared, ["belowname"]);
    f.online.push(f.buyer);
    (await f.load("scripts/modules/players/preferences.js")).setMoneyPersonalDefaults({ notifications: false });
    for (const hud of [true, false])
        for (const bar of [true, false]) {
            const tags = [
                hud ? f.CONFIG.PLAYER_HUD_ON_TAG : f.CONFIG.PLAYER_HUD_OFF_TAG,
                bar ? "lilymoney:actionbar_on" : "lilymoney:actionbar_off",
            ];
            f.buyer.hasTag = (tag) => tags.includes(tag);
            const bars = [];
            f.buyer.onScreenDisplay = {
                setTitle() {},
                setActionBar(text) {
                    bars.push(text);
                },
            };
            tickMoneyDisplay();
            assert.equal(
                [...f.intervals.values()].some((timer) => timer.ticks === 1),
                hud,
            );
            assert.equal(bars.length, 0);
        }
});

test("admin defaults select the HUD and corner for unconfigured players, and personal selections override both", async (t) => {
    const f = await commerceFixture(t);
    await f.load("scripts/modules/ui/8crafterUiAuto.js");
    const { registerMoneySettingsCommand } = await f.load("scripts/commands/moneysettings.js");
    const { ModalFormData } = await f.load("node_modules/@minecraft/server-ui/index.js");
    const { getHudPosition, hasMoneyHud, setHudPosition, setMoneyHud } = await f.load("scripts/modules/players/preferences.js");
    const controls = [];
    ModalFormData.prototype.toggle = function (name) {
        controls.push(name);

        return this;
    };
    ModalFormData.prototype.dropdown = function (name, values, options) {
        controls.push(name);
        if (name === "Default HUD Position") assert.equal(values[options.defaultValueIndex], "Top right");

        return this;
    };
    f.buyer.hasTag = (tag) => tag === f.CONFIG.ADMIN_TAG;
    const replies = [
        { selection: 1 },
        { selection: 1 },
        { formValues: [false, 2, true, 2, true, false, true, true, true, true] },
        { selection: 7 },
        { selection: 2 },
    ];
    f.buyer.nextForm = () => replies.shift();
    let run;
    registerMoneySettingsCommand({
        registerCommand(_def, fn) {
            run = fn;
        },
    });
    run({ sourceEntity: f.buyer });
    await f.scheduled.pop()();
    assert.deepEqual(replies, []);
    assert.deepEqual(controls.slice(0, 2), ["HUD Enabled by Default", "Default HUD Position"]);
    assert.equal(hasMoneyHud(f.seller), false);
    assert.equal(getHudPosition(f.seller), "Bottom right");
    const tags = new Set();
    Object.assign(f.seller, { hasTag: (t) => tags.has(t), addTag: (t) => tags.add(t), removeTag: (t) => tags.delete(t) });
    setMoneyHud(f.seller, true);
    setHudPosition(f.seller, "Bottom left");
    assert.equal(getHudPosition(f.seller), "Bottom left");
    assert.equal(hasMoneyHud(f.seller), true);
});

test("each corner routes equal-width packets and stacks all six cards inward with an outward exit", () => {
    const ui = JSON.parse(fs.readFileSync(new URL("../../addon/rp/ui/lily_money_hud.json", import.meta.url), "utf8"));

    for (const [i, corner] of ["top_right", "top_left", "bottom_right", "bottom_left"].entries()) {
        const layout = ui.overlay.controls[i + 1][corner + "@lily_money_hud.wallet"];
        assert.equal(layout.$corner, corner);
        assert.equal(layout.$route, "~LM3:" + "BCDE"[i]);
        const left = corner.endsWith("left");
        const bottom = corner.startsWith("bottom");
        assert.deepEqual(layout.$inset, [left ? 3 : -3, bottom ? -3 : 3]);
        for (let row = 1; row <= 6; row++) assert.equal(layout["$row" + row][1], (bottom ? -1 : 1) * (16 + 13 * (row - 1)));
        assert.equal(layout.$shift_L[0], left ? "-100% - 8px" : "100% + 8px");
    }
});

test("world sidebar reconciles joins, balances and leaves and only controls its own display", async (t) => {
    const f = await commerceFixture(t);
    const { syncMoneySidebar } = await f.load("scripts/modules/economy/display.js");
    const { saveServerOptions } = await f.load("scripts/modules/settings/server.js");
    const scores = new Map();
    const objective = {
        id: f.CONFIG.MONEY_DISPLAY_OBJECTIVE,
        getScore: (id) => scores.get(id),
        setScore: (id, n) => scores.set(id, n),
        removeParticipant: (id) => scores.delete(id),
        getParticipants: () => [...scores.keys()],
    };
    let displayed;
    let created = 0;
    let assigned = 0;
    let cleared = 0;
    const board = f.world.scoreboard;
    const storage = board.getObjective;
    Object.assign(board, {
        getObjectiveAtDisplaySlot: () => displayed && { objective: displayed },
        setObjectiveAtDisplaySlot: (_, d) => {
            assigned++;
            displayed = d.objective;
        },
        clearObjectiveAtDisplaySlot: () => {
            cleared++;
            displayed = undefined;
        },
        getObjective: (id) => (id === objective.id ? (created ? objective : undefined) : storage(id)),
        addObjective: (id) => {
            assert.equal(id, objective.id);
            created++;

            return objective;
        },
    });
    f.online.push(f.buyer);
    syncMoneySidebar();
    assert.equal(created, 0);
    saveServerOptions({ sidebar: true });
    syncMoneySidebar();
    assert.equal(scores.get(f.buyer.scoreboardIdentity), 10);
    f.online.push(f.seller);
    f.dollars.setScore(f.buyer.scoreboardIdentity, 15);
    f.cents.setScore(f.buyer.scoreboardIdentity, 75);
    syncMoneySidebar();
    assert.equal(scores.get(f.buyer.scoreboardIdentity), 15);
    assert.equal(scores.get(f.seller.scoreboardIdentity), 0);
    f.online.shift();
    syncMoneySidebar();
    assert.equal(scores.has(f.buyer.scoreboardIdentity), false);
    assert.equal(assigned, 1);
    displayed = { id: "minigame" };
    syncMoneySidebar();
    saveServerOptions({ sidebar: false });
    syncMoneySidebar();
    assert.equal(cleared, 0);
    assert.equal(displayed.id, "minigame");
    displayed = objective;
    syncMoneySidebar();
    assert.equal(cleared, 1);
    assert.equal(f.balance(f.buyer), 1575);
});
