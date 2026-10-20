// multi-host script: get a new account off tutorial island.
//   bun sdk/multi-host.ts --once --script=sdk/multi-scripts/skip-tutorial.ts --range=swarm01-swarm50

import type { MultiScriptContext } from '../multi-host';

// Tutorial island sits west of x=3200 around z=3100; Lumbridge, where skipTutorial
// lands, is inside this box.
const onMainland = (x: number, z: number) => x > 3100 && x < 3300 && z > 3150 && z < 3300;

export default async function ({ bot, sdk, name }: MultiScriptContext): Promise<string> {
    for (let attempt = 1; attempt <= 3; attempt++) {
        const p = sdk.getState()?.player;
        if (p && onMainland(p.worldX, p.worldZ)) break;
        const r = await bot.skipTutorial();
        console.log(`${name}: skipTutorial attempt ${attempt}: ${r.success} ${r.message}`);
        await sdk.waitForTicks(3);
    }
    const p = sdk.getState()!.player!;
    if (!onMainland(p.worldX, p.worldZ)) throw new Error(`still not on the mainland at ${p.worldX},${p.worldZ}`);
    const inv = sdk.getInventory().map(i => `${i.name}${i.count > 1 ? ` x${i.count}` : ''}`).join(', ');
    return `on the mainland at ${p.worldX},${p.worldZ}; inventory: ${inv}`;
}
