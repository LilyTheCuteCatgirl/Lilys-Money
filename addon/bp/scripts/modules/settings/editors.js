import { sendChat } from "../chat.js";
import { serverOptions, saveServerOptions, serverFields } from "./server.js";
import { editFields } from "./fields.js";
import {
    getMoneyPersonalDefaults,
    setMoneyPersonalDefaults,
    getHudPosition,
    setHudPosition,
    HUD_POSITIONS,
    DURATIONS,
    getDisplayOptions,
    saveDisplayOptions,
    hasMoneyHud,
    setMoneyHud,
    hasMoneySound,
    setMoneySound,
    hasCompactMoney,
    setCompactMoney,
} from "../players/preferences.js";
import { syncMoneyHud } from "../hud/manager.js";
import { getStartMoneyCents, setStartMoneyCents } from "../economy/balance.js";
import { getMoneyLoggingEnabled, setMoneyLoggingEnabled } from "../logging/moneylogging.js";

const personal = {
    "Shop Purchases": [["confirmBuy", "Confirm Shop Purchases (when enabled by server)"]],
    "Basic HUD Settings": [
        ["hud", "Enable Money HUD"],
        ["position", "HUD Position", HUD_POSITIONS],
    ],
    "General Notifications": [
        ["notifications", "Enable HUD Notifications"],
        ["duration", "Notification Duration (seconds)", DURATIONS],
        ["combine", "Combine Repeated Notifications"],
        ["animate", "Enable Notification Animations"],
    ],
    "Notification Categories": [
        ["job", "Job Reward Notifications"],
        ["shop", "Shop Notifications"],
        ["auction", "Auction House Notifications"],
        ["payment", "Player Payment Notifications"],
        ["admin", "Admin Money Change Notifications"],
        ["other", "Other Scoreboard Money Change Notifications"],
    ],
    "Notification Details": [
        ["spending", "Show Spending Notifications"],
        ["names", "Show Item/Mob Names"],
        ["quantity", "Show Notification Quantity"],
    ],
    "Sound Events": [
        ["receiveSound", "Sound When Receiving Money"],
        ["spendSound", "Sound When Spending Money"],
        ["jobSound", "Job Reward Sound"],
        ["auctionSound", "Auction Sale Sound"],
    ],
    "HUD Theme & Effects": [
        ["color", "HUD Text Color", ["White", "Pink", "Purple", "Gold", "Green"]],
        ["boldBalance", "Bold Balance Text"],
    ],
    "Number Formatting": [
        ["mode", "Money Display Format", ["Full", "Compact", "Smart"]],
        ["cents", "Display Cents", ["Always", "Hide .00", "Never"]],
        ["group", "Thousands Separator", ["None", "Comma", "Period", "Space"]],
        ["decimal", "Decimal Separator", ["Period", "Comma"]],
    ],
    "General Sound Settings": [
        ["sound", "Enable Money Sounds"],
        ["volume", "Sound Volume (%)", [25, 50, 75, 100]],
        ["effect", "Money Sound Effect", ["XP Orb", "Coin", "Soft"]],
        ["combineSound", "Combine Rapid Repeated Sounds"],
    ],
};
const defaults = [
    ["hud", "HUD Enabled by Default"],
    ["position", "Default HUD Position", HUD_POSITIONS],
    ["notifications", "Notifications Enabled by Default"],
    ["duration", "Default Notification Duration (seconds)", DURATIONS],
    ["sound", "Money Sounds Enabled by Default"],
    ["compact", "Compact Numbers Enabled by Default"],
];
function money(raw) {
    if (!/^\d+(?:[.,]\d{1,2})?$/.test(raw)) return;
    const amount = Number(raw.replace(",", "."));
    if (amount <= 2147483647.99) return amount;
}
export function editorFor(name, p) {
    if (serverFields[name]) return [serverFields[name], serverOptions, saveServerOptions];
    if (personal[name])
        return [
            personal[name],
            () => ({
                ...getDisplayOptions(p),
                hud: hasMoneyHud(p),
                position: getHudPosition(p),
                sound: hasMoneySound(p),
                mode: getDisplayOptions(p).smart ? "Smart" : hasCompactMoney(p) ? "Compact" : "Full",
            }),
            (changes) => {
                const next = { ...getDisplayOptions(p), ...changes };
                if (next.group === next.decimal) return sendChat(p, "Choose different thousands and decimal separators.");
                if ("mode" in changes && (next.smart || changes.mode === "Smart")) changes.smart = changes.mode === "Smart";
                if ("hud" in changes) setMoneyHud(p, changes.hud);
                if ("position" in changes) setHudPosition(p, changes.position);
                if ("sound" in changes) setMoneySound(p, changes.sound);
                if ("mode" in changes) setCompactMoney(p, changes.mode === "Compact");
                const options = Object.fromEntries(
                    Object.entries(changes).filter(([key]) => !["hud", "position", "sound", "mode"].includes(key)),
                );
                if (Object.keys(options).length) saveDisplayOptions(p, options);
                syncMoneyHud(p);
            },
        ];
    if (name === "Default Player Settings") return [defaults, getMoneyPersonalDefaults, setMoneyPersonalDefaults];
    if (name === "General Economy")
        return [
            [
                ["start", "Starting Money", "text", money],
                ["pay", "Enable /pay"],
            ],
            () => ({ start: getStartMoneyCents() / 100, pay: serverOptions().pay }),
            (v) => {
                const before = getStartMoneyCents();
                if ("start" in v) setStartMoneyCents(Math.round(v.start * 100));
                try {
                    if ("pay" in v) saveServerOptions({ pay: v.pay });
                } catch (error) {
                    if ("start" in v) setStartMoneyCents(before);
                    throw error;
                }
            },
        ];
    if (name === "Logging & History")
        return [
            [["logging", "Enable Persistent Transaction Logging"]],
            () => ({ logging: getMoneyLoggingEnabled() }),
            (v) => {
                if (!setMoneyLoggingEnabled(v.logging, p)) sendChat(p, "Logging could not be changed safely.");
            },
        ];
}
export async function showEditor(player, title, admin, editor) {
    return editFields(player, title, admin, ...editor);
}
