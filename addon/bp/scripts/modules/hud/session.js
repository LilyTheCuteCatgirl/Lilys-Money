import { formatCents, formatCentsCompact } from "../economy/formatting.js";

const ENTER = 4;
const HOLD = 60;
const EXIT_PHASES = "EFGHIJKL";
const ROWS = 6;

export function newHudSession() {
    return { route: "B", rows: [], waiting: [], observed: undefined, lastTitle: undefined, refreshAt: 0, nextFrame: 0, compact: false };
}

function expire(state, now) {
    state.rows = state.rows.filter((row) => now < row.holdUntil + EXIT_PHASES.length + 1);
    while (state.waiting.length && state.rows.length < ROWS) {
        state.rows.push({ ...state.waiting.shift(), start: now, holdUntil: now + ENTER + HOLD });
    }
}

export function enqueueCard(state, cents, description, now, key = description) {
    state.nextFrame = 0;
    expire(state, now);
    const sign = Math.sign(cents);
    const matches = (row) => row.key === key && Math.sign(row.cents) === sign;
    const active = state.rows.find(matches);
    if (active) {
        active.count++;
        active.cents += cents;
        if (now >= active.holdUntil) {
            // Retrace only the part of the exit this card has already travelled.
            active.returnUntil = now + (now - active.holdUntil);
        }
        active.holdUntil = Math.max(now, active.start + ENTER, active.returnUntil ?? 0) + HOLD;
        return;
    }
    const label = description
        .replace(/§.|[\r\n\t]/g, " ")
        .replace(/~LM3:/g, "")
        .trim()
        .slice(0, 60);
    const row = { key, description: label, cents, count: 1 };
    if (state.rows.length < ROWS) {
        state.rows.push({ ...row, start: now, holdUntil: now + ENTER + HOLD });
        return;
    }
    const queued = state.waiting.find(matches);
    if (queued) {
        queued.cents += cents;
        queued.count++;
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

export function observeBalance(state, total, now, description, key) {
    if (total === undefined) return;
    if (description !== null && state.observed !== undefined && total !== state.observed) {
        const delta = total - state.observed;
        enqueueCard(state, delta, description ?? (delta > 0 ? "Money received" : "Money spent"), now, key);
    }
    if (total !== state.observed) state.nextFrame = 0;
    state.observed = total;
}

// Each nonfinal row occupies 256 UTF-8 bytes so JSON UI can extract its label independently.
function notificationLine(row, now) {
    let phase = "S";
    if (now >= row.holdUntil || now < row.returnUntil) {
        const step = now >= row.holdUntil ? now - row.holdUntil : row.returnUntil - now;
        if (step > 0) phase = EXIT_PHASES[step - 1];
    } else if (now < row.start + ENTER) {
        phase = "ABCD"[now - row.start];
    }
    const credit = row.cents > 0;
    const color = credit ? "§a" : "§c";
    const amount = (credit ? "+" : "") + formatCents(row.cents).replace("$", "");
    const count = row.count > 1 || row.key.startsWith("job:break:") ? ` §cx${row.count}` : "";
    return phase + color + row.description.replace(/~/g, "～") + count + (credit ? " §2§l" : " §4§l") + amount;
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
    const balance = compact ? formatCentsCompact(state.observed) : formatCents(state.observed);
    const lines = [`~LM3:${state.route}§l` + balance.padStart(16), ...state.rows.map((row) => notificationLine(row, now))];
    const title = lines.map((line, i) => (i > 0 && i < lines.length - 1 ? padRow(line) : line)).join("\n");
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
