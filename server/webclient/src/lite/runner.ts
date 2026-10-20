// Headless bot runner: a LiteClient session wired to the SDK gateway.
//
// This is BotOverlay minus the browser - same StateCollector, ActionExecutor
// and BotActionQueue, but the gateway socket is a plain Bun WebSocket instead
// of the in-page GatewayConnection (which needs window.location). Controlling
// SDKs (sdk/runner.ts scripts, sdk/cli.ts, MCP execute_code) pair with it
// exactly as they would with a browser tab.
//
//   bun src/lite/runner.ts <botname>          # reads bots/<botname>/bot.env
//
// Run from server/webclient so the '#/*' import map resolves.

import { fileURLToPath } from 'node:url';

import { OutdatedClientError } from './net/GameConnection.js';
import { startSession } from './session.js';
import { FAST_KBD_RUNTIME_MODE } from './fast-kbd.js';
import { deriveGatewayUrl, LiteGatewayRunner } from './gateway-runner.js';

const botName = process.argv[2];
if (!botName) {
    console.error('Usage: bun src/lite/runner.ts <botname>');
    process.exit(1);
}

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const envPath = `${repoRoot}bots/${botName}/bot.env`;
const env = Object.fromEntries(
    (await Bun.file(envPath).text())
        .split('\n')
        .filter(l => l.includes('=') && !l.startsWith('#'))
        .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);

const host = env.SERVER || 'localhost';
// No config channel from the server (see LiteClient's maxMessageLength note), so
// mirror the server's NODE_PROFANITY_FILTER by hand: PROFANITY_FILTER=false in
// bot.env or the process env disables local chat censoring.
const profanityRaw = (env.PROFANITY_FILTER ?? process.env.PROFANITY_FILTER ?? '').toLowerCase();
const session = await startSession({
    host,
    username: env.BOT_USERNAME!,
    password: env.PASSWORD!,
    profanityFilter: ['false', '0', 'off', 'no'].includes(profanityRaw) ? false : undefined,
    quiet: true
}).catch((err: unknown) => {
    // A revision mismatch won't fix itself: exit 3 so a supervisor can stop restarting us
    if (err instanceof OutdatedClientError) {
        console.error(`[lite-runner] ${err.message}`);
        process.exit(3);
    }
    throw err;
});

console.log(`[lite-runner] '${env.BOT_USERNAME}' logged into ${host}`);

// SERVER doubles as game-server origin and gateway address, which breaks for
// local hosts with an explicit web port (localhost:8888 is the engine, not the
// gateway). GATEWAY_URL (bot.env or process env) overrides the derivation.
const gatewayUrl = env.GATEWAY_URL || process.env.GATEWAY_URL || deriveGatewayUrl(host);
const runtimeMode = await Bun.file(`${repoRoot}bots/logs/fleet-runtime.mode`).text()
    .then(value => value.trim())
    .catch(() => '');
const fastKbdAttackEnabled = runtimeMode === FAST_KBD_RUNTIME_MODE;
if (fastKbdAttackEnabled) {
    console.log('[lite-runner] in-process KBD op2 enabled');
}
const runner = new LiteGatewayRunner(session, gatewayUrl, fastKbdAttackEnabled);
runner.connect();

process.on('SIGINT', () => {
    console.log('\n[lite-runner] SIGINT, shutting down');
    runner.stop();
    process.exit(0);
});

// One bot per process, so re-login is the supervisor's job (systemd, a shell
// loop, whatever launched us). Exit non-zero on anything we did not ask for, so
// it can tell "finished" from "died".
const end = await session.stopped;
console.log(`[lite-runner] Game session ended (${end.reason})`, end.error ?? '');
runner.stop();
process.exit(end.reason === 'stopped' ? 0 : 1);
