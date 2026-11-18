# Lily's Money

Lily's Money is a Minecraft Bedrock add-on that adds an economy system to worlds, Realms, and servers. Players can earn money, trade with each other, use the shop, and buy or sell items in an Auction House.

## Download

Get the latest public release here:

- [CurseForge](https://www.curseforge.com/minecraft-bedrock/scripts/lilys-money)
- [MCPEDL](https://mcpedl.com/lilys-money/)

This GitHub repository contains the source code and development tools.

## Installation

1. Download the latest `.mcaddon` from CurseForge or MCPEDL.
2. Open the file with Minecraft Bedrock to import the packs.
3. Activate the behavior pack in your world and make sure the resource pack is enabled too.
4. Join the world and run `/moneyhelp` to see the available commands.

The current release does not require the Beta APIs experimental toggle. If you are updating an existing world, make a backup first.

### Getting admin access

Run this command as a player with permission to use Minecraft commands:

```mcfunction
/tag @s add admin
```

You can then open `/moneysettings` to configure the economy. Admins can also edit the shop and jobs in-game.

## Commands

| Command | What it does |
| --- | --- |
| `/balance` or `/bal` | Show your balance |
| `/pay` | Send money to another player |
| `/shop` | Open the shop |
| `/ah` | Open the Auction House |
| `/job` | Open the jobs menu |
| `/moneysettings` | Change money display and other settings |
| `/moneyhelp` | Show the full in-game help |

Admin commands include `/setmoney`, `/addmoney`, `/removemoney`, and `/topmoney`.

## Development

The project uses JavaScript and Node.js 20 or newer. Open the repository in VS Code, then install dependencies with:

```powershell
npm ci
```

| Command | What it does |
| --- | --- |
| `npm run watch` | Sync both packs to Minecraft Bedrock while you edit |
| `npm run watch:preview` | Sync to Minecraft Preview |
| `npm run lint` | Check JavaScript and formatting |
| `npm run lint:fix` | Fix supported lint and formatting issues |
| `npm run validate` | Check the manifests and local imports |
| `npm run test` | Run automated project tests |
| `npm run build` | Create a `.mcaddon` inside `builds/` |

The ready-to-use packs are in `addon/bp/` and `addon/rp/`. Watch mode replaces the `LilysMoney_BP_DEV` and `LilysMoney_RP_DEV` development packs, so edit the files in this repository, not the deployed copies.

See [CONTRIBUTING.md](CONTRIBUTING.md) if you want to help with development.

## Support and credits

- Creator: [LilyTheCuteCatgirl](https://github.com/LilyTheCuteCatgirl)
- UI style: adapted from 8Crafter's work with permission
- [Contributors and credits](CONTRIBUTORS.md)
- [Discord support](https://discord.gg/mVJmmAuQeX)

## License

The repository includes the [GNU GPLv3 license](LICENSE). Some third-party UI material has separate attribution and permission terms. See `addon/rp/UI_CREDITS.txt` and `addon/rp/8crafter-LICENSE.txt` before reusing that material.
