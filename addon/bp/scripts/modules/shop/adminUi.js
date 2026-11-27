import { parseFloatToCents } from "../economy/formatting.js";
import { stackToTemplate, templateHasCustomData, templateKey, isPotionItem, normalizeTemplate } from "../items/templates.js";
import { shortItemName, normalizeItemId, isShulkerBoxId } from "../items/identifiers.js";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { shopConfirmTitle } from "./trading.js";
import { saveShop, loadShop, stageShop, defaultCatalog } from "./storage.js";
import {
    shopMessage,
    getShopCategoryIconOptions,
    getShopCategoryIconByPresetIndex,
    findCategoryIndex,
    getShopCategoryIconPresetIndex,
    getCategoryIcon,
    shopItemAdminTitle,
    formatItemLineAdmin,
    getShopItemIcon,
    manualTemplateForItem,
    findNormalItemGlobal,
    findTemplateGlobal,
    shopItemTitle,
} from "./catalog.js";
import { parseEnchantmentsText, enchantmentsToText } from "../items/enchantments.js";
import { getInventoryContainer } from "../inventory/items.js";
import { getStackIcon } from "../ui/itemIcons.js";

function parseShopPrice(text, allowNegative = false) {
    const s = String(text ?? "").trim();
    if (!s) return { ok: true, cents: 0 };

    const num = Number(s.replace(",", "."));
    if (!Number.isFinite(num)) return { ok: false, error: "Invalid number." };

    return parseFloatToCents(num, allowNegative);
}

function describeShopStack(stack) {
    if (!stack) return "§8Empty";

    const template = stackToTemplate(stack);
    const name = template?.nameTag ? `${template.nameTag} §8(${shortItemName(template.typeId)})` : shortItemName(stack.typeId);

    const bits = [];

    if (Array.isArray(template?.enchantments) && template.enchantments.length > 0) {
        bits.push(`§d${template.enchantments.length} ench`);
    }

    if (Array.isArray(template?.lore) && template.lore.length > 0) {
        bits.push(`§b${template.lore.length} lore`);
    }

    const extra = bits.length ? ` §8| ${bits.join(" §8| ")}` : "";

    return `§f${name} §8x${stack.amount}${extra}`;
}

export async function openAdminMenu(player) {
    const form = new ActionFormData()
        .title("§6§lShop Editor")
        .body("§8Manage categories and items.\n§8Changes save per-world.")
        .button("§2§lAdd Category", "textures/ui/color_plus")
        .button("§b§lManage Items", "textures/ui/editIcon")
        .button("§c§lRestore Default Shop", "textures/ui/refresh_light")
        .button("§4§lClear Shop (Empty)", "textures/ui/trash")
        .button("§8§lBack", "textures/ui/arrow_left");

    const res = await form.show(player);
    if (res.canceled) return;

    if (res.selection === 0) return openAddCategory(player);
    if (res.selection === 1) return openManageItems(player);
    if (res.selection === 2) return openResetShopConfirm(player);
    if (res.selection === 3) return openClearShopConfirm(player);

    return true;
}

async function openClearShopConfirm(player) {
    const draft = loadShop();
    const form = new ActionFormData()
        .title(shopConfirmTitle("§4§lClear Shop?"))
        .body("§cThis will remove ALL categories and items.\n§8The shop will become empty.\n\n§8This cannot be undone.")
        .button("§c§lCancel", "textures/ui/cancel")
        .button("§4§lClear Shop", "textures/ui/trash");

    const res = await form.show(player);
    if (res.canceled || res.selection === 0) return openAdminMenu(player);

    draft.categories = [];
    const ok = saveShop(draft);

    if (!ok) {
        shopMessage(player, "§cFailed to clear shop (save error).");

        return openAdminMenu(player);
    }

    shopMessage(player, "§aShop cleared (now empty).");

    return openAdminMenu(player);
}

async function openResetShopConfirm(player) {
    const draft = loadShop();
    const form = new ActionFormData()
        .title(shopConfirmTitle("§c§lRestore Default Shop?"))
        .body("§cThis will restore the default shop.\n§8Your current categories/items will be overwritten.\n\n§8This cannot be undone.")
        .button("§c§lCancel", "textures/ui/cancel")
        .button("§c§lRestore Defaults", "textures/ui/refresh_light");

    const res = await form.show(player);
    if (res.canceled || res.selection === 0) return openAdminMenu(player);

    draft.categories = defaultCatalog().categories;
    const ok = saveShop(draft);

    if (!ok) {
        shopMessage(player, "§cFailed to reset shop (save error).");

        return openAdminMenu(player);
    }

    shopMessage(player, "§aShop reset to defaults.");

    return openAdminMenu(player);
}

