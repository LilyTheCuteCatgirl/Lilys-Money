import { CommandPermissionLevel, CustomCommandParamType, Player, CustomCommandStatus, system, world } from "@minecraft/server";
import { getCommandSource } from "../modules/commandSource.js";
import { openAhEntry } from "../modules/auction/ui.js";

export function registerAhCommand(customCommandRegistry) {
    try {
        customCommandRegistry.registerEnum(`lilymoney:ah_action`, ["sell"]);
    } catch {}

    customCommandRegistry.registerCommand(
        {
            name: `lilymoney:ah`,
            description: "Open Lily's auction house",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
            optionalParameters: [
                { name: `lilymoney:ah_action`, type: CustomCommandParamType.Enum },
                { name: "price", type: CustomCommandParamType.Float },
            ],
        },
        (origin, action, price) => {
            const src = getCommandSource(origin);

            if (!(src instanceof Player)) {
                return {
                    status: CustomCommandStatus.Failure,
                    message: "Only players can use the auction house.",
                };
            }

            const args = [];

            if (action !== undefined && action !== null) {
                args.push(String(action));
            }

            if (price !== undefined && price !== null) {
                args.push(String(price));
            }

            system.run(() =>
                openAhEntry(src, args.join(" ")).catch((e) => {
                    console.warn(`[AH] UI error: ${String(e)}\n${e?.stack ?? ""}`);
                }),
            );

            return { status: CustomCommandStatus.Success };
        },
    );

    // Chat shortcuts accept a search term or a listing price.
    try {
        world.beforeEvents.chatSend.subscribe((ev) => {
            if (!(ev.sender instanceof Player)) return;

            const msgText = String(ev.message ?? "").trim();

            if (msgText === "/ah" || msgText.startsWith("/ah ")) {
                ev.cancel = true;

                const arg = msgText.length > 3 ? msgText.slice(4).trim() : "";

                system.run(() =>
                    openAhEntry(ev.sender, arg).catch((e) => {
                        console.warn(`[AH] UI error: ${String(e)}\n${e?.stack ?? ""}`);
                    }),
                );
            }
        });
    } catch {}
}
