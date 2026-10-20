// multi-host script: gather -> bank, forever, at one of six level-1 sites picked
// round-robin by the bot's number, so any slice of a fleet is spread out.
//   bun sdk/multi-host.ts --script=sdk/multi-scripts/gather.ts --range=swarm01-swarm50
//
// Tiles come from the map files (server/content/maps). Everything stays south
// of the Wilderness ditch (z 3520) and out of Lumbridge/Al Kharid. Boxes keep
// clear of the NPCs that hunt low-level players: the mugger at (3175,3361) by
// the SW mine, the giant rat at (3292,3377) by the SE mine and the Draynor jail
// guards. The young dark wizards at (3084,3236) are unavoidable for Draynor
// fishing; the flee handling covers them.
// The first bank trip also banks the starter kit, keeping only the tool. A bot
// that is hit (an aggressive NPC, or a random-event monster when the engine has
// NODE_RANDOM_EVENTS on) runs to the bank, and one that died and lost its tool
// buys another.

import type { MultiScriptContext } from '../multi-host';
import type { NearbyLoc, NearbyNpc } from '../types';

interface Site {
    name: string;
    kind: 'chop' | 'mine' | 'fish';
    tool: RegExp;
    /** Gather only targets inside this box: [x0, z0, x1, z1]. */
    box: [number, number, number, number];
    /** Where to walk to when out of range of the box. */
    stand: [number, number];
    target: RegExp;
    /** What the site yields; sold for coins when a lost tool has to be replaced. */
    product: RegExp;
    bank: [number, number];
}

const SITES: Site[] = [
    { name: 'draynor-fish', kind: 'fish', tool: /^small fishing net$/i, box: [3084, 3222, 3092, 3232], stand: [3087, 3229], target: /fishing spot/i, product: /^raw (shrimps|anchovies)$/i, bank: [3093, 3243] },
    { name: 'varrock-se-mine', kind: 'mine', tool: /^bronze pickaxe$/i, box: [3280, 3358, 3290, 3368], stand: [3285, 3363], target: /copper|tin/i, product: /^(copper|tin) ore$/i, bank: [3253, 3421] },
    { name: 'varrock-sw-mine', kind: 'mine', tool: /^bronze pickaxe$/i, box: [3178, 3370, 3186, 3380], stand: [3181, 3375], target: /tin|clay/i, product: /^(tin ore|clay)$/i, bank: [3184, 3440] },
    { name: 'varrock-w-trees', kind: 'chop', tool: /^bronze axe$/i, box: [3150, 3400, 3175, 3456], stand: [3163, 3420], target: /^tree$/i, product: /^logs$/i, bank: [3184, 3440] },
    { name: 'draynor-trees', kind: 'chop', tool: /^bronze axe$/i, box: [3096, 3246, 3115, 3262], stand: [3106, 3253], target: /^tree$/i, product: /^logs$/i, bank: [3093, 3243] },
    { name: 'edgeville-trees', kind: 'chop', tool: /^bronze axe$/i, box: [3115, 3468, 3135, 3505], stand: [3122, 3485], target: /^tree$/i, product: /^logs$/i, bank: [3094, 3491] },
];

const SITE_RANGE = 20;
/** Took damage this recently (ticks): something is attacking us, so run. */
const FLEE_DAMAGE_TICKS = 5;
const FLEE_WAIT_MS = 30_000;
// Replacement tools. The starter kit has no coins, so a bot that lost its tool
// (died, or the random-event pickaxe head flew off) sells what it
// gathered at the Lumbridge general store first.
const GENERAL_STORE: [number, number] = [3211, 3247];
const TOOL_SHOPS = {
    chop: { at: [3230, 3203] as [number, number], keeper: /^bob$/i, item: /^bronze axe$/i, price: 16 },
    mine: { at: [3230, 3203] as [number, number], keeper: /^bob$/i, item: /^bronze pickaxe$/i, price: 1 },
    fish: { at: [3013, 3225] as [number, number], keeper: /^gerrant$/i, item: /^small fishing net$/i, price: 5 },
};
const FISH_WAIT_MS = 20_000;

const inBox = (b: Site['box'], x: number, z: number) => x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3];

export function siteFor(name: string): Site {
    const n = Number(name.match(/(\d+)$/)?.[1] ?? 1);
    return SITES[(n - 1) % SITES.length]!;
}

