// Run one script for many bots in one process: one collision map and one JS
// runtime for the lot, and a separate BotSDK + BotActions per bot.
//
//   bun sdk/multi-host.ts --script=sdk/multi-scripts/gather.ts swarm01 swarm02 ...
//   bun sdk/multi-host.ts --script=... --range=swarm01-swarm50 [--tag=swarm] [--once] [--stagger-ms=500]
//
// The script module default-exports `async (ctx: MultiScriptContext) => ...`.
// Every bot needs a game client already attached (lite runner, multi-runner or
// a browser tab); the host never starts one.
//
// Credentials come only from <repo>/bots/<name>/bot.env, resolved from this
// file - never from the working directory or process.env (BOT_USERNAME,
// GATEWAY_URL, ...), so one stray variable cannot point every bot at one account.
//
// Each bot is supervised on its own:
//   - the script throws, or the client goes away: restart after 5 s, doubling
//     to 5 min, reset after 10 min of clean running;
//   - another controller takes the bot over: let it go, and wait while the
//     gateway still shows a controller, 1 min doubling to 30 min;
//   - --once: a bot whose script returns is done; otherwise it is restarted.
// Per-bot output goes to $LOG_DIR/host-<name>.log (default <repo>/bots/logs),
// and every 10 s a metrics row goes to $LOG_DIR/host-metrics-<tag>.csv.
// Ctrl+C aborts every script and disconnects every bot.

import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { BotSDK, deriveGatewayUrl } from './index';
import { BotActions } from './actions';
import { executionContext, abortable } from './execution-context';
import { initPathfinding } from './pathfinding';
import { installBotLogging, runAsBot } from './bot-logs';

export interface MultiScriptContext {
    bot: BotActions;
    sdk: BotSDK;
    /** The bot's directory name, e.g. 'swarm07'. */
    name: string;
    /** Aborted when the bot's run is cancelled (disconnect, takeover, Ctrl+C). */
    signal: AbortSignal;
    /** Counters the script may bump; summed across bots into the metrics CSV. */
    stats: Record<string, number>;
}

export type MultiScript = (ctx: MultiScriptContext) => Promise<unknown>;

