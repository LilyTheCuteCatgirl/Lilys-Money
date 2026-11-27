import { chatText } from "../modules/chat.js";
import { CommandPermissionLevel, CustomCommandParamType, Player, CustomCommandStatus, system, world } from "@minecraft/server";
import { getCommandSource } from "../modules/commandSource.js";
import { openShopEntry } from "../modules/shop/ui.js";

export function registerShopCommand(customCommandRegistry) {
    customCommandRegistry.registerCommand(
        {
            name: "lilymoney:shop",
            description: "Open the shop UI",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
            optionalParameters: [{ name: "item", type: CustomCommandParamType.String }],
        },
        (origin, itemQuery) => {
            const src = getCommandSource(origin);

            if (!(src instanceof Player)) {
                return {
                    status: CustomCommandStatus.Failure,
                    message: chatText("Only players can open the shop."),
                };
            }

            system.run(() =>
                openShopEntry(src, itemQuery).catch((e) => {
                    console.warn(`[Shop] UI error: ${String(e)}\n${e?.stack ?? ""}`);
                }),
            );

            return { status: CustomCommandStatus.Success };
        },
    );

    try {
        world.beforeEvents.chatSend.subscribe((ev) => {
            if (!(ev.sender instanceof Player)) return;

            const msgText = String(ev.message ?? "").trim();

            if (msgText === "/shop" || msgText.startsWith("/shop ")) {
                ev.cancel = true;
                const arg = msgText.length > 5 ? msgText.slice(6) : "";

                system.run(() =>
                    openShopEntry(ev.sender, arg).catch((e) => {
                        console.warn(`[Shop] UI error: ${String(e)}\n${e?.stack ?? ""}`);
                    }),
                );
            }
        });
    } catch {}
}
