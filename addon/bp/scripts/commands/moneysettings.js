import { sendChat, chatText } from "../modules/chat.js";
import { CommandPermissionLevel, CustomCommandStatus, Player, system } from "@minecraft/server";
import { getCommandSource } from "../modules/commandSource.js";
import { openSettings } from "../modules/settings/navigation.js";

export function registerMoneySettingsCommand(customCommandRegistry) {
    customCommandRegistry.registerCommand(
        {
            name: "lilymoney:moneysettings",
            description: "Open money settings UI",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const src = getCommandSource(origin);

            if (!(src instanceof Player)) {
                return {
                    status: CustomCommandStatus.Failure,
                    message: chatText("Only players can open settings UI."),
                };
            }

            system.run(() =>
                openSettings(src).catch((error) => {
                    console.warn(`[Money settings] ${error}`);
                    if (src.isValid !== false) sendChat(src, "Settings could not be opened or saved.");
                }),
            );

            return { status: CustomCommandStatus.Success };
        },
    );
}
