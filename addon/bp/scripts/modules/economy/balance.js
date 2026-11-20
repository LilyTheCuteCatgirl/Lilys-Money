import { recordHudChange } from "../hud/manager.js";
import { world } from "@minecraft/server";
import { CONFIG } from "../../config.js";
import { clampTotalCents } from "./formatting.js";

export function safeGetObjective(name) {
    try {
        return world.scoreboard.getObjective(name);
    } catch {
        return null;
    }
}

export function safeAddObjective(name, displayName) {
    try {
        return world.scoreboard.addObjective(name, displayName ?? name);
    } catch {
        return null;
    }
}

export function ensureMoneyObjectives() {
    let dollarsObj = safeGetObjective(CONFIG.MONEY_DOLLAR_OBJECTIVE);
    if (!dollarsObj) dollarsObj = safeAddObjective(CONFIG.MONEY_DOLLAR_OBJECTIVE, CONFIG.MONEY_DOLLAR_DISPLAY);

    let centsObj = safeGetObjective(CONFIG.MONEY_CENT_OBJECTIVE);
    if (!centsObj) centsObj = safeAddObjective(CONFIG.MONEY_CENT_OBJECTIVE, CONFIG.MONEY_CENT_DISPLAY);

    return { dollarsObj, centsObj };
}

export function getScoreSafe(obj, identityOrPlayer) {
    const id = identityOrPlayer?.scoreboardIdentity ?? identityOrPlayer;
    if (!id) return 0;
    try {
        const v = obj.getScore(id);
        return typeof v === "number" ? v : 0;
    } catch {
        return 0;
    }
}

export function getBalanceCents(dollarsObj, centsObj, player) {
    const d = getScoreSafe(dollarsObj, player);
    const c = getScoreSafe(centsObj, player);
    return d * 100 + c;
}

function readReceiptBalance(dollars, cents, identity) {
    try {
        return (dollars.getScore(identity) ?? 0) * 100 + (cents.getScore(identity) ?? 0);
    } catch {
        return undefined;
    }
}

export function setBalanceFromTotalCents(dollarsObj, centsObj, player, totalCents, description, key) {
    totalCents = clampTotalCents(totalCents);

    const id = player?.scoreboardIdentity;
    if (!id) return;

    const dollars = Math.floor(totalCents / 100);
    const cents = totalCents - dollars * 100; // Keep the cents component between 0 and 99, including for negative balances.

    const before = readReceiptBalance(dollarsObj, centsObj, id);
    let written = true;
    try {
        dollarsObj.setScore(id, dollars);
    } catch {
        written = false;
    }
    try {
        centsObj.setScore(id, cents);
    } catch {
        written = false;
    }
    const after = written ? totalCents : readReceiptBalance(dollarsObj, centsObj, id);
    recordHudChange(player, before, after, written ? description : null, key);
    return written && before !== undefined ? after - before : undefined;
}

export function normalizePlayerIfNeeded(dollarsObj, centsObj, player) {
    const id = player?.scoreboardIdentity;
    if (!id) return;

    const cents = getScoreSafe(centsObj, id);
    if (cents >= 0 && cents <= 99) return;

    const dollars = getScoreSafe(dollarsObj, id);
    const total = dollars * 100 + cents;
    setBalanceFromTotalCents(dollarsObj, centsObj, player, total);
}

export function getStartMoneyCents() {
    try {
        const v = world.getDynamicProperty(CONFIG.START_MONEY_CENTS_DP_KEY);
        if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v));
        if (typeof v === "string" && v.length) return Math.max(0, Math.floor(Number(v)));
    } catch {}
    return 0;
}

export function setStartMoneyCents(cents) {
    const c = Math.max(0, Math.floor(Number(cents) || 0));
    try {
        world.setDynamicProperty(CONFIG.START_MONEY_CENTS_DP_KEY, c);
    } catch {}
    return c;
}

export function addZero(obj, player) {
    const id = player?.scoreboardIdentity;
    if (!id) return false;

    let cur = 0;
    try {
        const v = obj.getScore(id);
        if (typeof v === "number") cur = v;
    } catch {
        cur = 0;
    }

    // Setting even a zero score creates the participant's entry.
    try {
        obj.setScore(id, cur);
        return true;
    } catch {
        return false;
    }
}

export function initMoneyForAllOnlinePlayers() {
    const { dollarsObj, centsObj } = ensureMoneyObjectives();
    if (!dollarsObj || !centsObj) return false;

    const players = world.getAllPlayers();
    if (players.length === 0) return false;

    for (const p of players) {
        addZero(dollarsObj, p);
        addZero(centsObj, p);
    }
    return true;
}
