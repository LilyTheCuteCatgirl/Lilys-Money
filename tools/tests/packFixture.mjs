import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BP } from "../project.mjs";

// Each test imports a fresh pack with isolated Minecraft API objects.
export async function packFixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-script-test-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.cpSync(path.join(BP, "scripts"), path.join(dir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
    function mockPackage(name, source) {
        const apiDir = path.join(dir, "node_modules", "@minecraft", name);
        fs.mkdirSync(apiDir, { recursive: true });
        fs.writeFileSync(path.join(apiDir, "package.json"), '{"type":"module","main":"index.js"}');
        fs.writeFileSync(path.join(apiDir, "index.js"), source);
    }
    mockPackage(
        "server",
        `
        export const world = {}, system = {}, StructureSaveMode = {}, DisplaySlotId = {};
        export const CommandPermissionLevel = {}, CustomCommandParamType = {}, CustomCommandStatus = {};
        export const ItemTypes = {}, BlockTypes = {}, EnchantmentTypes = {};
        export class ItemStack {}
        export class Player {}
    `,
    );
    mockPackage("server-ui", "export class ActionFormData {} export class ModalFormData {}");
    const load = (name) => import(pathToFileURL(path.join(dir, name)).href);
    const { world, system } = await load("node_modules/@minecraft/server/index.js");
    const properties = new Map();
    const scheduled = [];
    function event() {
        const listeners = [];
        return {
            subscribe(fn) {
                listeners.push(fn);
            },
            emit(data) {
                for (const fn of listeners) fn(data);
            },
        };
    }
    world.beforeEvents = { playerLeave: event(), chatSend: event() };
    world.afterEvents = { entityDie: event(), entityRemove: event(), playerLeave: event(), playerSpawn: event() };
    system.beforeEvents = { startup: event() };
    system.run = (callback) => scheduled.push(callback);
    system.runInterval = () => 1;
    world.getDynamicProperty = (key) => properties.get(key);
    world.getDynamicPropertyIds = () => [...properties.keys()];
    world.setDynamicProperty = (key, value) => properties.set(key, value);
    system.runTimeout = (callback) => scheduled.push(callback);
    return { load, properties, scheduled, world, system };
}