async function openAddCategory(player) {
    const form = new ModalFormData()
        .title("Add Category")
        .textField("Category name", "ex: Blocks", { defaultValue: "" })
        .dropdown("Category icon", getShopCategoryIconOptions(), { defaultValueIndex: 0 });

    const res = await form.show(player);
    if (res.canceled) return openAdminMenu(player);

    const name = String(res.formValues?.[0] ?? "").trim();
    const icon = getShopCategoryIconByPresetIndex(res.formValues?.[1]);

    if (!name) {
        shopMessage(player, "§cCategory name can't be empty.");

        return openAdminMenu(player);
    }

    const shop = loadShop();

    if (findCategoryIndex(shop, name) !== -1) {
        shopMessage(player, "§cThat category already exists.");

        return openAdminMenu(player);
    }

    shop.categories.push({ name, icon, items: [] });
    stageShop(shop);

    shopMessage(player, `§aCategory created: §f${name}§a. Now add your first item.`);

    return openAddItem(player, shop.categories.length - 1);
}

async function openEditCategoryMeta(player, catIndex) {
    const shop = loadShop();
    const cat = shop.categories[catIndex];

    if (!cat) return openManageItems(player);

    const form = new ModalFormData()
        .title("Edit Category")
        .textField("Category name", "ex: Blocks", { defaultValue: cat.name })
        .dropdown("Category icon", getShopCategoryIconOptions(), {
            defaultValueIndex: getShopCategoryIconPresetIndex(cat.icon),
        });

    const res = await form.show(player);
    if (res.canceled) return openItemsInCategoryAdmin(player, catIndex);

    const name = String(res.formValues?.[0] ?? "").trim();
    const icon = getShopCategoryIconByPresetIndex(res.formValues?.[1]);

    if (!name) {
        shopMessage(player, "§cCategory name can't be empty.");

        return openItemsInCategoryAdmin(player, catIndex);
    }

    const existing = findCategoryIndex(shop, name);
    if (existing !== -1 && existing !== catIndex) {
        shopMessage(player, "§cThat category already exists.");

        return openItemsInCategoryAdmin(player, catIndex);
    }

    cat.name = name;
    cat.icon = icon;

    if (!saveShop(shop)) {
        shopMessage(player, "§cFailed to save category.");

        return openItemsInCategoryAdmin(player, catIndex);
    }

    shopMessage(player, "§aCategory updated.");

    return openItemsInCategoryAdmin(player, catIndex);
}

async function openManageItems(player) {
    const shop = loadShop();

    if (shop.categories.length === 0) {
        shopMessage(player, "§eNo categories yet. Add one first.");

        return openAdminMenu(player);
    }

    const form = new ActionFormData().title("Manage Items").body("§8Pick a category:").button("§8§lBack", "textures/ui/arrow_left");

    for (const c of shop.categories) {
        form.button(`§f§l${c.name} §r§8(${c.items.length})`, getCategoryIcon(c));
    }

    const res = await form.show(player);
    if (res.canceled || res.selection === 0) return openAdminMenu(player);

    const catIndex = res.selection - 1;
    if (catIndex < 0 || catIndex >= shop.categories.length) return openAdminMenu(player);

    return openItemsInCategoryAdmin(player, catIndex);
}

async function openItemsInCategoryAdmin(player, catIndex) {
    const shop = loadShop();
    const cat = shop.categories[catIndex];

    if (!cat) return openManageItems(player);

    const form = new ActionFormData()
        .title(`Items: ${cat.name}`)
        .body("§8Select an item to edit:")
        .button("§2§lAdd Item", "textures/ui/color_plus")
        .button("§e§lEdit Category", "textures/ui/editIcon")
        .button("§8§lBack", "textures/ui/arrow_left");

    for (const it of cat.items) {
        form.button(`${shopItemAdminTitle(it)}\n§r§8${formatItemLineAdmin(it)}`, getShopItemIcon(it));
    }

    const res = await form.show(player);
    if (res.canceled) return openManageItems(player);

    if (res.selection === 0) return openAddItem(player, catIndex);
    if (res.selection === 1) return openEditCategoryMeta(player, catIndex);
    if (res.selection === 2) return openManageItems(player);

    const itemIndex = res.selection - 3;
    if (itemIndex < 0 || itemIndex >= cat.items.length) return openItemsInCategoryAdmin(player, catIndex);

    return openItemAdminActions(player, catIndex, itemIndex);
}