const CRASH_DELAY_MS = 5_000;
const CRASH_DELAY_MAX_MS = 5 * 60_000;
const UPTIME_RESET_MS = 10 * 60_000;
const TAKEOVER_WAIT_MS = 60_000;
const TAKEOVER_WAIT_MAX_MS = 30 * 60_000;
const CONNECT_TIMEOUT_MS = 60_000;
const LIVE_CLIENT_WAIT_MS = 15_000;
/** A client that publishes nothing for this long is gone; restart the run. */
const STALE_STATE_MS = 30_000;
const METRICS_MS = 10_000;
const SHUTDOWN_GRACE_MS = 10_000;

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function readBotEnv(name: string): { username: string; password: string; gatewayUrl: string } {
    const path = join(repoRoot, 'bots', name, 'bot.env');
    if (!existsSync(path)) throw new Error(`no ${path}`);
    const env: Record<string, string> = {};
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
        const t = line.trim();
        const eq = t.indexOf('=');
        if (t && !t.startsWith('#') && eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    if (!env.BOT_USERNAME || !env.PASSWORD) throw new Error(`${path} has no BOT_USERNAME/PASSWORD`);
    // deriveGatewayUrl prefers process.env.GATEWAY_URL; only this bot's file counts here.
    const gatewayUrl = env.GATEWAY_URL || (() => {
        const saved = process.env.GATEWAY_URL;
        delete process.env.GATEWAY_URL;
        try {
            return deriveGatewayUrl(env.SERVER);
        } finally {
            if (saved !== undefined) process.env.GATEWAY_URL = saved;
        }
    })();
    return { username: env.BOT_USERNAME, password: env.PASSWORD, gatewayUrl };
}

async function controllersOf(gatewayUrl: string, name: string): Promise<number | null> {
    const base = gatewayUrl.replace(/^ws/, 'http').replace(/\/gateway$/, '');
    try {
        const res = await fetch(`${base}/status/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return null;
        const body = (await res.json()) as { controllers?: unknown[] };
        return body.controllers?.length ?? 0;
    } catch {
        return null;
    }
}

// ------------------------------------------------------------------ metrics

class Samples {
    private values: number[] = [];
    add(v: number): void {
        if (this.values.length < 100_000) this.values.push(v);
    }
    take(): { n: number; p50: number; p95: number; max: number } {
        const v = this.values.sort((a, b) => a - b);
        this.values = [];
        const at = (q: number) => (v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))]! : 0);
        return { n: v.length, p50: at(0.5), p95: at(0.95), max: v.length ? v[v.length - 1]! : 0 };
    }
}

const stateLag = new Samples();   // gateway received a state frame -> this process handled it
const actionRtt = new Samples();  // action sent -> result back (bot client + gateway, both ways)
let loopLagMax = 0;

// ------------------------------------------------------------------ shutdown

let shuttingDown = false;
let signalShutdown: () => void;
const shutdownSignal = new Promise<void>(r => (signalShutdown = r));
const pause = (ms: number) => Promise.race([Bun.sleep(ms), shutdownSignal]);

// ------------------------------------------------------------------ one bot

type SlotState = 'waiting' | 'connecting' | 'running' | 'retrying' | 'held-elsewhere' | 'done' | 'stopped';

class HostSlot {
    state: SlotState = 'waiting';
    runs = 0;
    failures = 0;
    readonly stats: Record<string, number> = {};
    xpStart: number | null = null;
    xpNow = 0;
    private sdk: BotSDK | null = null;
    private run: AbortController | null = null;

    constructor(readonly name: string, private script: MultiScript, private once: boolean) {}

    stop(): Promise<void> {
        this.run?.abort(new Error('host shutting down'));
        return this.sdk?.disconnect().catch(() => {}) ?? Promise.resolve();
    }

    async loop(startDelayMs: number): Promise<void> {
        await pause(startDelayMs);
        let crashDelay = CRASH_DELAY_MS;
        while (!shuttingDown) {
            let env: ReturnType<typeof readBotEnv>;
            try {
                env = readBotEnv(this.name);
            } catch (err) {
                console.error(`[host] ${this.name}: ${err instanceof Error ? err.message : err}; not starting it`);
                this.state = 'stopped';
                return;
            }
            const started = Date.now();
            const outcome = await this.runOnce(env);
            if (shuttingDown) break;
            if (outcome === 'done' && this.once) {
                this.state = 'done';
                return;
            }
            if (Date.now() - started >= UPTIME_RESET_MS) crashDelay = CRASH_DELAY_MS;

            if (outcome === 'taken-over') {
                this.state = 'held-elsewhere';
                let wait = TAKEOVER_WAIT_MS;
                while (!shuttingDown) {
                    const n = await controllersOf(env.gatewayUrl, this.name);
                    if (n === 0) {
                        console.log(`[host] ${this.name}: no other controller any more`);
                        break;
                    }
                    console.log(`[host] ${this.name}: ${n === null ? 'gateway not answering' : `${n} other controller(s) attached`}; checking again in ${wait / 1000}s`);
                    await pause(wait);
                    wait = Math.min(wait * 2, TAKEOVER_WAIT_MAX_MS);
                }
                continue;
            }
            if (outcome === 'done') crashDelay = CRASH_DELAY_MS;
            this.state = 'retrying';
            console.warn(`[host] ${this.name}: run ended (${outcome}); restarting in ${crashDelay / 1000}s`);
            await pause(crashDelay);
            crashDelay = Math.min(crashDelay * 2, CRASH_DELAY_MAX_MS);
        }
        this.state = 'stopped';
    }

    /** One connection and one script run. */
    private async runOnce(env: ReturnType<typeof readBotEnv>): Promise<'done' | 'failed' | 'no-client' | 'taken-over'> {
        this.state = 'connecting';
        const sdk = new BotSDK({
            botUsername: env.username,
            password: env.password,
            gatewayUrl: env.gatewayUrl,
            connectionMode: 'control',
            // Reconnects are this loop's job, so a dropped run is restarted cleanly.
            autoReconnect: false,
            autoLaunchBrowser: false,
            showChat: false,
        });
        this.sdk = sdk;
        const unsubscribers: (() => void)[] = [];
        let preempted = false;
        try {
            try {
                let timer: ReturnType<typeof setTimeout> | undefined;
                await Promise.race([
                    sdk.connect(),
                    new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('connect timed out')), CONNECT_TIMEOUT_MS))),
                ]).finally(() => clearTimeout(timer));
                const first = sdk.getState();
                await sdk.waitForCondition(s => !!s.inGame && s.tick !== first?.tick, LIVE_CLIENT_WAIT_MS);
            } catch (err) {
                console.warn(`[host] ${this.name}: no live game client (${err instanceof Error ? err.message : err})`);
                return 'no-client';
            }
            if (shuttingDown) return 'done';

            // Metrics hooks: state relay lag, and action round trips. sendAction is
            // private, so wrap it on this instance only.
            unsubscribers.push(sdk.onStateUpdate(state => {
                const at = sdk.getStateReceivedAt();
                if (at) stateLag.add(Date.now() - at);
                const xp = state.skills?.reduce((n, s) => n + s.experience, 0) ?? 0;
                if (this.xpStart === null) this.xpStart = xp;
                this.xpNow = xp;
            }));
            const raw = sdk as unknown as { sendAction(a: { type: string }): Promise<unknown> };
            const send = raw.sendAction.bind(sdk);
            raw.sendAction = async action => {
                const t = performance.now();
                try {
                    return await send(action);
                } finally {
                    if (action.type !== 'wait') actionRtt.add(performance.now() - t);
                }
            };

            const run = new AbortController();
            this.run = run;
            unsubscribers.push(sdk.onConnectionStateChange(state => {
                if (state === 'disconnected' || state === 'reconnecting') run.abort(new Error(`gateway connection ${state}`));
            }));
            // A gateway socket can stay open while the game client behind it is gone
            // (re-logging, crashed); the run would otherwise wait out action timeouts.
            const watchdog = setInterval(() => {
                if (sdk.getStateAge() > STALE_STATE_MS) run.abort(new Error(`no state for ${Math.round(sdk.getStateAge() / 1000)}s`));
            }, 5_000);
            unsubscribers.push(() => clearInterval(watchdog));

            this.state = 'running';
            this.runs++;
            console.log(`[host] ${this.name}: run ${this.runs} started`);
            const bot = new BotActions(sdk);
            try {
                const result = await executionContext.run({ signal: run.signal }, () =>
                    abortable(this.script({ bot, sdk, name: this.name, signal: run.signal, stats: this.stats }))
                );
                console.log(`[host] ${this.name}: script returned`, result === undefined ? '' : result);
                return 'done';
            } catch (err) {
                if (shuttingDown) return 'done';
                this.failures++;
                const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
                console.error(`[host] ${this.name}: script failed - ${message}`);
                if (err instanceof Error && err.stack) console.log(err.stack.split('\n').slice(1, 6).join('\n'));
                // A disconnect right after another controller connected is a takeover.
                if (!sdk.isConnected()) {
                    await Bun.sleep(1000);
                    const n = await controllersOf(env.gatewayUrl, this.name);
                    if (n !== null && n > 0) preempted = true;
                }
                return preempted ? 'taken-over' : 'failed';
            } finally {
                if (!run.signal.aborted) run.abort(new Error('run finished'));
            }
        } finally {
            for (const u of unsubscribers) u();
            this.run = null;
            await sdk.disconnect().catch(() => {});
            this.sdk = null;
        }
    }
}

// ------------------------------------------------------------------ main

function parseArgs(argv: string[]) {
    const bots: string[] = [];
    let script = '';
    let tag = 'host';
    let once = false;
    let staggerMs = 500;
    for (const arg of argv) {
        if (arg.startsWith('--script=')) script = arg.slice(9);
        else if (arg.startsWith('--tag=')) tag = arg.slice(6);
        else if (arg === '--once') once = true;
        else if (arg.startsWith('--stagger-ms=')) staggerMs = Number(arg.slice(13));
        else if (arg.startsWith('--range=')) {
            const m = arg.slice(8).match(/^([a-z]+)(\d+)-\1(\d+)$/i);
            if (!m) throw new Error(`bad --range ${arg} (want e.g. swarm01-swarm50)`);
            for (let i = Number(m[2]); i <= Number(m[3]); i++) bots.push(m[1] + String(i).padStart(m[2]!.length, '0'));
        } else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
        else bots.push(arg);
    }
    if (!script || bots.length === 0) {
        throw new Error('Usage: bun sdk/multi-host.ts --script=<module> <bot> ... | --range=swarm01-swarm50 [--tag=name] [--once] [--stagger-ms=500]');
    }
    return { bots: [...new Set(bots)], script, tag, once, staggerMs };
}

if (import.meta.main) {
    let args: ReturnType<typeof parseArgs>;
    try {
        args = parseArgs(process.argv.slice(2));
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
    const logDir = process.env.LOG_DIR || join(repoRoot, 'bots', 'logs');
    installBotLogging({ dir: logDir, prefix: 'host-' });
    process.on('uncaughtException', err => console.error('[host] uncaught exception:', err));
    process.on('unhandledRejection', err => console.error('[host] unhandled rejection:', err));

    const mod = await import(pathToFileURL(resolve(args.script)).href);
    const script: MultiScript = mod.default;
    if (typeof script !== 'function') {
        console.error(`${args.script} has no default-exported function`);
        process.exit(1);
    }

    // Once, before any socket exists: it is synchronous and slow.
    initPathfinding();

    const slots = args.bots.map(name => new HostSlot(name, script, args.once));
    console.log(`[host] ${args.tag}: ${slots.length} bots running ${args.script} (pid ${process.pid})`);

    const onSignal = (signal: string) => {
        if (shuttingDown) process.exit(130);
        shuttingDown = true;
        signalShutdown();
        console.log(`[host] ${signal}: stopping ${slots.length} bots`);
        void Promise.race([Promise.allSettled(slots.map(s => s.stop())), Bun.sleep(SHUTDOWN_GRACE_MS)]).then(() => {
            console.log('[host] all bots disconnected');
            process.exit(130);
        });
    };
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));

    // Event-loop lag: a busy host delays every bot at once.
    let expected = performance.now() + 100;
    setInterval(() => {
        const now = performance.now();
        loopLagMax = Math.max(loopLagMax, now - expected);
        expected = now + 100;
    }, 100);

    const csv = join(logDir, `host-metrics-${args.tag}.csv`);
    const statKeys = new Set<string>();
    let header = '';
    setInterval(() => {
        const count = (s: SlotState) => slots.filter(x => x.state === s).length;
        for (const s of slots) for (const k of Object.keys(s.stats)) statKeys.add(k);
        const keys = [...statKeys].sort();
        const lag = stateLag.take();
        const rtt = actionRtt.take();
        const mem = process.memoryUsage();
        const row: Record<string, string | number> = {
            time: new Date().toISOString(),
            bots: slots.length,
            running: count('running'),
            connecting: count('connecting') + count('waiting'),
            retrying: count('retrying'),
            held: count('held-elsewhere'),
            done: count('done'),
            runs: slots.reduce((n, s) => n + s.runs, 0),
            failures: slots.reduce((n, s) => n + s.failures, 0),
            state_frames: lag.n,
            lag_p50_ms: lag.p50,
            lag_p95_ms: lag.p95,
            lag_max_ms: lag.max,
            actions: rtt.n,
            rtt_p50_ms: Math.round(rtt.p50),
            rtt_p95_ms: Math.round(rtt.p95),
            rtt_max_ms: Math.round(rtt.max),
            loop_lag_max_ms: Math.round(loopLagMax),
            rss_mb: Math.round(mem.rss / 1048576),
            heap_mb: Math.round(mem.heapUsed / 1048576),
            xp_gained: slots.reduce((n, s) => n + (s.xpStart === null ? 0 : s.xpNow - s.xpStart), 0),
        };
        for (const k of keys) row[k] = slots.reduce((n, s) => n + (s.stats[k] ?? 0), 0);
        loopLagMax = 0;
        const h = Object.keys(row).join(',');
        try {
            if (h !== header) {
                // New stat columns appeared: start a fresh header line.
                if (!header) writeFileSync(csv, h + '\n');
                else appendFileSync(csv, h + '\n');
                header = h;
            }
            appendFileSync(csv, Object.values(row).join(',') + '\n');
        } catch (err) {
            console.error('[host] metrics write failed:', err);
        }
        if (Date.now() % 60_000 < METRICS_MS) {
            console.log(`[host] running=${row.running} retrying=${row.retrying} held=${row.held} done=${row.done} failures=${row.failures} lag p95=${row.lag_p95_ms}ms rtt p95=${row.rtt_p95_ms}ms rss=${row.rss_mb}MB`);
        }
    }, METRICS_MS);

    await Promise.all(slots.map((slot, i) =>
        runAsBot(slot.name, () => slot.loop(i * args.staggerMs)).catch(err => {
            console.error(`[host] ${slot.name}: supervisor crashed:`, err);
            slot.state = 'stopped';
        })
    ));
    if (shuttingDown) await new Promise(() => {});
    console.log(`[host] every bot has finished (${slots.filter(s => s.state === 'done').length} done)`);
    process.exit(slots.every(s => s.state === 'done') ? 0 : 1);
}
