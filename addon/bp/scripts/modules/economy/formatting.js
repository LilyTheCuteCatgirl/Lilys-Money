const MONEY_MIN_TOTAL_CENTS = -2147483647 * 100;
const MONEY_MAX_TOTAL_CENTS = 2147483647 * 100 + 99;

/* =========================================================
   MONEY MATH (total cents)
========================================================= */

export function clampTotalCents(totalCents) {
    const total = Math.floor(Number(totalCents) || 0);
    if (total < MONEY_MIN_TOTAL_CENTS) return MONEY_MIN_TOTAL_CENTS;
    if (total > MONEY_MAX_TOTAL_CENTS) return MONEY_MAX_TOTAL_CENTS;
    return total;
}

/* =========================================================
   MONEY PARSE + FORMAT (Float -> cents)
========================================================= */
export function parseFloatToCents(value, allowNegative = false) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, error: "Invalid number." };
    }
    if (!allowNegative && value < 0) {
        return { ok: false, error: "Negative amounts not allowed here." };
    }

    const scaled = value * 100;
    const rounded = Math.round(scaled);

    if (Math.abs(scaled - rounded) > 0.01) {
        return { ok: false, error: "Use at most 2 decimals." };
    }

    return { ok: true, cents: rounded };
}

export function formatCents(totalCents) {
    const sign = totalCents < 0 ? "-" : "";
    const abs = Math.abs(totalCents);
    const d = Math.floor(abs / 100);
    const c = abs % 100;
    return `${sign}$${d}.${String(c).padStart(2, "0")}`;
}

export function formatCentsCompact(totalCents) {
    const sign = totalCents < 0 ? "-" : "";
    const absDollars = Math.abs(totalCents) / 100;

    // under 1000: keep normal formatting (keeps cents)
    if (absDollars < 1000) return formatCents(totalCents);

    const units = [
        { v: 1e12, s: "t" },
        { v: 1e9, s: "b" },
        { v: 1e6, s: "m" },
        { v: 1e3, s: "k" },
    ];

    let unit = units[units.length - 1];
    for (const u of units) {
        if (absDollars >= u.v) {
            unit = u;
            break;
        }
    }

    let scaled = absDollars / unit.v;
    let rounded = Math.round(scaled * 10) / 10; // 1 decimal

    // handle edge like 999.95k => 1000.0k -> 1.0m
    if (rounded >= 1000 && unit.s !== "t") {
        const nextIndex = units.findIndex((u) => u.s === unit.s) - 1;
        if (nextIndex >= 0) {
            unit = units[nextIndex];
            scaled = absDollars / unit.v;
            rounded = Math.round(scaled * 10) / 10;
        }
    }

    let num = rounded.toFixed(1).replace(/\.0$/, ""); // remove trailing .0
    return `${sign}$${num}${unit.s}`;
}
