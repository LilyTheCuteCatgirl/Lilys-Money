// BP/scripts/commands/moneyhelp.js
import { CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus, Player, system } from "@minecraft/server";

import { ActionFormData } from "@minecraft/server-ui";

import { getCommandSource } from "../modules/commandSource.js";

/* =========================================================
   8crafter UI style
========================================================= */
const UI_FULLSCREEN = "§a§n§d§e§x§d§b§_§f§u§l§l§s§c§r§e§e§n§_§l§o§n§g§_§f§o§r§m§r";

function uiTitle(text) {
    return `${UI_FULLSCREEN}${text}`;
}

/* =========================================================
   Easy-edit text pages
========================================================= */

const MAIN_MENU_BODY = "§d§lLily's Money Help Menu§r\n\n" + "§fWelcome to the help menu!\n" + "§8Pick a section below.";

const QUICK_START_BODY =
    "§a§lQuick Start§r\n\n" +
    "§fNew to Lily's Money? Start here!\n\n" +
    "§e§l1. Check your money§r\n" +
    "§8- §fUse §a/balance§f to see how much money you have.\n\n" +
    "§e§l2. Pick a job§r\n" +
    "§8- §fUse §a/job§f to choose a job.\n" +
    "§8- §fJobs can pay you for breaking blocks, placing blocks, or killing mobs.\n\n" +
    "§e§l3. Use the shop§r\n" +
    "§8- §fUse §a/shop§f to buy and sell server shop items.\n" +
    "§8- §fAdmins can also edit the shop from the shop UI.\n\n" +
    "§e§l4. Use the Auction House§r\n" +
    "§8- §fUse §a/ah§f to browse player auctions.\n" +
    "§8- §fUse §a/ah sell§f to sell the item in your hand.\n" +
    "§8- §fUse §a/ah sell 500§f to quickly list your held stack for $500.\n\n" +
    "§e§l5. Customize your display§r\n" +
    "§8- §fUse §e/moneysettings§f to edit your personal money display settings.\n\n" +
    "§8Need more details? Open the Commands section.";

const CREDITS_BODY =
    "§d§lLily's Money v3.4.1§r\n\n" +
    "§fMade by: §dLilyTheCatgirl§r\n" +
    "§fMinecraft name: §dLilyTheCat9862§r\n" +
    "§8You can friend me to join my maps if you want!\n\n" +
    "§e§l     Lily Links§r\n" +
    "§bDiscord: §9https://discord.gg/mVJmmAuQeX\n" +
    "§dLily's Money mod download: §9https://www.curseforge.com/minecraft-bedrock/scripts/lilys-money\n" +
    "§aLily's Money mod download: §9https://mcpedl.com/lilys-money/\n" +
    "§dCurseForge profile: §9https://www.curseforge.com/members/lilythecatgirl/projects\n" +
    "§aMCPEDL profile: §9https://mcpedl.com/user/lilythecatgirl\n\n" +
    "§e§l     UI Credits§r\n" +
    "§fCustom UI powered by §b8crafter's UI system§f.\n" +
    "§fSpecial thank you to §b8crafter§f for allowing me to use his UI system.\n\n" +
    "§e§l     8crafter Links§r\n" +
    "§cYouTube: §9https://www.youtube.com/@8crafter\n" +
    "§6ModBay: §9https://modbay.org/user/8Crafter/\n" +
    "§bWebsite: §9https://www.8crafter.com/\n" +
    "§bWiki: §9https://wiki.8crafter.com/main/\n" +
    "§fGitHub: §9https://github.com/8Crafter\n" +
    "§9Discord: §9https://discord.gg/jrCTeHGuhx\n\n" +
    "§8Thank you for using Lily's Money!";

const COMMANDS_MENU_BODY =
    "§b§lCommands§r\n\n" +
    "§fClick a command to learn how it works.\n\n" +
    "§aGreen commands §8are for players.\n" +
    "§eYellow commands §8change depending on whether you are a player or an admin.\n" +
    "§cRed commands §8are for admins.";

