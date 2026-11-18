import { CommandPermissionLevel, Player, CustomCommandStatus, system, world } from "@minecraft/server";
import { getCommandSource } from "../modules/commandSource.js";
import { openJobRoot } from "../modules/jobs/ui.js";

export function registerJobCommand(customCommandRegistry) {
    customCommandRegistry.registerCommand(
        {
            name: `lilymoney:job`,
            description: "Open job UI",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const src = getCommandSource(origin);
            if (!(src instanceof Player)) {
                return { status: CustomCommandStatus.Failure, message: "Only players can use /job." };
            }
            system.run(() => openJobRoot(src).catch((e) => console.warn(`[Job] UI error: ${e?.stack ?? e}`)));
            return { status: CustomCommandStatus.Success };
        },
    );

    try {
        world.beforeEvents.chatSend.subscribe((ev) => {
            const m = String(ev.message ?? "").trim();
            if (m === "/job") {
                ev.cancel = true;
                system.run(() => openJobRoot(ev.sender).catch(() => {}));
            }
        });
    } catch {}
}
