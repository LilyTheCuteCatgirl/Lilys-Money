import { syncMoneyHud } from "../modules/hud/manager.js";
import { CommandPermissionLevel, CustomCommandStatus, Player, system } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";

import { getCommandSource, isAdmin } from "../modules/commandSource.js";
import { getStartMoneyCents, setStartMoneyCents } from "../modules/economy/balance.js";
import { formatCents, parseFloatToCents } from "../modules/economy/formatting.js";
import {
    getMoneyPersonalDefaults,
    setMoneyPersonalDefaults,
    getHudPosition,
    setHudPosition,
    HUD_POSITIONS,
    hasMoneyHud,
    setMoneyHud,
    hasMoneySound,
    setMoneySound,
    hasCompactMoney,
    setCompactMoney,
} from "../modules/players/preferences.js";

import { getMoneyLoggingEnabled, setMoneyLoggingEnabled } from "../modules/logging/moneylogging.js";

export function registerMoneySettingsCommand(customCommandRegistry) {
    customCommandRegistry.registerCommand(
        {
            name: `lilymoney:moneysettings`,
            description: "Open money settings UI",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const src = getCommandSource(origin);

            if (!(src instanceof Player)) {
                return {
                    status: CustomCommandStatus.Failure,
                    message: "Only players can open settings UI.",
                };
            }

            system.run(() => openRoot(src).catch(() => {}));
            return { status: CustomCommandStatus.Success };
        },
    );
}

async function openRoot(player) {
    const admin = isAdmin(player);

    if (!admin) {
        return openPersonalSettings(player);
    }

    const d = getMoneyPersonalDefaults();
    const start = getStartMoneyCents();
    const transactionLogging = getMoneyLoggingEnabled();

    const s = hasMoneySound(player);
    const c = hasCompactMoney(player);

    const body =
        `§d§lAdmin settings:\n` +
        `§r§8Default money HUD: ${d.hud ? "§2§lON" : "§c§lOFF"}\n` +
        `§r§8Default HUD position: ${d.position}
` +
        `§r§8Default money sound: ${d.sound ? "§2§lON" : "§c§lOFF"}\n` +
        `§r§8Default compact numbers: ${d.compact ? "§2§lON" : "§c§lOFF"}  §r§l|  ` +
        `§r§8Money history logging: ${transactionLogging ? "§2§lON" : "§c§lOFF"}\n` +
        `§r§8Start money: §e${formatCents(start)}\n\n` +
        `§r§eYour personal settings:\n` +
        `§r§8Money HUD: ${hasMoneyHud(player) ? "§2§lON" : "§c§lOFF"}\n` +
        `§r§8HUD position: ${getHudPosition(player)}
` +
        `§r§8Money sound: ${s ? "§2§lON" : "§c§lOFF"}\n` +
        `§r§8Compact numbers: ${c ? "§2§lON" : "§c§lOFF"}`;

    const form = new ActionFormData()
        .title("§d§lMoney Settings§r")
        .body(body)
        .button("§d§lEdit Admin settings", "textures/ui/settings_glyph_color_2x")
        .button("§e§lEdit Personal settings", "textures/ui/settings_glyph_color_2x")
        .button("§c§lClose", "textures/ui/cancel");

    const res = await form.show(player);
    if (res.canceled) return;

    if (res.selection === 0) return openAdminSettings(player);
    if (res.selection === 1) return openPersonalSettings(player);
}

async function openAdminSettings(player) {
    const curDefaults = getMoneyPersonalDefaults();
    const startCents = getStartMoneyCents();
    const transactionLogging = getMoneyLoggingEnabled();

    const form = new ModalFormData()
        .title("§d§lAdmin settings§r")
        .toggle("Default Money HUD", { defaultValue: curDefaults.hud })
        .dropdown("Default HUD position", HUD_POSITIONS, { defaultValueIndex: HUD_POSITIONS.indexOf(curDefaults.position) })
        .toggle("Default money sound for players ", { defaultValue: !!curDefaults.sound })
        .toggle("Default compact numbers for players ", { defaultValue: !!curDefaults.compact })
        .textField(`Money given on first join  (currently ${formatCents(startCents)})`, "ex: 0   or   10.50", {
            defaultValue: String(startCents / 100),
        })
        .toggle("Persistent money history logging", { defaultValue: transactionLogging });

    const res = await form.show(player);
    if (res.canceled) return openRoot(player);

    const defaultHud = !!res.formValues?.[0];
    const defaultSound = !!res.formValues?.[2];
    const defaultCompact = !!res.formValues?.[3];
    const startRaw = String(res.formValues?.[4] ?? "").trim();
    const transactionLoggingEnabled = !!res.formValues?.[5];

    const loggingChanged = transactionLoggingEnabled !== transactionLogging;
    if (loggingChanged) {
        const loggingSaved = setMoneyLoggingEnabled(transactionLoggingEnabled, player);

        if (!loggingSaved) {
            player.sendMessage("§r<§dLily's Money§r> §cMoney logging could not be changed safely. Check the Content Log for details.");
        }
    }

    setMoneyPersonalDefaults({
        hud: defaultHud,
        position: HUD_POSITIONS[res.formValues[1]],
        sound: defaultSound,
        compact: defaultCompact,
    });

    const startNum = Number(startRaw.replace(",", "."));

    if (Number.isFinite(startNum) && startNum >= 0) {
        const parsed = parseFloatToCents(startNum, false);

        if (parsed.ok) {
            setStartMoneyCents(parsed.cents);
        } else {
            player.sendMessage("§r<§dLily's Money§r> §r" + "§c§lStart money: use at most 2 decimals. Keeping previous value.");
        }
    } else {
        player.sendMessage("§r<§dLily's Money§r> §r" + "§c§lStart money: invalid number. Keeping previous value.");
    }

    player.sendMessage("§r<§dLily's Money§r> §r" + "§aAdmin settings updated.");
    return openRoot(player);
}

async function openPersonalSettings(player) {
    const curHud = hasMoneyHud(player);
    const curPosition = getHudPosition(player);
    const curSound = hasMoneySound(player);
    const curCompact = hasCompactMoney(player);

    const form = new ModalFormData()
        .title("§e§lPersonal settings§r")
        .toggle("§rMoney HUD", { defaultValue: curHud })
        .dropdown("HUD position", HUD_POSITIONS, { defaultValueIndex: HUD_POSITIONS.indexOf(curPosition) })
        .toggle("§rMoney sound (blinggg)", { defaultValue: curSound })
        .toggle("§rCompact numbers (1.2k / 3.4m)", { defaultValue: curCompact });

    const res = await form.show(player);
    if (res.canceled) return;

    const [hud, positionIndex, sound, compact] = res.formValues;
    const position = HUD_POSITIONS[positionIndex];
    if (hud !== curHud) setMoneyHud(player, hud);
    if (position !== curPosition) setHudPosition(player, position);
    if (sound !== curSound) setMoneySound(player, sound);
    if (compact !== curCompact) setCompactMoney(player, compact);
    syncMoneyHud(player);

    player.sendMessage("§r<§dLily's Money§r> §r" + "§aPersonal settings updated.");
}