/**
 * type:
 * "player" = green button, normal player command
 * "mixed"  = yellow button, players can use it but admins get extra UI/options
 * "admin"  = red button, admin command
 *
 * body is normal text with \n and § formatting.
 */

const COMMAND_PAGES = [
    {
        name: "/balance",
        aliases: "/bal",
        type: "player",
        icon: "textures/items/emerald",
        buttonText: "Shows your money",
        body:
            "§a§l/balance§r\n\n" +
            "§fShows your current money in chat.\n" +
            "§fYou can also check another player's money by putting their name after the command.\n\n" +
            "§e§lExamples§r\n" +
            "§8- §f/balance\n" +
            "§8- §f/bal\n" +
            "§8- §f/balance <player>\n" +
            "§8- §f/bal <player>\n\n" +
            "§8Use this when you want to quickly check your money or another player's money.",
    },
    {
        name: "/balancetop",
        aliases: "/baltop",
        type: "player",
        icon: "textures/items/diamond",
        buttonText: "Shows richest players",
        body:
            "§a§l/balancetop§r\n\n" +
            "§fShows the money leaderboard for the richest players on the server.\n" +
            "§fThe leaderboard has pages, so you can open a specific page too.\n\n" +
            "§e§lExamples§r\n" +
            "§8- §f/balancetop\n" +
            "§8- §f/baltop\n" +
            "§8- §f/balancetop <page>\n" +
            "§8- §f/baltop <page>\n\n" +
            "§8Use this to see who has the most money on the SMP.",
    },
    {
        name: "/pay",
        aliases: "",
        type: "player",
        icon: "textures/items/gold_ingot",
        buttonText: "Pay another player",
        body:
            "§a§l/pay <player> <amount>§r\n\n" +
            "§fSends money to another player.\n\n" +
            "§e§lExamples§r\n" +
            "§8- §f/pay Lily 50\n" +
            "§8- §f/pay Steve 12.75\n\n" +
            "§e§lRules§r\n" +
            "§8- §fYou cannot pay money you do not have.\n" +
            "§8- §fYou cannot pay yourself.\n" +
            "§8- §fThe amount can use cents, like §e12.75§f.",
    },
    {
        name: "/moneysettings",
        aliases: "",
        type: "mixed",
        icon: "textures/ui/settings_glyph_color_2x",
        buttonText: "Open money settings",
        body:
            "§e§l/moneysettings§r\n\n" +
            "§fOpens the money settings UI.\n\n" +
            "§e§lPlayer settings§r\n" +
            "§8- §fActionbar money display\n" +
            "§8- §fMoney sounds\n" +
            "§8- §fCompact numbers\n\n" +
            "§c§lAdmin settings§r\n" +
            "§8- §fSidebar display\n" +
            "§8- §fBelow-name display\n" +
            "§8- §fDefault player settings\n" +
            "§8- §fStarting money\n\n" +
            "§8Players can edit their own personal display settings.\n" +
            "§8Admins can also edit server-wide money settings.",
    },
    {
        name: "/job",
        aliases: "",
        type: "mixed",
        icon: "textures/items/iron_pickaxe",
        buttonText: "Choose a job",
        body:
            "§e§l/job§r\n\n" +
            "§fOpens the jobs UI.\n" +
            "§fPlayers can view jobs, see how each job makes money, join a job, or leave their current job.\n\n" +
            "§e§lJobs can reward money for:§r\n" +
            "§8- §fBreaking blocks\n" +
            "§8- §fPlacing blocks\n" +
            "§8- §fKilling mobs\n\n" +
            "§e§lFor players§r\n" +
            "§8- §fClick a job to view its rewards.\n" +
            "§8- §fClick §aJoin Job§f to choose that job.\n" +
            "§8- §fUse §cLeave Job§f if you do not want a job anymore.\n\n" +
            "§c§lAdmin info§r\n" +
            "§8- §fAdmins can click §6Edit Jobs§f inside /job.\n" +
            "§8- §fYou can add jobs, edit jobs, delete jobs, or restore default jobs.\n" +
            "§8- §fReward IDs should use Minecraft IDs.\n\n" +
            "§e§lID examples§r\n" +
            "§8- §fBlock: §eminecraft:stone\n" +
            "§8- §fBlock: §eminecraft:wheat\n" +
            "§8- §fEntity: §eminecraft:zombie\n" +
            "§8- §fEntity: §eminecraft:cow\n\n" +
            "§8Use block IDs for break/place rewards and entity IDs for kill rewards.",
    },
    {
        name: "/shop",
        aliases: "",
        type: "mixed",
        icon: "textures/blocks/chest_front",
        buttonText: "Open the shop",
        body:
            "§e§l/shop§r\n\n" +
            "§fOpens the server shop UI.\n\n" +
            "§e§lPlayers can:§r\n" +
            "§8- §fBrowse categories\n" +
            "§8- §fBuy items\n" +
            "§8- §fSell items\n" +
            "§8- §fSearch shop items\n\n" +
            "§c§lAdmin info§r\n" +
            "§8- §fAdmins can edit the shop from inside the shop UI.\n" +
            "§8- §fYou can add categories, add items, move items, edit prices, and clear/restore the shop.\n\n" +
            "§e§lItem IDs vs display names§r\n" +
            "§8- §fItem IDs look like §eminecraft:diamond§f or §eminecraft:stone§f.\n" +
            "§8- §fDisplay names are what players see in the UI.\n" +
            "§8- §fSearching can use normal names, but admin setup should use item IDs when typing items manually.\n\n" +
            "§e§lExact items§r\n" +
            "§8- §fExact shop items can store custom names, lore, enchantments, durability, and custom data.\n" +
            "§8- §fThis is useful for selling special custom items.\n\n" +
            "§c§lShulker warning§r\n" +
            "§8- §fShulker box contents are not safely stored by the shop system.\n" +
            "§8- §fDo not use filled shulker boxes as exact shop items.",
    },
    {
        name: "/ah",
        aliases: "",
        type: "player",
        icon: "textures/items/clock_item",
        buttonText: "Open Auction House",
        body:
            "§a§l/ah§r\n\n" +
            "§fOpens the Auction House.\n" +
            "§fPlayers can list items, search items, buy auctions, and manage their own listed items.\n\n" +
            "§e§lExamples§r\n" +
            "§8- §f/ah\n" +
            "§8- §f/ah diamond\n" +
            "§8- §f/ah sell\n" +
            "§8- §f/ah sell 500\n\n" +
            "§e§lHow browsing works§r\n" +
            "§8- §f/ah shows the newest active auctions.\n" +
            "§8- §fThe first button is §dMy Items§f.\n" +
            "§8- §fOnly 20 auctions show per page.\n" +
            "§8- §fSearches are sorted cheapest first.\n\n" +
            "§e§lSelling§r\n" +
            "§8- §f/ah sell opens the sell UI.\n" +
            "§8- §fIf you are holding an item, it sells the held stack.\n" +
            "§8- §fIf your hand is empty, it lets you pick an item from your inventory.\n" +
            "§8- §f/ah sell 500 quickly lists the held stack for $500 after confirmation.\n\n" +
            "§e§lDefault Auction House rules§r\n" +
            "§8- §fPrices are total price for the whole stack.\n" +
            "§8- §fYou cannot buy your own auction.\n" +
            "§8- §fThere are no taxes.\n" +
            "§8- §fSellers are paid instantly, even if offline.\n" +
            "§8- §fPlayers can cancel their own active auctions anytime.\n" +
            "§8- §fPlayers can have up to 20 active auctions.\n" +
            "§8- §fActive auctions last 30 active-world days.\n" +
            "§8- §fExpired auctions can be claimed for 100 active-world days.\n" +
            "§8- §fPlayers can have up to 20 expired claimable items.\n" +
            "§8- §fIf too many expired items pile up, the oldest expired item can be deleted.\n\n" +
            "§c§lShulker warning§r\n" +
            "§8- §fShulker boxes are blocked because their contents cannot be safely stored.",
    },
    {
        name: "/buy",
        aliases: "",
        type: "admin",
        icon: "textures/ui/color_plus",
        buttonText: "Admin buy command",
        body:
            "§c§l/buy§r\n\n" +
            "§fAdmin command for buying or giving items through the money system.\n\n" +
            "§e§lExamples§r\n" +
            "§8- §f/buy minecraft:stone 64\n" +
            "§8- §f/buy minecraft:diamond 1\n\n" +
            "§e§lServer owner usage§r\n" +
            "§8- §fThis command can be useful with command blocks or NPCs.\n" +
            "§8- §fYou can make custom shops, reward stations, or special item vendors.\n" +
            "§8- §fExample: an NPC button can run a buy command to sell a specific item.\n\n" +
            "§e§lTips§r\n" +
            "§8- §fUse Minecraft item IDs like §eminecraft:stone§f.\n" +
            "§8- §fUse amounts like §e1§f, §e16§f, or §e64§f.\n" +
            "§8- §fFor normal player shopping, /shop is recommended.\n\n" +
            "§8This is currently treated as an admin command.",
    },
    {
        name: "/sell",
        aliases: "",
        type: "admin",
        icon: "textures/items/emerald",
        buttonText: "Admin sell command",
        body:
            "§c§l/sell§r\n\n" +
            "§fAdmin command for selling items through the money system.\n\n" +
            "§e§lExamples§r\n" +
            "§8- §f/sell minecraft:stone 64\n" +
            "§8- §f/sell minecraft:diamond 1\n\n" +
            "§e§lServer owner usage§r\n" +
            "§8- §fThis command can be useful with command blocks or NPCs.\n" +
            "§8- §fYou can make custom sell stations, recycling machines, or mob-drop sellers.\n" +
            "§8- §fExample: an NPC button can run a sell command for a specific item.\n\n" +
            "§e§lTips§r\n" +
            "§8- §fUse Minecraft item IDs like §eminecraft:stone§f.\n" +
            "§8- §fUse amounts like §e1§f, §e16§f, or §e64§f.\n" +
            "§8- §fFor normal player selling, /shop is recommended.\n\n" +
            "§8This is currently treated as an admin command.",
    },
    {
        name: "/setmoney",
        aliases: "",
        type: "admin",
        icon: "textures/ui/editIcon",
        buttonText: "Set player money",
        body:
            "§c§l/setmoney <player> <amount>§r\n\n" +
            "§fSets a player's money to an exact amount.\n\n" +
            "§e§lExamples§r\n" +
            "§8- §f/setmoney Lily 1000\n" +
            "§8- §f/setmoney Steve -50\n" +
            "§8- §f/setmoney Alex 12.75\n\n" +
            "§8This can set negative money.",
    },
    {
        name: "/addmoney",
        aliases: "",
        type: "admin",
        icon: "textures/ui/color_plus",
        buttonText: "Add money",
        body:
            "§c§l/addmoney <player> <amount>§r\n\n" +
            "§fAdds money to a player.\n\n" +
            "§e§lExamples§r\n" +
            "§8- §f/addmoney Lily 500\n" +
            "§8- §f/addmoney Steve 12.50\n\n" +
            "§8Use this for rewards, refunds, events, or admin corrections.",
    },
    {
        name: "/removemoney",
        aliases: "",
        type: "admin",
        icon: "textures/ui/trash",
        buttonText: "Remove money",
        body:
            "§c§l/removemoney <player> <amount>§r\n\n" +
            "§fRemoves money from a player.\n\n" +
            "§e§lExamples§r\n" +
            "§8- §f/removemoney Lily 100\n" +
            "§8- §f/removemoney Steve 2.75\n\n" +
            "§8This can put a player into negative money.",
    },
];