async function openAddItem(player, catIndex) {
    const form = new ActionFormData()
        .title("Add Item")
        .body("§8How do you want to add this item?")
        .button("§2§lType item ID", "textures/items/book_writable")
        .button("§d§lSelect exact item from hotbar", "textures/ui/icon_recipe_equipment")
        .button("§8§lBack", "textures/ui/arrow_left");

    const res = await form.show(player);
    if (res.canceled) return openItemsInCategoryAdmin(player, catIndex);

    if (res.selection === 0) return openAddItemById(player, catIndex);
    if (res.selection === 1) return openSelectHotbarItem(player, catIndex);

    return openItemsInCategoryAdmin(player, catIndex);
}

async function openAddItemById(player, catIndex) {
    const shop = loadShop();
    const cat = shop.categories[catIndex];

    if (!cat) return openAdminMenu(player);

    const form = new ModalFormData()
        .title(`Add Item to ${cat.name}`)
        .textField("Item id", "ex: minecraft:diamond", { defaultValue: "minecraft:diamond" })
        .textField("Custom name (optional)", "ex: §bCool Sword", { defaultValue: "" })
        .textField("Enchantments (optional)", "ex: sharpness:5, unbreaking:3", { defaultValue: "" })
        .textField("Buy price (each)", "ex: 1.50", { defaultValue: "1.00" })
        .textField("Sell price (each)", "ex: 0.50", { defaultValue: "0.50" })
        .toggle("Allow Buy", { defaultValue: true })
        .toggle("Allow Sell", { defaultValue: true });

    const res = await form.show(player);
    if (res.canceled) return openItemsInCategoryAdmin(player, catIndex);

    const itemId = normalizeItemId(res.formValues?.[0]);

    if (!itemId) {
        return shopMessage(player, "§cInvalid item id.") || openItemsInCategoryAdmin(player, catIndex);
    }

    const customName = String(res.formValues?.[1] ?? "").trim();
    const requestedEnchants = parseEnchantmentsText(res.formValues?.[2]);

    const buyParsed = parseShopPrice(res.formValues?.[3], false);
    const sellParsed = parseShopPrice(res.formValues?.[4], false);

    if (!buyParsed.ok || !sellParsed.ok) {
        return shopMessage(player, "§cInvalid price (max 2 decimals).") || openItemsInCategoryAdmin(player, catIndex);
    }

    const allowBuy = !!res.formValues?.[5];
    const allowSell = !!res.formValues?.[6];

    const template = manualTemplateForItem(itemId, customName, requestedEnchants);
    const useTemplate = template && templateHasCustomData(template);

    if (!useTemplate) {
        const exists = findNormalItemGlobal(shop, itemId);

        if (exists) {
            return (
                shopMessage(player, "§cThat normal item already exists in the shop. Edit + move instead.") ||
                openItemsInCategoryAdmin(player, catIndex)
            );
        }
    } else {
        const exists = findTemplateGlobal(shop, templateKey(template));

        if (exists) {
            return shopMessage(player, "§cThat custom item already exists in the shop.") || openItemsInCategoryAdmin(player, catIndex);
        }
    }

    const itemObj = {
        id: itemId,
        buy: allowBuy ? Math.max(0, buyParsed.cents) : 0,
        sell: allowSell ? Math.max(0, sellParsed.cents) : 0,
        allowBuy,
        allowSell,
    };

    if (useTemplate) itemObj.template = template;

    cat.items.push(itemObj);

    if (!saveShop(shop)) {
        shopMessage(player, "§cFailed to save shop data (save error).");

        return openItemsInCategoryAdmin(player, catIndex);
    }

    shopMessage(player, `§aAdded §f${shopItemTitle(itemObj)}§a to §f${cat.name}§a.`);

    return openItemsInCategoryAdmin(player, catIndex);
}

async function openSelectHotbarItem(player, catIndex) {
    const inv = getInventoryContainer(player);

    if (!inv) {
        shopMessage(player, "§cNo inventory container.");

        return openItemsInCategoryAdmin(player, catIndex);
    }

    const form = new ActionFormData()
        .title("Select Hotbar Item")
        .body(
            "§8Pick the hotbar slot to copy into the shop.\n§8This stores name, lore, enchants, durability, tags, and custom data.\n§cFilled shulker boxes are not supported.",
        );

    for (let i = 0; i < 9; i++) {
        const s = inv.getItem(i);
        form.button(`§f§lSlot ${i + 1}\n§r${describeShopStack(s)}`, getStackIcon(s));
    }

    form.button("§8§lBack", "textures/ui/arrow_left");

    const res = await form.show(player);
    if (res.canceled) return openAddItem(player, catIndex);
    if (res.selection === 9) return openAddItem(player, catIndex);

    const picked = inv.getItem(res.selection);

    if (!picked) {
        shopMessage(player, "§cThat hotbar slot is empty.");

        return openSelectHotbarItem(player, catIndex);
    }

    return openAddExactItemDetails(player, catIndex, picked);
}

