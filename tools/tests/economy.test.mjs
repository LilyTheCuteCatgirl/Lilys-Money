import assert from "node:assert/strict";
import test from "node:test";
import { clampTotalCents, parseFloatToCents, formatCents, formatCentsCompact } from "../../addon/bp/scripts/modules/economy/formatting.js";
import { packFixture } from "./packFixture.mjs";

test("currency parsing preserves two decimals, sign policy and scoreboard limits", () => {
    for (const invalid of [NaN, Infinity, -Infinity, null, "2", 1.234, -0.01]) assert.equal(parseFloatToCents(invalid).ok, false);
    for (const [amount, cents] of [
        [0, 0],
        [0.29, 29],
        [-0.01, -1],
        [2147483647.99, 214748364799],
    ])
        assert.deepEqual(parseFloatToCents(amount, true), { ok: true, cents });
    assert.equal(clampTotalCents(-Infinity), -214748364700);
    assert.equal(clampTotalCents(Infinity), 214748364799);
    assert.equal(clampTotalCents(NaN), 0);
});
test("currency display handles small debts and compact rounding boundaries", () => {
    assert.equal(formatCents(-1), "-$0.01");
    assert.equal(formatCents(214748364799), "$2147483647.99");
    assert.equal(formatCentsCompact(99999), "$999.99");
    assert.equal(formatCentsCompact(100000), "$1k");
    assert.equal(formatCentsCompact(-99995000), "-$1m");
});
test("negative totals use nonnegative cents and normalization preserves value", async (t) => {
    const { load } = await packFixture(t);
    const { getBalanceCents, setBalanceFromTotalCents, normalizePlayerIfNeeded } = await load("scripts/modules/economy/balance.js");
    const player = { scoreboardIdentity: { id: 1 } };
    const objective = () => ({
        scores: new Map(),
        setScore(id, n) {
            this.scores.set(id, n);
        },
        getScore(id) {
            return this.scores.get(id);
        },
    });
    const dollars = objective();
    const cents = objective();

    for (const total of [-214748364700, -101, -1, 0, 99, 214748364799]) {
        setBalanceFromTotalCents(dollars, cents, player, total);
        assert.equal(getBalanceCents(dollars, cents, player), total);
        assert.ok(cents.getScore(player.scoreboardIdentity) >= 0 && cents.getScore(player.scoreboardIdentity) < 100);
    }
    dollars.setScore(player.scoreboardIdentity, 2);
    cents.setScore(player.scoreboardIdentity, -201);
    normalizePlayerIfNeeded(dollars, cents, player);
    assert.equal(dollars.getScore(player.scoreboardIdentity), -1);
    assert.equal(cents.getScore(player.scoreboardIdentity), 99);
});