/* =========================================================
   Command type helpers
========================================================= */
function getCommandType(command) {
    const type = String(command?.type ?? "").toLowerCase();

    if (type === "admin") return "admin";
    if (type === "mixed") return "mixed";
    return "player";
}

function getCommandColor(command) {
    const type = getCommandType(command);

    if (type === "admin") return "§c";
    if (type === "mixed") return "§e";
    return "§a";
}

/* =========================================================
   Command registration
========================================================= */
export function registerMoneyHelpCommand(customCommandRegistry) {
    try {
        customCommandRegistry.registerEnum(`lilymoney:moneyhelp_section`, ["quickstart", "commands", "credits"]);
    } catch {}

    customCommandRegistry.registerCommand(
        {
            name: `lilymoney:moneyhelp`,
            description: "Open Lily's Money help UI",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
            optionalParameters: [
                {
                    name: `lilymoney:moneyhelp_section`,
                    type: CustomCommandParamType.Enum,
                },
            ],
        },
        (origin, section) => {
            const player = getCommandSource(origin);

            if (!(player instanceof Player)) {
                return {
                    status: CustomCommandStatus.Failure,
                    message: "Only players can use /moneyhelp.",
                };
            }

            const picked = String(section ?? "").toLowerCase();

            system.run(() => {
                const run =
                    picked === "quickstart"
                        ? openQuickStartPage(player)
                        : picked === "commands"
                          ? openCommandsMenu(player)
                          : picked === "credits"
                            ? openCreditsPage(player)
                            : openMoneyHelpMain(player);

                run.catch((e) => {
                    console.warn(`[MoneyHelp] UI error: ${String(e)}\n${e?.stack ?? ""}`);
                });
            });

            return { status: CustomCommandStatus.Success };
        },
    );
}