async function openAddExactItemDetails(player, catIndex, sourceStack) {
    const shop = loadShop();
    const cat = shop.categories[catIndex];

    if (!cat) return openAdminMenu(player);

    if (isShulkerBoxId(sourceStack?.typeId)) {
        shopMessage(player, "§cExact shulker boxes are not supported because Bedrock hides their contents from scripts.");

        return openItemsInCategoryAdmin(player, catIndex);
    }

    if (isPotionItem(sourceStack?.typeId)) return shopMessage(player, "§cPotion effects cannot be preserved in a shop template.");

    const template = stackToTemplate(sourceStack);

    if (!template) {
        shopMessage(player, "§cCould not copy that item.");

        return openItemsInCategoryAdmin(player, catIndex);
    }

    const itemName = template.nameTag || shortItemName(template.typeId);

    const form = new ModalFormData()
        .title("Add Exact Item")
        .textField("Buy price (each)", "ex: 10.50", { defaultValue: "1.00" })
        .textField("Sell price (each)", "ex: 5.25", { defaultValue: "0.50" })
        .toggle("Allow Buy", { defaultValue: true })
        .toggle("Allow Sell", { defaultValue: true });

    const res = await form.show(player);
    if (res.canceled) return openItemsInCategoryAdmin(player, catIndex);

    const buyParsed = parseShopPrice(res.formValues?.[0], false);
    const sellParsed = parseShopPrice(res.formValues?.[1], false);

    if (!buyParsed.ok || !sellParsed.ok) {
        shopMessage(player, "§cInvalid price (max 2 decimals).");

        return openItemsInCategoryAdmin(player, catIndex);
    }

    const allowBuy = !!res.formValues?.[2];
    const allowSell = !!res.formValues?.[3];

    const key = templateKey(template);
    const exists = findTemplateGlobal(shop, key);

    if (exists) {
        shopMessage(player, "§cThat exact custom item is already in the shop.");

        return openItemsInCategoryAdmin(player, catIndex);
    }

    cat.items.push({
        id: template.typeId,
        template,
        buy: allowBuy ? Math.max(0, buyParsed.cents) : 0,
        sell: allowSell ? Math.max(0, sellParsed.cents) : 0,
        allowBuy,
        allowSell,
    });

    if (!saveShop(shop)) {
        shopMessage(player, "§cFailed to save custom item (save error). This item may have too much saved data.");

        return openItemsInCategoryAdmin(player, catIndex);
    }

    shopMessage(player, `§aAdded exact item: §f${itemName}§a.`);

    return openItemsInCategoryAdmin(player, catIndex);
}

async function openItemAdminActions(player, catIndex, itemIndex) {
    const shop = loadShop();
    const cat = shop.categories[catIndex];
    const it = cat?.items?.[itemIndex];

    if (!cat || !it) return openItemsInCategoryAdmin(player, catIndex);

    const form = new ActionFormData()
        .title(`Edit: ${shopItemTitle(it)}`)
        .body(`§8${cat.name}\n§8${formatItemLineAdmin(it)}\n${it.template ? "§dCustom/exact item" : ""}`)
        .button("§e§lEdit / Move", "textures/ui/editIcon")
        .button("§c§lRemove Item", "textures/ui/trash")
        .button("§8§lBack", "textures/ui/arrow_left");

    const res = await form.show(player);
    if (res.canceled) return openItemsInCategoryAdmin(player, catIndex);

    if (res.selection === 0) return openItemEditModal(player, catIndex, itemIndex);
    if (res.selection === 1) return openRemoveItemConfirm(player, catIndex, itemIndex);

    return openItemsInCategoryAdmin(player, catIndex);
}

