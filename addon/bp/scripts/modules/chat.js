export function chatText(text) {
    return "<§dLily's money§r> §r" + text;
}

export function sendChat(player, text) {
    player.sendMessage(chatText(text));
}
