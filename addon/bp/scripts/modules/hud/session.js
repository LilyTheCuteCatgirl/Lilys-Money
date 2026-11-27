import { formatCents, formatDisplayMoney } from "../economy/formatting.js";

const ENTER = 4;
function hold(state) {
    return (state.options?.duration ?? 3) * 20;
}
const EXIT_PHASES = "EFGHIJKL";
const ROWS = 6;

export function newHudSession() {
    return { route: "B", rows: [], waiting: [], observed: undefined, lastTitle: undefined, refreshAt: 0, nextFrame: 0, compact: false };
}

function expire(state, now) {
    state.rows = state.rows.filter((row) => now < row.holdUntil + EXIT_PHASES.length + 1);
    while (state.waiting.length && state.rows.length < ROWS) {
        state.rows.push({ ...state.waiting.shift(), start: now, holdUntil: now + ENTER + hold(state) });
    }
}

function cardGroup(description, key) {
    if (key?.startsWith("job:")) return "job";
    if (/^(Shop:|Bought |Sold )/.test(description)) return "shop";
    if (description.startsWith("Auction:")) return "auction";
    if (/^(Paid |Received from )/.test(description)) return "payment";
    if (["Money added", "Money removed", "Balance set"].includes(description)) return "admin";

    return "other";
}
export function enqueueCard(state, cents, description, now, key = description, itemQuantity) {
    const group = cardGroup(description, key);
    const options = state.options ?? {};
    if (options.notifications === false || options[group] === false || (cents < 0 && options.spending === false)) return;
    state.nextFrame = 0;
    expire(state, now);
    const sign = Math.sign(cents);
    const matches = (row) => options.combine !== false && row.key === key && Math.sign(row.cents) === sign;
    const active = state.rows.find(matches);
    if (active) {
        active.count++;
        if (itemQuantity !== undefined) active.itemQuantity += itemQuantity;
        active.cents += cents;
        if (now >= active.holdUntil) {
            // Retrace only the part of the exit this card has already travelled.
            active.returnUntil = now + (now - active.holdUntil);
        }
        active.holdUntil = Math.max(now, active.start + ENTER, active.returnUntil ?? 0) + hold(state);

        return;
    }

    const label = description
        .replace(/§.|[\r\n\t]/g, " ")
        .replace(/~LM3:/g, "")
        .trim()
        .slice(0, 60);
    const row = { key, group, description: label, cents, count: 1, itemQuantity };
    if (state.rows.length < ROWS) {
        state.rows.push({ ...row, start: now, holdUntil: now + ENTER + hold(state) });

        return;
    }

    const queued = state.waiting.find(matches);
    if (queued) {
        queued.cents += cents;
        queued.count++;
        if (itemQuantity !== undefined) queued.itemQuantity += itemQuantity;
    } else if (state.waiting.length < 12) state.waiting.push(row);
    else {
        const summaryKey = sign > 0 ? "overflow-credit" : "overflow-debit";
        const summary = state.waiting.find((entry) => entry.key === summaryKey);
        if (summary) {
            summary.cents += cents;
            summary.count++;
        } else state.waiting.push({ key: summaryKey, description: sign > 0 ? "Other earnings" : "Other spending", cents, count: 1 });
    }
}

export function observeBalance(state, total, now, description, key, itemQuantity) {
    if (total === undefined) return;
    if (description !== null && state.observed !== undefined && total !== state.observed) {
        const delta = total - state.observed;
        enqueueCard(state, delta, description ?? (delta > 0 ? "Money received" : "Money spent"), now, key, itemQuantity);
    }
    if (total !== state.observed) state.nextFrame = 0;
    state.observed = total;
}

// Each nonfinal row occupies 256 UTF-8 bytes so JSON UI can extract its label independently.
function notificationLine(row, now, options) {
    let phase = "S";
    if (now >= row.holdUntil || now < row.returnUntil) {
        const step = now >= row.holdUntil ? now - row.holdUntil : row.returnUntil - now;
        if (step > 0) phase = EXIT_PHASES[step - 1];
    } else if (now < row.start + ENTER) {
        phase = "ABCD"[now - row.start];
    }
    if (options?.animate === false) phase = "S";

    const credit = row.cents > 0;
    const color = credit ? "§a" : "§c";
    const amount = (credit ? "+" : "") + formatCents(row.cents).replace("$", "");
    let count = options?.quantity !== false && (row.count > 1 || row.key.startsWith("job:break:")) ? ` §cx${row.count}` : "";
    let label =
        options?.names === false
            ? ({ job: "Job reward", shop: "Shop transaction", auction: "Auction transaction" }[row.group] ?? row.description)
            : row.description;
    if (row.itemQuantity !== undefined && options?.quantity !== false) {
        if (options?.names === false) count = ` §cx${row.itemQuantity}`;
        else {
            label = label.replace(/^Auction: bought /, `Auction: bought x${row.itemQuantity} `);
            count = "";
        }
    }

    return phase + color + label.replace(/~/g, "～") + count + (credit ? " §2§l" : " §4§l") + amount;
}

function padRow(line) {
    let bytes = 0;

    for (const char of line) {
        const point = char.codePointAt(0);
        bytes += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
    }

    return line + "~".repeat(256 - bytes);
}

export function updateHud(state, now, send, compact = false) {
    if (state.observed === undefined) return;
    if (now < state.nextFrame && compact === state.compact) {
        if (now >= state.refreshAt) {
            send(state.lastTitle);
            state.refreshAt = now + 600;
        }

        return;
    }
    expire(state, now);
    let balance = formatDisplayMoney(state.observed, state.options, compact);
    // The wallet label strips ASCII padding spaces and reserves 16 bytes for the amount.
    // Use a nonbreaking space inside grouped numbers if it fits the packet.
    balance = balance.replace(/ /g, "\u00a0");
    let bytes = balance.length + (balance.match(/\u00a0/g)?.length ?? 0);
    if (bytes > 16) {
        balance = formatDisplayMoney(state.observed, { ...state.options, group: "None" }, compact);
        bytes = balance.length;
    }

    const color = { Pink: "§d", Purple: "§5", Gold: "§6", Green: "§a" }[state.options?.color] ?? "§f";
    // Both styles occupy six UTF-8 bytes, keeping receipt offsets fixed for every color.
    const style = state.options?.boldBalance === false ? "§r" + color : color + "§l";
    const header = state.wallet === false ? "_".repeat(22) : style + " ".repeat(16 - bytes) + balance;
    const lines = [`~LM3:${state.route}` + header, ...state.rows.map((row) => notificationLine(row, now, state.options))];
    const title =
        state.wallet === false && !state.rows.length
            ? "~LM3:R"
            : lines.map((line, i) => (i > 0 && i < lines.length - 1 ? padRow(line) : line)).join("\n");
    if (title !== state.lastTitle || now >= state.refreshAt) {
        send(title);
        state.lastTitle = title;
        state.refreshAt = now + 600;
    }
    state.compact = compact;
    state.nextFrame = Infinity;
    for (const row of state.rows) {
        const moving = now < row.start + ENTER || now < row.returnUntil || now >= row.holdUntil;
        state.nextFrame = Math.min(state.nextFrame, moving ? now + 1 : row.holdUntil + 1);
    }
}
