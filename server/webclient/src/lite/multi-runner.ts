// Many headless bots in one process, each one a LiteGatewayRunner exactly as
// runner.ts would start it, so SDK scripts, sdk/cli.ts and MCP pair with them
// the same way. Sharing the process shares the asset cache, the loc index and
// the JS runtime: about 17 MB per bot instead of a ~100 MB process each.
//
//   bun src/lite/multi-runner.ts swarm01 swarm02 ...   [--tag=swarm] [--stagger-ms=1500]
//   bun src/lite/multi-runner.ts --range=swarm01-swarm50
//
// Credentials come only from <repo>/bots/<name>/bot.env, resolved from this
// file, never from the working directory or process.env. Per-bot output goes to
// $LOG_DIR/lite-<name>.log (default <repo>/bots/logs); stdout carries the
// process log plus every bot warning and error.
//
// Each bot is supervised on its own, with the rules of scripts/bot-supervisor.ps1:
//   - client out of date: that bot stops for good (the process exits 3 once all have);
//   - session handed to another client (gateway save_and_disconnect): wait while
//     the gateway shows that client live, 1 min doubling to 30 min; never take it back;
//   - anything else: re-login after 5 s, doubling to 5 min, reset after 10 min up.
// A bot that throws or dies never stops the others. Ctrl+C logs every bot out.
//
// Run from server/webclient so the '#/*' import map resolves.

import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { installBotLogging, runAsBot } from '../../../../sdk/bot-logs.js';
import { OutdatedClientError } from './net/GameConnection.js';
import { startSession, type LiteSession, type SessionEnd } from './session.js';
import { deriveGatewayUrl, LiteGatewayRunner } from './gateway-runner.js';

const CRASH_DELAY_MS = 5_000;
const CRASH_DELAY_MAX_MS = 5 * 60_000;
const UPTIME_RESET_MS = 10 * 60_000;
const TAKEOVER_SETTLE_MS = 10_000;
const TAKEOVER_WAIT_MS = 60_000;
const TAKEOVER_WAIT_MAX_MS = 30 * 60_000;
const SHUTDOWN_GRACE_MS = 10_000;

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

interface BotEnv {
    username: string;
    password: string;
    host: string;
    gatewayUrl: string;
    profanityFilter?: boolean;
}

function readBotEnv(name: string): BotEnv {
    const path = join(repoRoot, 'bots', name, 'bot.env');
    if (!existsSync(path)) throw new Error(`no ${path}`);
    const env = Object.fromEntries(
        readFileSync(path, 'utf-8')
            .split('\n')
            .filter(l => l.includes('=') && !l.trim().startsWith('#'))
            .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
    );
    if (!env.BOT_USERNAME || !env.PASSWORD) throw new Error(`${path} has no BOT_USERNAME/PASSWORD`);
    const host = env.SERVER || 'localhost';
    const profanity = (env.PROFANITY_FILTER ?? '').toLowerCase();
    return {
        username: env.BOT_USERNAME,
        password: env.PASSWORD,
        host,
        gatewayUrl: env.GATEWAY_URL || deriveGatewayUrl(host),
        profanityFilter: ['false', '0', 'off', 'no'].includes(profanity) ? false : undefined,
    };
}

function parseArgs(argv: string[]): { bots: string[]; tag: string; staggerMs: number } {
    const bots: string[] = [];
    let tag = 'multi';
    let staggerMs = 1500;
    for (const arg of argv) {
        if (arg.startsWith('--range=')) {
            const m = arg.slice(8).match(/^([a-z]+)(\d+)-\1(\d+)$/i);
            if (!m) throw new Error(`bad --range ${arg} (want e.g. swarm01-swarm50)`);
            const width = m[2]!.length;
            for (let i = Number(m[2]); i <= Number(m[3]); i++) bots.push(m[1] + String(i).padStart(width, '0'));
        } else if (arg.startsWith('--tag=')) tag = arg.slice(6);
        else if (arg.startsWith('--stagger-ms=')) staggerMs = Number(arg.slice(13));
        else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
        else bots.push(arg);
    }
    return { bots: [...new Set(bots)], tag, staggerMs };
}

