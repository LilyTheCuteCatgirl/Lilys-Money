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
        export const ItemTypes = {get:id=>({id})}, BlockTypes = {}, EnchantmentTypes = {get:id=>({id})};
        export {ItemStack} from "./itemStack.mjs";
        export class Player {}
    `,
    );
    fs.copyFileSync(new URL("./fixtures/itemStack.mjs", import.meta.url), path.join(dir, "node_modules/@minecraft/server/itemStack.mjs"));
    mockPackage(
        "server-ui",
        `class Form {
        title(){return this} body(){return this} button(){return this} textField(){return this}
        show(player){return player.nextForm()}
    }
    export class ActionFormData extends Form {} export class ModalFormData extends Form {}`,
    );
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
    world.afterEvents = {
        playerBreakBlock: event(),
        playerPlaceBlock: event(),
        entityDie: event(),
        entityRemove: event(),
        playerLeave: event(),
        playerSpawn: event(),
    };
    system.beforeEvents = { startup: event() };
    system.run = (callback) => scheduled.push(callback);
    const intervals = new Map();
    let timerId = 0;
    system.runInterval = (callback, ticks) => {
        intervals.set(++timerId, { callback, ticks });
        return timerId;
    };
    system.clearRun = (id) => intervals.delete(id);
    system.currentTick = 0;
    world.getDynamicProperty = (key) => properties.get(key);
    world.getDynamicPropertyIds = () => [...properties.keys()];
    world.setDynamicProperty = (key, value) => (value === undefined ? properties.delete(key) : properties.set(key, value));
    system.runTimeout = (callback) => scheduled.push(callback);
    return { intervals, load, properties, scheduled, world, system };
}
