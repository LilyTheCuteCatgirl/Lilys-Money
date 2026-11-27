import { system, world } from "@minecraft/server";
import { serverOptions } from "./server.js";

// Read world properties after early execution. Each timer keeps the interval it registered with.
export function onWorldReady(start) {
    if (world.afterEvents.worldLoad) world.afterEvents.worldLoad.subscribe(start);
    else start();
}
export function configuredInterval(key, callback) {
    let id;
    onWorldReady(() => {
        const ticks = serverOptions()[key];
        id = system.runInterval(() => callback(ticks), ticks);
    });

    return () => system.clearRun(id);
}
