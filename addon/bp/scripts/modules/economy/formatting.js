const MONEY_MIN_TOTAL_CENTS = -2147483647 * 100;
const MONEY_MAX_TOTAL_CENTS = 2147483647 * 100 + 99;

export function clampTotalCents(totalCents) {
    const total = Math.floor(Number(totalCents) || 0);
    if (total < MONEY_MIN_TOTAL_CENTS) return MONEY_MIN_TOTAL_CENTS;
    if (total > MONEY_MAX_TOTAL_CENTS) return MONEY_MAX_TOTAL_CENTS;

    return total;
}

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
    let rounded = Math.round(scaled * 10) / 10;

    // Rounding can promote an amount to the next suffix.
    if (rounded >= 1000 && unit.s !== "t") {
        const nextIndex = units.findIndex((u) => u.s === unit.s) - 1;
        if (nextIndex >= 0) {
            unit = units[nextIndex];
            scaled = absDollars / unit.v;
            rounded = Math.round(scaled * 10) / 10;
        }
    }

    const num = rounded.toFixed(1).replace(/\.0$/, "");

    return `${sign}$${num}${unit.s}`;
}

// Smart keeps exact amounts below one million dollars. Compact starts at one thousand.
export function formatDisplayMoney(cents, options = {}, compact = false) {
    const shorten = options.smart ? Math.abs(cents) >= 100000000 : compact;
    const text = shorten ? formatCentsCompact(cents) : formatCents(cents);
    const decimal = options.decimal === "Comma" ? "," : ".";
    if (/[kmbt]$/.test(text)) return text.replace(".", decimal);

    const [integer, fraction] = text.split(".");
    const separator = { Comma: ",", Period: ".", Space: " " }[options.group];
    const grouped = separator ? integer.replace(/\B(?=(\d{3})+(?!\d))/g, separator) : integer;
    if (options.cents === "Never" || (options.cents === "Hide .00" && fraction === "00")) return grouped;

    return grouped + decimal + fraction;
}
