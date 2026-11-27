import { normalizeTemplate } from "../items/templates.js";
import { getAhNowTicks, AH_ACTIVE_TICKS, AH_EXPIRED_COLLECT_TICKS } from "./clock.js";
import { createDocumentStore } from "../storage/chunkedDocument.js";

export const AH_MAX_PRICE_CENTS = 2147483647 * 100 + 99;
function sanitizeAh(ah) {
    const out = {
        v: 1,
        nextId: Math.max(1, Math.floor(Number(ah?.nextId ?? 1))),
        nextSoldMessageId: Math.max(1, Math.floor(Number(ah?.nextSoldMessageId ?? 1))),
        auctions: [],
        soldMessages: [],
    };

    const arr = Array.isArray(ah?.auctions) ? ah.auctions : [];

    for (const a of arr) {
        const template = normalizeTemplate(a?.template);
        if (!template) continue;

        const amount = Math.max(1, Math.min(255, Math.floor(Number(a?.amount ?? 1))));
        const price = Math.max(0, Math.min(AH_MAX_PRICE_CENTS, Math.floor(Number(a?.price ?? 0))));
        if (price <= 0) continue;

        const status = a?.status === "expired" ? "expired" : "active";
        const sellerIdentityId = String(a?.sellerIdentityId ?? "").trim();
        const sellerName = String(a?.sellerName ?? "Unknown").trim() || "Unknown";

        if (!sellerIdentityId) continue;

        out.auctions.push({
            id: String(a?.id ?? out.nextId++),
            sellerIdentityId,
            sellerName,
            template,
            amount,
            price,
            createdAt: Math.max(0, Math.floor(Number(a?.createdAt ?? getAhNowTicks()))),
            expiresAt: Math.max(0, Math.floor(Number(a?.expiresAt ?? getAhNowTicks() + AH_ACTIVE_TICKS))),
            collectUntil: Math.max(0, Math.floor(Number(a?.collectUntil ?? getAhNowTicks() + AH_ACTIVE_TICKS + AH_EXPIRED_COLLECT_TICKS))),
            status,
        });
    }

    const messages = Array.isArray(ah?.soldMessages) ? ah.soldMessages : [];

    for (const m of messages) {
        const sellerIdentityId = String(m?.sellerIdentityId ?? "").trim();
        if (!sellerIdentityId) continue;

        out.soldMessages.push({
            id: String(m?.id ?? out.nextSoldMessageId++),
            sellerIdentityId,
            buyerName: String(m?.buyerName ?? "Someone").trim() || "Someone",
            itemName: String(m?.itemName ?? "Unknown Item").trim() || "Unknown Item",
            amount: Math.max(1, Math.floor(Number(m?.amount ?? 1))),
            price: Math.max(0, Math.floor(Number(m?.price ?? 0))),
            createdAt: Math.max(0, Math.floor(Number(m?.createdAt ?? getAhNowTicks()))),
        });
    }

    return out;
}

const emptyAh = () => ({ v: 1, nextId: 1, nextSoldMessageId: 1, auctions: [], soldMessages: [] });
const auctionStore = createDocumentStore("lilymoney:ah_v1", 1, {
    initial: emptyAh,
    empty: emptyAh,
    decode(data) {
        if (!Array.isArray(data?.auctions) || (data.soldMessages !== undefined && !Array.isArray(data.soldMessages)))
            throw new Error("Invalid auction database.");

        const clean = sanitizeAh(data);
        if (clean.auctions.length !== data.auctions.length || clean.soldMessages.length !== (data.soldMessages?.length ?? 0))
            throw new Error("Unreadable auction or notification.");
        if (!Number.isSafeInteger(clean.nextId) || !Number.isSafeInteger(clean.nextSoldMessageId))
            throw new Error("Invalid auction counters.");

        const messageIds = new Set(clean.soldMessages.map((m) => m.id));
        if (messageIds.size !== clean.soldMessages.length || messageIds.has(String(clean.nextSoldMessageId)))
            throw new Error("Conflicting sold-message IDs.");

        const ids = new Set(clean.auctions.map((a) => a.id));
        if (ids.size !== clean.auctions.length || ids.has(String(clean.nextId))) throw new Error("Conflicting auction IDs.");

        return clean;
    },
});
export function loadAh() {
    return auctionStore.load();
}
export function saveAh(data) {
    return auctionStore.save(data);
}