// ------------------------------------------------------------------ shutdown

let shuttingDown = false;
let signalShutdown: () => void;
const shutdownSignal = new Promise<void>(resolve => (signalShutdown = resolve));

/** Sleep that ends early when the process is shutting down. */
function pause(ms: number): Promise<void> {
    return Promise.race([Bun.sleep(ms), shutdownSignal]);
}

async function gatewayStatus(gatewayUrl: string, name: string): Promise<{ status: string } | null> {
    const base = gatewayUrl.replace(/^ws/, 'http').replace(/\/gateway$/, '');
    try {
        const res = await fetch(`${base}/status/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(5000) });
        return res.ok ? ((await res.json()) as { status: string }) : null;
    } catch {
        return null;
    }
}

// ------------------------------------------------------------------ one bot

type SlotState = 'waiting' | 'logging-in' | 'online' | 'retrying' | 'held-elsewhere' | 'outdated' | 'stopped';

class BotSlot {
    state: SlotState = 'waiting';
    logins = 0;
    ends: Record<string, number> = {};
    private session: LiteSession | null = null;
    private runner: LiteGatewayRunner | null = null;

    constructor(readonly name: string) {}

    stop(): void {
        this.runner?.stop();
        this.session?.stop();
    }

    get stopped(): Promise<unknown> {
        return this.session?.stopped ?? Promise.resolve();
    }

    async run(startDelayMs: number): Promise<void> {
        await pause(startDelayMs);
        let crashDelay = CRASH_DELAY_MS;
        while (!shuttingDown) {
            const started = Date.now();
            let end: SessionEnd | { reason: 'login-failed'; error: unknown };
            let env: BotEnv;
            try {
                env = readBotEnv(this.name);
            } catch (err) {
                console.error(`[multi] ${this.name}: ${err instanceof Error ? err.message : err}; not starting it`);
                this.state = 'stopped';
                return;
            }

            let loginError: unknown;
            this.state = 'logging-in';
            console.log(`[multi] starting lite session for '${this.name}'`);
            try {
                this.session = await startSession({
                    host: env.host,
                    username: env.username,
                    password: env.password,
                    profanityFilter: env.profanityFilter,
                    quiet: true,
                });
            } catch (err) {
                if (err instanceof OutdatedClientError) {
                    console.error(`[multi] ${this.name}: ${err.message} - not restarting`);
                    this.state = 'outdated';
                    return;
                }
                loginError = err;
                this.session = null;
            }

            if (this.session) {
                this.logins++;
                console.log(`[lite-runner] '${env.username}' logged into ${env.host}`);
                if (shuttingDown) {
                    this.session.stop();
                    break;
                }
                this.runner = new LiteGatewayRunner(this.session, env.gatewayUrl);
                this.runner.connect();
                this.state = 'online';
                end = await this.session.stopped;
                this.runner.stop();
                this.runner = null;
            } else {
                end = { reason: 'login-failed', error: loginError };
            }
            this.ends[end.reason] = (this.ends[end.reason] ?? 0) + 1;
            const uptime = Date.now() - started;
            console.log(`[multi] session for '${this.name}' ended (${end.reason}) after ${Math.round(uptime / 1000)}s`);
            if (shuttingDown) break;
            if (uptime >= UPTIME_RESET_MS) crashDelay = CRASH_DELAY_MS;

            if (end.reason === 'stopped') {
                // We did not ask for it, so the gateway handed the bot to another client.
                this.state = 'held-elsewhere';
                await pause(TAKEOVER_SETTLE_MS);
                const s = await gatewayStatus(env.gatewayUrl, this.name);
                if (s && s.status !== 'dead') {
                    console.warn(`[multi] ${this.name}: taken over by another client (status ${s.status}); backing off`);
                    await this.waitForOtherSessionToEnd(env.gatewayUrl);
                }
                continue;
            }

            this.state = 'retrying';
            console.warn(`[multi] ${this.name}: ${end.reason}${'error' in end && end.error ? ` (${end.error})` : ''}; restarting in ${crashDelay / 1000}s`);
            await pause(crashDelay);
            crashDelay = Math.min(crashDelay * 2, CRASH_DELAY_MAX_MS);
        }
        this.state = 'stopped';
    }

    private async waitForOtherSessionToEnd(gatewayUrl: string): Promise<void> {
        let wait = TAKEOVER_WAIT_MS;
        while (!shuttingDown) {
            const s = await gatewayStatus(gatewayUrl, this.name);
            if (s?.status === 'dead') {
                console.log(`[multi] ${this.name}: no other client is attached any more`);
                return;
            }
            console.log(`[multi] ${this.name}: ${s ? `another client holds it (status ${s.status})` : 'gateway not answering'}; checking again in ${wait / 1000}s`);
            await pause(wait);
            wait = Math.min(wait * 2, TAKEOVER_WAIT_MAX_MS);
        }
    }
}

// ------------------------------------------------------------------ main

const { bots, tag, staggerMs } = (() => {
    try {
        return parseArgs(process.argv.slice(2));
    } catch (err) {
        console.error(String(err instanceof Error ? err.message : err));
        process.exit(1);
    }
})();
if (bots.length === 0) {
    console.error('Usage: bun src/lite/multi-runner.ts <bot> [<bot> ...] | --range=swarm01-swarm50 [--tag=name] [--stagger-ms=1500]');
    process.exit(1);
}

installBotLogging({ dir: process.env.LOG_DIR || join(repoRoot, 'bots', 'logs'), prefix: 'lite-' });

// Contain anything that escapes a bot (a timer callback, a stray rejection):
// one bad bot must not end the process for all of them.
process.on('uncaughtException', err => console.error('[multi] uncaught exception:', err));
process.on('unhandledRejection', err => console.error('[multi] unhandled rejection:', err));

const slots = bots.map(name => new BotSlot(name));
console.log(`[multi] ${tag}: ${slots.length} bots, logins ${staggerMs}ms apart (pid ${process.pid})`);

const onSignal = (signal: string) => {
    if (shuttingDown) {
        console.log(`[multi] second ${signal}, exiting now`);
        process.exit(130);
    }
    shuttingDown = true;
    signalShutdown();
    console.log(`[multi] ${signal}: logging out ${slots.length} bots`);
    for (const slot of slots) {
        try {
            slot.stop();
        } catch (err) {
            console.error(`[multi] ${slot.name}: stop failed:`, err);
        }
    }
    void Promise.race([Promise.allSettled(slots.map(s => s.stopped)), Bun.sleep(SHUTDOWN_GRACE_MS)]).then(() => {
        console.log('[multi] all sessions closed');
        process.exit(0);
    });
};
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

// One summary line a minute in the process log, so a fleet that is slowly
// losing bots shows it.
setInterval(() => {
    const counts: Record<string, number> = {};
    for (const s of slots) counts[s.state] = (counts[s.state] ?? 0) + 1;
    const mem = process.memoryUsage();
    console.log(`[multi] ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')} | logins=${slots.reduce((n, s) => n + s.logins, 0)} rss=${Math.round(mem.rss / 1048576)}MB heap=${Math.round(mem.heapUsed / 1048576)}MB`);
}, 60_000);

const runs = slots.map((slot, i) =>
    runAsBot(slot.name, () => slot.run(i * staggerMs)).catch(err => {
        console.error(`[multi] ${slot.name}: supervisor crashed:`, err);
        slot.state = 'stopped';
    })
);
await Promise.all(runs);
if (shuttingDown) await new Promise(() => {}); // the signal handler exits
const outdated = slots.filter(s => s.state === 'outdated').length;
console.log(`[multi] every bot has stopped (${outdated} out of date)`);
process.exit(outdated === slots.length ? 3 : 1);
