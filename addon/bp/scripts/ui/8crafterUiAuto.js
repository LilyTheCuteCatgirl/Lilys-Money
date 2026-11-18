import { ActionFormData, ModalFormData } from "@minecraft/server-ui";

const MAGIC = "§a§n§d§e§x§d§b§_";
const DEFAULT_BUTTON_ICON = "textures/ui/page";

const ACTION = Object.freeze({
    normal: "§a§n§d§e§x§d§b§_§g§e§n§e§r§a§l§-§r",
    grid: "§a§n§d§e§x§d§b§_§g§r§i§d§_§m§e§n§u§r",
    long: "§a§n§d§e§x§d§b§_§m§e§d§i§u§m§_§l§o§n§g§_§f§o§r§m§r",
    fullscreen: "§a§n§d§e§x§d§b§_§f§u§l§l§s§c§r§e§e§n§_§l§o§n§g§_§f§o§r§m§r",
});

const MODAL = Object.freeze({
    normal: "§a§n§d§e§x§d§b§_§g§e§n§e§r§a§l§_§c§u§s§t§o§m§r",
    long: "§a§n§d§e§x§d§b§_§m§e§d§i§u§m§_§l§o§n§g§_§f§o§r§m§r",
    fullscreen: "§a§n§d§e§x§d§b§_§f§u§l§l§s§c§r§e§e§n§_§l§o§n§g§_§f§o§r§m§r",
});

const BUTTON = Object.freeze({
    titleBar: "§a§n§d§e§x§d§b§_§t§i§t§l§e§_§b§a§r§r",
    main: "§a§n§d§e§x§d§b§_§m§o§r",
    startSelected: "§a§n§d§e§x§d§b§_§s§t§a§r§t§_§s§e§l§e§c§t§e§d§r",
});

const ACTION_LAYOUTS = new Set(["auto", "normal", "grid", "long", "fullscreen"]);

const MODAL_LAYOUTS = new Set(["auto", "normal", "long", "fullscreen"]);

function alreadyStyled(text) {
    return String(text ?? "").includes(MAGIC);
}

function visibleButtonLabel(text) {
    return String(text ?? "")
        .replace(/§./g, "")
        .split("\n", 1)[0]
        .trim()
        .toLowerCase();
}

function hasButtonPosition(text) {
    const value = String(text ?? "");

    return value.includes(BUTTON.titleBar) || value.includes(BUTTON.main);
}

function getButtonPosition(text) {
    const label = visibleButtonLabel(text);

    if (label === "back" || label === "close") {
        return BUTTON.titleBar;
    }

    return BUTTON.main;
}

function getDefaultButtonIcon(text) {
    const label = visibleButtonLabel(text);

    if (label === "back") {
        return "textures/ui/arrow_left";
    }

    if (label === "close") {
        return "textures/ui/cancel";
    }

    return DEFAULT_BUTTON_ICON;
}

function patchActionForm() {
    const proto = ActionFormData?.prototype;

    if (!proto || proto.__lilyMoneyUiPatched) {
        return;
    }

    const oldTitle = proto.title;
    const oldButton = proto.button;
    const oldShow = proto.show;

    Object.defineProperty(proto, "__lilyMoneyUiPatched", {
        value: true,
    });

    Object.defineProperty(proto, "use8CrafterLayout", {
        value: function use8CrafterLayout(layout = "auto") {
            const value = String(layout ?? "auto")
                .trim()
                .toLowerCase();

            this.__lilyMoneyLayout = ACTION_LAYOUTS.has(value) ? value : "auto";

            return this;
        },

        configurable: true,
        enumerable: false,
        writable: true,
    });

    if (typeof oldTitle === "function") {
        proto.title = function title(text) {
            this.__lilyMoneyRawTitle = String(text ?? "");

            return oldTitle.call(this, this.__lilyMoneyRawTitle);
        };
    }

    if (typeof oldButton === "function") {
        proto.button = function button(text, iconPath) {
            let finalText = String(text ?? "");

            if (!hasButtonPosition(finalText)) {
                finalText = getButtonPosition(finalText) + finalText;
            }

            if (shouldStartSelected(this.__lilyMoneyRawTitle, text) && !finalText.includes(BUTTON.startSelected)) {
                finalText = BUTTON.startSelected + finalText;
            }

            if (finalText.includes(BUTTON.main)) {
                this.__lilyMoneyMainButtonCount = (this.__lilyMoneyMainButtonCount ?? 0) + 1;
            }

            const finalIconPath = typeof iconPath === "string" && iconPath.length > 0 ? iconPath : getDefaultButtonIcon(text);

            return oldButton.call(this, finalText, finalIconPath);
        };
    }

    if (typeof oldShow === "function" && typeof oldTitle === "function") {
        proto.show = function show(player) {
            const raw = this.__lilyMoneyRawTitle;

            if (typeof raw === "string" && raw.length && !alreadyStyled(raw)) {
                const requested = this.__lilyMoneyLayout ?? "auto";

                const count = this.__lilyMoneyMainButtonCount ?? 0;

                const layout = requested === "auto" ? (count >= 2 && count <= 12 ? "grid" : "long") : requested;

                oldTitle.call(this, ACTION[layout] + raw);
            }

            return oldShow.call(this, player);
        };
    }
}

function patchModalForm() {
    const proto = ModalFormData?.prototype;

    if (!proto || proto.__lilyMoneyUiPatched) {
        return;
    }

    const oldTitle = proto.title;
    const oldShow = proto.show;

    Object.defineProperty(proto, "__lilyMoneyUiPatched", {
        value: true,
    });

    Object.defineProperty(proto, "use8CrafterLayout", {
        value: function use8CrafterLayout(layout = "auto") {
            const value = String(layout ?? "auto")
                .trim()
                .toLowerCase();

            this.__lilyMoneyLayout = MODAL_LAYOUTS.has(value) ? value : "auto";

            return this;
        },

        configurable: true,
        enumerable: false,
        writable: true,
    });

    if (typeof oldTitle === "function") {
        proto.title = function title(text) {
            this.__lilyMoneyRawTitle = String(text ?? "");

            return oldTitle.call(this, this.__lilyMoneyRawTitle);
        };
    }

    if (typeof oldShow === "function" && typeof oldTitle === "function") {
        proto.show = function show(player) {
            const raw = this.__lilyMoneyRawTitle;

            if (typeof raw === "string" && raw.length && !alreadyStyled(raw)) {
                const requested = this.__lilyMoneyLayout ?? "auto";

                const layout = requested === "auto" ? "long" : requested;

                oldTitle.call(this, MODAL[layout] + raw);
            }

            return oldShow.call(this, player);
        };
    }
}

function visibleTitle(text) {
    return String(text ?? "")
        .replace(/§./g, "")
        .trim()
        .toLowerCase();
}

function isConfirmationForm(title) {
    const text = visibleTitle(title);

    return text.includes("confirm ") || text.endsWith("?");
}

function shouldStartSelected(title, buttonText) {
    if (!isConfirmationForm(title)) {
        return false;
    }

    const label = visibleButtonLabel(buttonText);

    return label !== "back" && label !== "cancel" && label !== "close";
}

patchActionForm();
patchModalForm();
