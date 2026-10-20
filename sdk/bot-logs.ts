// Per-bot log files for processes that run many bots (sdk/multi-host.ts,
// server/webclient/src/lite/multi-runner.ts).
//
// Library code logs through the global console and rarely says which bot it is
// talking about, so the bot is carried in an AsyncLocalStorage instead: code run
// inside runAsBot(name, ...) - including its timers, promises and WebSocket
// callbacks - logs to <dir>/<prefix><name>.log. Everything else, plus every bot
// warning and error (prefixed with the bot name), goes to the process's stdout.

import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';

const botContext = new AsyncLocalStorage<string>();
let installed: { dir: string; prefix: string } | null = null;

export function currentBot(): string | undefined {
    return botContext.getStore();
}

export function runAsBot<T>(name: string, fn: () => T): T {
    return botContext.run(name, fn);
}

export function botLogPath(name: string): string {
    if (!installed) throw new Error('installBotLogging() has not been called');
    return join(installed.dir, `${installed.prefix}${name}.log`);
}

function stamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Route console output by bot. Call once, before any bot starts. */
export function installBotLogging(opts: { dir: string; prefix: string }): void {
    if (installed) return;
    mkdirSync(opts.dir, { recursive: true });
    installed = { dir: opts.dir, prefix: opts.prefix };

    const original = {
        log: console.log.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
        debug: console.debug.bind(console),
    };
    for (const level of Object.keys(original) as (keyof typeof original)[]) {
        console[level] = (...args: unknown[]) => {
            const bot = botContext.getStore();
            if (!bot) {
                original[level](`${stamp()} ${format(...args)}`);
                return;
            }
            const line = `${stamp()} ${format(...args)}`;
            try {
                appendFileSync(botLogPath(bot), line + '\n');
            } catch {
                // a full disk or locked file must not take the bot down
            }
            if (level === 'warn' || level === 'error') original[level](`${stamp()} [${bot}] ${format(...args)}`);
        };
    }

    // Bun does not carry AsyncLocalStorage into WebSocket event handlers, so a
    // socket remembers the context it was created in and runs its handlers there.
    const Base = globalThis.WebSocket;
    const handlers = ['onopen', 'onmessage', 'onclose', 'onerror'] as const;
    class ContextWebSocket extends Base {
        private readonly inContext = AsyncLocalStorage.snapshot();
        private readonly wrapped = new WeakMap<object, EventListener>();

        override addEventListener(type: string, listener: unknown, options?: unknown): void {
            if (typeof listener !== 'function') return super.addEventListener(type, listener as EventListener, options as AddEventListenerOptions);
            let fn = this.wrapped.get(listener);
            if (!fn) {
                fn = (event: Event) => this.inContext(() => (listener as EventListener).call(this, event));
                this.wrapped.set(listener, fn);
            }
            super.addEventListener(type, fn, options as AddEventListenerOptions);
        }

        override removeEventListener(type: string, listener: unknown, options?: unknown): void {
            const fn = typeof listener === 'function' ? this.wrapped.get(listener) ?? listener : listener;
            super.removeEventListener(type, fn as EventListener, options as EventListenerOptions);
        }

        constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            const inContext = this.inContext;
            for (const key of handlers) {
                const desc = Object.getOwnPropertyDescriptor(Base.prototype, key)!;
                Object.defineProperty(this, key, {
                    configurable: true,
                    get: () => desc.get!.call(this),
                    set: (fn: unknown) => desc.set!.call(this, typeof fn === 'function'
                        ? (...args: unknown[]) => inContext(() => fn.apply(this, args))
                        : fn),
                });
            }
        }
    }
    globalThis.WebSocket = ContextWebSocket as typeof WebSocket;
}
