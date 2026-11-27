import { clampTotalCents } from "./formatting.js";

// Bedrock inventory, scoreboard and world-property writes are separate operations.
// Keep the commit synchronous and undo completed writes in reverse on failure.
export function runTrade(commit) {
    const undo = [];
    try {
        commit((action) => undo.push(action));

        return true;
    } catch (error) {
        console.warn(`[LilyMoney trade] ${error}`);
        for (const action of undo.reverse()) {
            try {
                action();
            } catch (recoveryError) {
                console.warn(`[LilyMoney trade] Rollback failed. Check inventory, scores and listings: ${recoveryError}`);
            }
        }

        return false;
    }
}

export function changeTradeBalance(dollars, cents, identity, delta, onRollback) {
    if (!identity || !Number.isSafeInteger(delta)) throw new Error("Invalid trade participant or amount.");

    const d = dollars.getScore(identity);
    const c = cents.getScore(identity);
    const next = (d ?? 0) * 100 + (c ?? 0) + delta;
    if (!Number.isSafeInteger(next) || next !== clampTotalCents(next) || (delta < 0 && next < 0))
        throw new Error("Balance no longer supports this trade.");
    function write(objective, old, value) {
        if (old === value) return;
        objective.setScore(identity, value);
        onRollback(() => {
            if (old === undefined) objective.removeParticipant(identity);
            else objective.setScore(identity, old);
        });
    }
    const whole = Math.floor(next / 100);
    write(dollars, d, whole);
    write(cents, c, next - whole * 100);

    return next;
}