async function openItemEditModal(player, catIndex, itemIndex) {
    const shop = loadShop();
    const cat = shop.categories[catIndex];
    const it = cat?.items?.[itemIndex];

    if (!cat || !it) return openItemsInCategoryAdmin(player, catIndex);

    const catNames = shop.categories.map((c) => c.name);
    const oldTemplate = normalizeTemplate(it.template);
    const isExact = !!oldTemplate;

    const customNameDefault = oldTemplate?.nameTag ?? "";
    const enchantsDefault = enchantmentsToText(oldTemplate?.enchantments ?? []);

    const form = new ModalFormData()
        .title("Edit Item")
        .textField(isExact ? "Item id (locked for custom/exact items)" : "Item id", "minecraft:diamond", { defaultValue: it.id })
        .textField("Custom name (optional)", "ex: §bCool Sword", { defaultValue: customNameDefault })
        .textField("Enchantments (optional)", "ex: sharpness:5, unbreaking:3", { defaultValue: enchantsDefault })
        .textField("Buy price (each)", "ex: 1.50", { defaultValue: String(it.buy / 100) })
        .textField("Sell price (each)", "ex: 0.50", { defaultValue: String(it.sell / 100) })
        .toggle("Allow Buy", { defaultValue: !!it.allowBuy })
        .toggle("Allow Sell", { defaultValue: !!it.allowSell })
        .dropdown("Category", catNames, { defaultValueIndex: Math.max(0, catIndex) });

    const res = await form.show(player);
    if (res.canceled) return openItemAdminActions(player, catIndex, itemIndex);

    const newItemId = isExact ? oldTemplate?.typeId : normalizeItemId(res.formValues?.[0]);

    if (!newItemId) {
        return shopMessage(player, "§cInvalid item id.") || openItemAdminActions(player, catIndex, itemIndex);
    }

    const customName = String(res.formValues?.[1] ?? "").trim();
    const requestedEnchants = parseEnchantmentsText(res.formValues?.[2]);

    const buyParsed = parseShopPrice(res.formValues?.[3], false);
    const sellParsed = parseShopPrice(res.formValues?.[4], false);

    if (!buyParsed.ok || !sellParsed.ok) {
        return shopMessage(player, "§cInvalid price (max 2 decimals).") || openItemAdminActions(player, catIndex, itemIndex);
    }

    const allowBuy = !!res.formValues?.[5];
    const allowSell = !!res.formValues?.[6];
    const newCatIndex = Number(res.formValues?.[7]);

    const nextTemplate = manualTemplateForItem(newItemId, customName, requestedEnchants, oldTemplate);
    const useTemplate = nextTemplate && templateHasCustomData(nextTemplate);

    if (!useTemplate) {
        const existing = findNormalItemGlobal(shop, newItemId);

        if (existing && !(existing.ci === catIndex && existing.ii === itemIndex)) {
            shopMessage(player, "§cAnother normal item with that id already exists in the shop.");

            return openItemAdminActions(player, catIndex, itemIndex);
        }
    } else {
        const existing = findTemplateGlobal(shop, templateKey(nextTemplate), { ci: catIndex, ii: itemIndex });

        if (existing) {
            shopMessage(player, "§cAnother custom item with the same data already exists in the shop.");

            return openItemAdminActions(player, catIndex, itemIndex);
        }
    }

    const updated = {
        id: newItemId,
        buy: allowBuy ? Math.max(0, buyParsed.cents) : 0,
        sell: allowSell ? Math.max(0, sellParsed.cents) : 0,
        allowBuy,
        allowSell,
    };

    if (useTemplate) updated.template = nextTemplate;

    cat.items.splice(itemIndex, 1);

    const targetCat = shop.categories[newCatIndex] ?? shop.categories[catIndex];
    targetCat.items.push(updated);

    if (!saveShop(shop)) {
        shopMessage(player, "§cFailed to save shop data (save error).");

        return openAdminMenu(player);
    }

    shopMessage(player, "§aItem updated.");

    return openManageItems(player);
}

async function openRemoveItemConfirm(player, catIndex, itemIndex) {
    const shop = loadShop();
    const cat = shop.categories[catIndex];
    const it = cat?.items?.[itemIndex];

    if (!cat || !it) {
        return openItemsInCategoryAdmin(player, catIndex);
    }

    const form = new ActionFormData()
        .use8CrafterLayout("long")
        .title("§c§lRemove Item?")
        .body(`§cRemove §f${shopItemTitle(it)}§c from §f${cat.name}§c?\n\n` + "§8This cannot be undone.")
        .button("§c§lCancel", "textures/ui/cancel")
        .button("§c§lRemove Item", "textures/ui/trash");

    const res = await form.show(player);

    if (res.canceled || res.selection === 0) {
        return openItemAdminActions(player, catIndex, itemIndex);
    }

    cat.items.splice(itemIndex, 1);

    if (!saveShop(shop)) {
        shopMessage(player, "§cFailed to save shop data (save error).");

        return openAdminMenu(player);
    }

    shopMessage(player, "§aItem removed.");

    return openManageItems(player);
}
