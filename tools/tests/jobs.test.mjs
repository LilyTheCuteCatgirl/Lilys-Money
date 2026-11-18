import assert from "node:assert/strict";
import test from "node:test";
import { commerceFixture } from "./commerceFixture.mjs";

test("job events pay natural breaks once, honor placed-block protection and retry buffered statistics", async (t) => {
    const { load, world, properties, scheduled, intervals, CONFIG, buyer, balance } = await commerceFixture(t);
    const job = {
        id: "miner",
        name: "Miner",
        rules: { break: { "minecraft:stone": 125 }, place: {}, kill: { "minecraft:zombie": 10 } },
        allowPlacedBreak: false,
    };
    properties.set("lilymoney:jobs_v2", JSON.stringify({ v: 2, jobs: [job] }));
    buyer.getTags = () => ["job:miner"];
    await load("scripts/commands/job.js");
    scheduled.shift()();
    const tick = (n) => {
        for (const interval of [...intervals.values()]) if (interval.ticks === n) interval.callback();
    };
    tick(CONFIG.JOBS_INIT_RETRY_INTERVAL_TICKS ?? 20);
    const block = { typeId: "minecraft:stone", dimension: { id: "overworld" }, location: { x: 1, y: 2, z: 3 } };
    world.afterEvents.playerPlaceBlock.emit({ player: buyer, block });
    world.afterEvents.playerBreakBlock.emit({ player: buyer, block });
    assert.equal(balance(buyer), 1000);
    world.afterEvents.playerBreakBlock.emit({ player: buyer, block });
    world.afterEvents.entityDie.emit({ deadEntity: { typeId: "minecraft:zombie" }, damageSource: { damagingEntity: buyer } });
    assert.equal(balance(buyer), 1135);
    const stats = "lilymoney:job_stats_v1";
    properties.set(stats, "{damaged");
    tick(CONFIG.JOB_STATS_FLUSH_INTERVAL_TICKS ?? 400);
    assert.equal(properties.get(stats), "{damaged");
    properties.delete(stats);
    const write = world.setDynamicProperty;
    world.setDynamicProperty = (k, v) => {
        if (k === stats) throw Error("stats write failed");
        write(k, v);
    };
    tick(CONFIG.JOB_STATS_FLUSH_INTERVAL_TICKS ?? 400);
    world.setDynamicProperty = write;
    tick(CONFIG.JOB_STATS_FLUSH_INTERVAL_TICKS ?? 400);
    tick(CONFIG.JOB_STATS_FLUSH_INTERVAL_TICKS ?? 400);
    const saved = JSON.parse(properties.get(stats)).players.Buyer;
    assert.equal(saved.totalEarnedCents, 135);
    assert.deepEqual(saved.jobs.miner, { earnedCents: 135, breakCount: 1, placeCount: 0, killCount: 1, pickupCount: 0 });
});