/* =========================================================
   UI
========================================================= */
async function openMoneyHelpMain(player) {
    const form = new ActionFormData()
        .title(uiTitle("§d§lLily's Money Help"))
        .body(MAIN_MENU_BODY)
        .button("§a§lQuick Start", "textures/items/book_writable")
        .button("§b§lCommands", "textures/items/book_writable")
        .button("§d§lCredits", "textures/items/diamond")
        .button("§c§lClose", "textures/ui/cancel");

    const res = await form.show(player);
    if (res.canceled) return;

    if (res.selection === 0) return openQuickStartPage(player);
    if (res.selection === 1) return openCommandsMenu(player);
    if (res.selection === 2) return openCreditsPage(player);
}

async function openQuickStartPage(player) {
    const form = new ActionFormData()
        .title(uiTitle("§a§lQuick Start"))
        .body(QUICK_START_BODY)
        .button("§b§lCommands", "textures/items/book_writable")
        .button("§8§lBack", "textures/ui/arrow_left");

    const res = await form.show(player);
    if (res.canceled) return openMoneyHelpMain(player);

    if (res.selection === 0) return openCommandsMenu(player);
    return openMoneyHelpMain(player);
}

async function openCreditsPage(player) {
    const form = new ActionFormData().title(uiTitle("§d§lCredits")).body(CREDITS_BODY).button("§8§lBack", "textures/ui/arrow_left");

    const res = await form.show(player);
    if (res.canceled) return openMoneyHelpMain(player);

    return openMoneyHelpMain(player);
}

async function openCommandsMenu(player) {
    const form = new ActionFormData().title(uiTitle("§b§lCommands")).body(COMMANDS_MENU_BODY);

    for (const command of COMMAND_PAGES) {
        const color = getCommandColor(command);
        const label = command.aliases
            ? `${color}§l${command.name}\n§r§8${command.aliases} | ${command.buttonText}`
            : `${color}§l${command.name}\n§r§8${command.buttonText}`;

        form.button(label, command.icon);
    }

    form.button("§8§lBack", "textures/ui/arrow_left");

    const res = await form.show(player);
    if (res.canceled) return openMoneyHelpMain(player);

    if (res.selection === COMMAND_PAGES.length) return openMoneyHelpMain(player);

    const command = COMMAND_PAGES[res.selection];
    if (!command) return openCommandsMenu(player);

    return openCommandPage(player, command);
}

async function openCommandPage(player, command) {
    const color = getCommandColor(command);

    const form = new ActionFormData()
        .title(uiTitle(`${color}§l${command.name}`))
        .body(command.body)
        .button("§8§lBack", "textures/ui/arrow_left");

    const res = await form.show(player);
    if (res.canceled) return openCommandsMenu(player);

    return openCommandsMenu(player);
}
