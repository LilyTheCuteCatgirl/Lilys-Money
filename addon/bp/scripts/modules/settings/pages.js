export const ROOT = "Lily's Money - Settings";

export const pages = {
    "Lily's Money - Settings": {
        body: "Personal settings affect you. Server settings affect everyone in this world.",
        links: [
            ["Personal Settings", "textures/ui/settings_glyph_color_2x"],
            ["Server Settings", "textures/items/gold_ingot"],
        ],
    },
    "Personal Settings": {
        body: "Customize your HUD, sounds, numbers and trade confirmations.",
        links: [
            ["HUD & Appearance", "textures/ui/settings_glyph_color_2x"],
            ["Notifications", "textures/items/emerald"],
            ["Sounds", "textures/items/diamond"],
            ["Number Formatting", "textures/items/gold_ingot"],
            ["Shop Purchases", "textures/blocks/chest_front"],
            ["Auction House", "textures/items/emerald"],
        ],
    },
    "HUD & Appearance": {
        body: "Choose how your balance appears.",
        links: [
            ["Basic HUD Settings", "textures/items/compass_item"],
            ["HUD Theme & Effects", "textures/items/brush"],
        ],
    },
    Notifications: {
        body: "Choose which transaction cards appear.",
        links: [
            ["General Notifications", "textures/items/villagebell"],
            ["Notification Categories", "textures/items/hopper"],
            ["Notification Details", "textures/items/paper"],
        ],
    },
    Sounds: {
        body: "Choose your money sounds.",
        links: [
            ["General Sound Settings", "textures/items/record_cat"],
            ["Sound Events", "textures/items/record_chirp"],
        ],
    },
    "Server Settings": {
        body: "Choose a world setting to edit.",
        links: [
            ["General Economy", "textures/items/emerald"],
            ["Default Player Settings", "textures/ui/settings_glyph_color_2x"],
            ["Shop Settings", "textures/blocks/chest_front"],
            ["Auction House Settings", "textures/items/diamond"],
            ["Jobs Settings", "textures/items/iron_pickaxe"],
            ["Logging & History", "textures/items/book_writable"],
            ["Advanced Performance", "textures/items/comparator"],
        ],
    },
    "Auction House Settings": {
        body: "Configure the auction house.",
        links: [
            ["General Auction Settings", "textures/items/emerald"],
            ["Limits & Durations", "textures/items/clock_item"],
        ],
    },
    "Advanced Performance": {
        body: "§c§lWARNING - ADVANCED SETTINGS\n\n§fThese options control Lily's Money's internal update intervals and startup delays.\n\n§cChanging values without understanding their effects can cause increased lag, delayed updates, or unexpected behavior.\n\n§eLeave these settings at their defaults unless you know what you are doing.",
        links: [["Continue to Advanced Settings", "textures/ui/confirm"]],
    },
    "Continue to Advanced Settings": {
        body: "Select a group of timing options.",
        links: [
            ["HUD & Economy Timing", "textures/items/repeater"],
            ["Jobs & Auction Timing", "textures/items/clock_item"],
            ["Startup & Initialization Timing", "textures/items/lever"],
        ],
    },
};
