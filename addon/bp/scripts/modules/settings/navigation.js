import { ActionFormData } from "@minecraft/server-ui";
import { isAdmin } from "../commandSource.js";
import { editorFor, showEditor } from "./editors.js";
import { ROOT, pages } from "./pages.js";

const titles = {
    Notifications: "Notification Settings",
    Sounds: "Sound Settings",
    "Continue to Advanced Settings": "Advanced Performance",
};

export async function openSettings(player) {
    const personal = "Personal Settings";
    const path = [isAdmin(player) ? ROOT : personal];
    while (path.length) {
        if (path[0] === ROOT && !isAdmin(player)) {
            if (path[1] === personal) path.shift();
            else path.splice(0, path.length, personal);
        }
        const current = path.at(-1);
        const admin = path.includes("Server Settings");
        const page = pages[current];
        const links = (page?.links ?? []).filter(([label]) => label !== "Server Settings" || isAdmin(player));
        const root = path.length === 1;
        links.push(root ? ["Close", "textures/ui/cancel"] : ["Back", "textures/ui/arrow_left"]);
        const color = path.includes("Advanced Performance") ? "§c" : admin ? "§6" : "§d";
        const editor = editorFor(current, player);
        if (editor) {
            await showEditor(player, color + "§l" + current, admin, editor);
            path.pop();
            continue;
        }
        const form = new ActionFormData()
            .use8CrafterLayout(links.length > 5 ? "long" : "grid")
            .title(color + "§l" + (titles[current] ?? current))
            .body(page?.body ?? "Controls for this category are unavailable.");
        for (const [label, icon] of links) form.button(label, icon);
        const response = await form.show(player);
        const choice = links[response.selection]?.[0];
        if (response.canceled || choice === "Back") path.pop();
        else if (!choice || choice === "Close") return;
        else path.push(choice);
    }
}
