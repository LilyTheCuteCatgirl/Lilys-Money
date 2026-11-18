import { ItemTypes } from "@minecraft/server";

function safeIsValidItemId(id) {
    try {
        return !!ItemTypes.get(id);
    } catch {
        return false;
    }
}

function normalizeLooseId(raw) {
    const s = String(raw ?? "")
        .trim()
        .toLowerCase();
    if (!s) return null;
    return s.includes(":") ? s : `minecraft:${s}`;
}

export function normalizeItemId(raw) {
    const id = normalizeLooseId(raw);
    return id && safeIsValidItemId(id) ? id : null;
}

export function getItemType(id) {
    try {
        return ItemTypes.get(id);
    } catch {
        return null;
    }
}

export function shortItemName(id) {
    const s = String(id ?? "");
    if (s.startsWith("minecraft:")) return s.slice("minecraft:".length);
    const i = s.indexOf(":");
    return i !== -1 ? s.slice(i + 1) : s;
}

export function niceIdName(id) {
    const s = shortItemName(id);
    return s
        .split("_")
        .map((p) => (p.length ? p[0].toUpperCase() + p.slice(1) : p))
        .join(" ");
}

export function stripColors(text) {
    return String(text ?? "").replace(/§./g, "");
}

export function romanLevel(n) {
    const level = Math.floor(Number(n));
    if (level <= 0) return String(n);

    const romans = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
    if (level >= 1 && level <= 10) return romans[level];

    return String(level);
}

export function isShulkerBoxId(id) {
    const s = String(id ?? "").toLowerCase();
    return s === "minecraft:shulker_box" || s.endsWith("_shulker_box");
}

export function searchTokens(raw) {
    return String(raw ?? "")
        .toLowerCase()
        .replace(/^minecraft:/, "")
        .replace(/[_:\-]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
}
