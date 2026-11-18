import { packFixture } from "./packFixture.mjs";
export async function commerceFixture(t) {
    const fixture = await packFixture(t);
    const { world, load, properties } = fixture;
    const { ItemStack, Player } = await load("node_modules/@minecraft/server/index.js");
    const { CONFIG } = await load("scripts/config.js");
    properties.set(CONFIG.TRANSACTION_LOGGING_DP_KEY, false);
    function objective() {
        const scores = new Map();
        return {
            getParticipants: () => [...scores.keys()],
            getScore: (id) => scores.get(id),
            setScore: (id, n) => scores.set(id, n),
            removeParticipant: (id) => scores.delete(id),
        };
    }
    const dollars = objective(),
        cents = objective();
    world.scoreboard = { getObjective: (id) => (id === CONFIG.MONEY_DOLLAR_OBJECTIVE ? dollars : cents) };
    const online = [];
    world.getAllPlayers = () => online;
    function makePlayer(id, name, balance) {
        const identity = { id };
        const slots = new Array(3);
        const inventory = {
            size: slots.length,
            getItem: (i) => slots[i]?.clone(),
            setItem: (i, stack) => {
                slots[i] = stack?.clone();
            },
        };
        const p = Object.assign(new Player(), {
            id: String(id),
            name,
            scoreboardIdentity: identity,
            getComponent: () => ({ container: inventory }),
            inventory,
            messages: [],
            sendMessage(text) {
                this.messages.push(text);
            },
            getTags: () => [],
            hasTag: () => false,
            playSound() {},
        });
        dollars.setScore(identity, Math.floor(balance / 100));
        cents.setScore(identity, balance % 100);
        return p;
    }
    const seller = makePlayer(7, "Seller", 0),
        buyer = makePlayer(8, "Buyer", 1000);
    const balance = (p) => dollars.getScore(p.scoreboardIdentity) * 100 + cents.getScore(p.scoreboardIdentity);
    return { ...fixture, ItemStack, dollars, cents, seller, buyer, balance, online, CONFIG };
}
