export class ItemStack {
    constructor(type, amount = 1) {
        this.typeId = typeof type === "string" ? type : type.id;
        this.amount = amount;
        this.maxAmount = this.typeId.endsWith("_sword") ? 1 : 64;
        this.nameTag = "";
        this.lockMode = "none";
        this.keepOnDeath = false;
        this.damage = 0;
        this.enchants = [];
        this.lore = [];
        this.destroy = [];
        this.place = [];
        this.properties = {};
    }
    get isStackable() {
        return this.maxAmount > 1 && !this.nameTag && !Object.keys(this.properties).length;
    }
    isStackableWith(other) {
        return this.isStackable && other.isStackable && this.typeId === other.typeId;
    }
    clone() {
        const copy = new ItemStack(this.typeId, this.amount);
        Object.assign(copy, structuredClone({ ...this }));
        return copy;
    }
    getLore() {
        return [...this.lore];
    }
    setLore(value) {
        this.lore = [...value];
    }
    getCanDestroy() {
        return this.destroy;
    }
    setCanDestroy(value) {
        this.destroy = [...value];
    }
    getCanPlaceOn() {
        return this.place;
    }
    setCanPlaceOn(value) {
        this.place = [...value];
    }
    getDynamicPropertyIds() {
        return Object.keys(this.properties);
    }
    getDynamicProperty(key) {
        return this.properties[key];
    }
    setDynamicProperty(key, value) {
        this.properties[key] = value;
    }
    getComponent(id) {
        if (id === "minecraft:durability") return (this.durability ??= { damage: this.damage });
        if (id === "minecraft:enchantable") return { getEnchantments: () => this.enchants, addEnchantment: (e) => this.enchants.push(e) };
    }
}