export default async function ({ bot, sdk, name, stats }: MultiScriptContext): Promise<never> {
    const site = siteFor(name);
    console.log(`${name}: site ${site.name}`);
    const bump = (k: string, n = 1) => (stats[k] = (stats[k] ?? 0) + n);
    let misses = 0;
    let lastMiss = '';

    while (true) {
        const state = sdk.getState();
        if (!state?.player) {
            await sdk.waitForTicks(1);
            continue;
        }
        const { worldX: x, worldZ: z } = state.player;

        const hit = state.player.combat?.lastDamageTick ?? -1;
        if (hit >= 0 && state.tick - hit <= FLEE_DAMAGE_TICKS) {
            await flee();
            continue;
        }
        if (!sdk.findInventoryItem(site.tool)) {
            // The first state after a login can arrive before the inventory does,
            // so only a tool that stays missing counts as lost.
            const back = await sdk.waitForCondition(s => s.inventory.some(i => site.tool.test(i.name)), 5_000)
                .then(() => true, () => false);
            if (!back) await replaceTool();
            continue;
        }
        if (state.inventory.length >= 28) {
            await bankTrip();
            continue;
        }

        const [sx, sz] = site.stand;
        if (Math.max(Math.abs(x - sx), Math.abs(z - sz)) > SITE_RANGE) {
            const walk = await bot.walkTo(sx, sz, 4);
            if (!walk.success) {
                bump('walk_failures');
                console.warn(`${name}: walk to site failed: ${walk.message}`);
                await sdk.waitForTicks(5);
            }
            continue;
        }

        // Still swinging from the last click: an op sent now is refused (the player
        // is mid-action), so let the current one finish.
        if (state.player.animId !== -1) {
            await sdk.waitForTicks(2);
            continue;
        }

        const ok = site.kind === 'fish' ? await fish() : site.kind === 'mine' ? await mine() : await chop();
        if (ok) {
            misses = 0;
        } else if (++misses % 10 === 0) {
            console.warn(`${name}: ${misses} gather attempts in a row got nothing (last: ${lastMiss})`);
            await bot.walkTo(sx, sz, 2);
        }
    }

    async function chop(): Promise<boolean> {
        const tree = pickLoc();
        if (!tree) return waitForRespawn();
        const before = sdk.getInventory().length;
        const r = await bot.chopTree(tree);
        if (r.success) bump('gathered');
        else lastMiss = `chop ${tree.x},${tree.z}: ${r.message}`;
        return r.success || (await settle(before));
    }

    async function mine(): Promise<boolean> {
        const rock = pickLoc();
        if (!rock) return waitForRespawn();
        const before = sdk.getInventory().length;
        const r = await bot.mineRock(rock, { timeout: 20_000 });
        if (r.success) bump('gathered', r.oresMined || 1);
        else lastMiss = `mine ${rock.name} ${rock.x},${rock.z}: ${r.message}`;
        return r.success || (await settle(before));
    }

    async function fish(): Promise<boolean> {
        const spots = sdk.getState()!.nearbyNpcs.filter(
            (n: NearbyNpc) => site.target.test(n.name) && inBox(site.box, n.x, n.z) && n.optionsWithIndex.some(o => /^net$/i.test(o.text))
        );
        const spot = spots.sort((a, b) => a.distance - b.distance)[0];
        if (!spot) return waitForRespawn();
        const before = sdk.getInventory().length;
        const r = await bot.interactNpc(spot, 'net');
        if (!r.success) {
            lastMiss = `net: ${r.message}`;
            return false;
        }
        // Netting repeats on its own until the spot moves or the inventory fills.
        try {
            await sdk.waitForCondition(s => s.inventory.length > before, FISH_WAIT_MS);
        } catch {
            lastMiss = `net: no catch in ${FISH_WAIT_MS / 1000}s`;
            return false;
        }
        bump('gathered', sdk.getInventory().length - before);
        return true;
    }

    function pickLoc(): NearbyLoc | undefined {
        return sdk.getState()!.nearbyLocs
            .filter(l => site.target.test(l.name) && inBox(site.box, l.x, l.z) && l.reachable !== false)
            .sort((a, b) => a.distance - b.distance)[0];
    }

    /**
     * After a refused op: the refusal usually means the last click is still
     * running (the mining/chopping loop drops its animation between swings), so
     * wait for it to land an item or for the player to stand idle for 3 ticks.
     */
    async function settle(before: number): Promise<boolean> {
        let idle = 0;
        try {
            await sdk.waitForCondition(s => {
                idle = s.player?.animId === -1 ? idle + 1 : 0;
                return s.inventory.length !== before || idle >= 3;
            }, 20_000);
        } catch {
            return false;
        }
        const got = sdk.getInventory().length - before;
        if (got > 0) bump('gathered', got);
        return got > 0;
    }

    async function waitForRespawn(): Promise<false> {
        lastMiss = 'no target in the site box';
        bump('no_target_waits');
        await sdk.waitForTicks(5);
        return false;
    }

    async function flee(): Promise<void> {
        bump('flees');
        console.warn(`${name}: under attack at ${sdk.getState()!.player!.worldX},${sdk.getState()!.player!.worldZ}; running to the bank`);
        await bot.walkTo(site.bank[0], site.bank[1], 3);
        await Bun.sleep(FLEE_WAIT_MS);
    }

    async function replaceTool(): Promise<void> {
        const shop = TOOL_SHOPS[site.kind];
        bump('tool_replacements');
        console.warn(`${name}: no ${site.tool} - buying one`);
        const coins = () => sdk.findInventoryItem(/^coins$/i)?.count ?? 0;
        if (coins() < shop.price) {
            const sellable = () => sdk.getInventory().filter(i => !/^coins$/i.test(i.name));
            if (sellable().length === 0) {
                await mustWalk(site.bank, 'bank');
                must(await bot.openBank(), 'openBank');
                // Raw materials fetch little or nothing at a general store (clay: 0 gp),
                // so bring the banked starter weapons too.
                for (const item of [/^coins$/i, /^shortbow$/i, /^bronze sword$/i, /^bronze dagger$/i, /^wooden shield$/i]) {
                    if (sdk.getState()?.bank?.items?.some(b => item.test(b.name)) !== false) await bot.withdrawItem(item, -1);
                }
                await bot.withdrawItem(site.product, 20);
                await bot.closeBank();
            }
            if (coins() < shop.price) {
                await mustWalk(GENERAL_STORE, 'general store');
                must(await bot.openShop(/shop (keeper|assistant)/i), 'open general store');
                for (const item of sellable()) await bot.sellToShop(item, 'all');
                await bot.closeShop();
            }
            if (coins() < shop.price) throw new Error(`cannot afford a new tool (${coins()} of ${shop.price} gp)`);
        }
        await mustWalk(shop.at, 'tool shop');
        must(await bot.openShop(shop.keeper), 'open tool shop');
        must(await bot.buyFromShop(shop.item, 1), 'buy tool');
        await bot.closeShop();
        console.log(`${name}: bought a new tool`);
    }

    async function mustWalk(to: [number, number], what: string): Promise<void> {
        must(await bot.walkTo(to[0], to[1], 3, { timeout: 180_000 }), `walk to ${what}`);
    }

    function must(r: { success: boolean; message: string }, what: string): void {
        if (!r.success) throw new Error(`${what} failed: ${r.message}`);
    }

    async function bankTrip(): Promise<void> {
        const [bx, bz] = site.bank;
        const walk = await bot.walkTo(bx, bz, 3);
        if (!walk.success) {
            bump('walk_failures');
            console.warn(`${name}: walk to bank failed: ${walk.message}`);
            await sdk.waitForTicks(5);
            return;
        }
        const open = await bot.openBank();
        if (!open.success) {
            bump('bank_failures');
            console.warn(`${name}: openBank failed: ${open.message}`);
            await sdk.waitForTicks(5);
            return;
        }
        let deposited = 0;
        const seen = new Set<string>();
        for (const item of sdk.getInventory()) {
            if (site.tool.test(item.name) || seen.has(item.name)) continue;
            seen.add(item.name);
            const r = await bot.depositItem(item.name, -1);
            if (r.success) deposited += r.amountDeposited ?? 0;
        }
        await bot.closeBank();
        bump('bank_trips');
        bump('banked', deposited);
        console.log(`${name}: banked ${deposited} items`);
    }
}
