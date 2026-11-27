import { sendChat } from "../chat.js";
import { ModalFormData } from "@minecraft/server-ui";
import { isAdmin } from "../commandSource.js";

export async function editFields(player, title, admin, fields, read, save) {
    const before = read();
    const form = new ModalFormData().use8CrafterLayout("long").title(title);

    for (const [key, label, choices] of fields) {
        if (Array.isArray(choices)) form.dropdown(label, choices.map(String), { defaultValueIndex: choices.indexOf(before[key]) });
        else if (choices === "text") form.textField(label, "", { defaultValue: String(before[key]) });
        else form.toggle(label, { defaultValue: before[key] });
    }
    const result = await form.show(player);
    if (result.canceled || (admin && !isAdmin(player))) return;

    const values = result.formValues;
    const current = read();
    if (!Array.isArray(values) || values.length !== fields.length) return;

    const changes = {};

    for (const [index, [key, , choices, parse]] of fields.entries()) {
        if (current[key] !== before[key])
            return sendChat(player, "Settings changed while this page was open. Reopen it to review the new values.");

        const raw = values[index];
        let value;
        if (Array.isArray(choices)) value = Number.isInteger(raw) ? choices[raw] : undefined;
        else if (choices === "text") value = typeof raw === "string" ? parse(raw.trim()) : undefined;
        else value = typeof raw === "boolean" ? raw : undefined;
        if (value === undefined) return sendChat(player, "Invalid value. Your changes were discarded.");
        if (value !== before[key]) changes[key] = value;
    }
    if (Object.keys(changes).length) save(changes);
}
