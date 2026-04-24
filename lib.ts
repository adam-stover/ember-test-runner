import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import CDP from 'chrome-remote-interface';
import { launch, type LaunchedChrome } from 'chrome-launcher';

let launchedChrome: LaunchedChrome | null = null;

function killLaunchedChrome(): void {
    if (launchedChrome) {
        launchedChrome.kill();
        launchedChrome = null;
    }
}

// chrome-launcher handles SIGINT; we cover SIGTERM.
// No exit handler - Chrome persists across CLI commands by design.
// Users run `clean` to explicitly kill it.
process.once('SIGTERM', () => {
    killLaunchedChrome();
    process.exit();
});

export const DEFAULT_URL = 'http://localhost:4200';
export const DEFAULT_CHROME_PORT = 9222;
const CHECK_TIMEOUT_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_MS = 500;
const DEV_SERVER_RETRIES = 8;
const DEV_SERVER_RETRY_MS = 500;

export interface GlobalOptions {
    url: string;
    chromePort: number;
}

export function normalizeUrl(url: string): string {
    return url.replace(/\/$/, '');
}

export function parseGlobalOptions(args: string[]): { options: GlobalOptions; remaining: string[] } {
    const opts: GlobalOptions = {
        url: DEFAULT_URL,
        chromePort: DEFAULT_CHROME_PORT,
    };
    const remaining: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--url') {
            const val = args[++i];
            if (!val) {
                throw new Error('--url requires a value');
            }
            try {
                const u = new URL(val);
                if (u.protocol !== 'http:' && u.protocol !== 'https:') {
                    throw new Error('protocol must be http or https');
                }
                opts.url = normalizeUrl(val);
            } catch {
                throw new Error(`--url must be a valid http(s) URL (got: ${val})`);
            }
        } else if (arg === '--chrome-port') {
            const val = args[++i];
            const num = Number(val);
            if (!val || !Number.isInteger(num) || num < 1 || num > 65535) {
                throw new Error('--chrome-port must be an integer between 1 and 65535');
            }
            opts.chromePort = num;
        } else {
            remaining.push(arg);
        }
    }

    return { options: opts, remaining };
}

async function isChromeRunning(port: number): Promise<boolean> {
    try {
        const r = await fetch(`http://localhost:${port}/json/version`, { redirect: 'manual' });
        return r.ok;
    } catch {
        return false;
    }
}

export async function cleanup(port: number): Promise<void> {
    killLaunchedChrome();
    try {
        const info = await fetch(`http://localhost:${port}/json/version`, { redirect: 'manual' });
        const { webSocketDebuggerUrl } = await info.json() as { webSocketDebuggerUrl: string };
        const browser = await CDP({ target: webSocketDebuggerUrl, port });
        await browser.Browser.close();
        console.error('Chrome closed.');
    } catch (e) {
        console.error(`Failed to close Chrome: ${e instanceof Error ? e.message : e}`);
    }
}

async function launchChrome(port: number): Promise<void> {
    if (await isChromeRunning(port)) return;

    console.error('Launching headless Chrome...');
    try {
        launchedChrome = await launch({
            port,
            chromeFlags: ['--headless'],
        });
    } catch (e) {
        throw new Error(`Failed to launch Chrome on port ${port}: ${e instanceof Error ? e.message : e}. Is the port already in use?`);
    }
}

export function isConnectionRefused(e: unknown): boolean {
    return e instanceof TypeError && (e as any).cause?.code === 'ECONNREFUSED';
}

export async function isDevServerRunning(url: string): Promise<boolean> {
    for (let i = 0; i < DEV_SERVER_RETRIES; i++) {
        try {
            await fetch(url, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
            return true;
        } catch (e) {
            if (isConnectionRefused(e)) {
                return false;
            }
            if (i < DEV_SERVER_RETRIES - 1) {
                await sleep(DEV_SERVER_RETRY_MS);
            }
        }
    }
    return false;
}

async function getTestTab(port: number, url: string): Promise<CDP.Client> {
    const targets = await CDP.List({ port });
    const baseOrigin = new URL(url).origin;
    const tab = targets.find(t => {
        if (t.type !== 'page') return false;
        try {
            return new URL(t.url).origin === baseOrigin;
        } catch {
            return false;
        }
    });
    if (tab) return CDP({ port, target: tab });

    const created = await CDP.New({ port, url: 'about:blank' });

    return CDP({ port, target: created });
}

function makeCheckStatusScript(failFast: boolean): string {
    return `(() => {
    const banner = document.getElementById('qunit-banner');
    if (!banner) return { status: 'loading' };
    if (banner.className.includes('qunit-pass')) return { status: 'pass' };
    if (banner.className.includes('qunit-fail')) return { status: 'fail' };
    ${failFast ? `if (document.querySelector('#qunit-tests > li.fail')) return { status: 'fail' };` : ''}
    const d = document.getElementById('qunit-testresult-display');
    const progress = (d?.innerText || '').replace(/Rerun.*$/, '').trim();
    return { status: 'running', progress };
})()`;
}

const EXTRACT_RESULTS_SCRIPT = `(() => {
    const d = document.getElementById('qunit-testresult-display');
    const summary = (d?.innerText || '').replace(/Rerun.*$/, '').trim();
    const failures = [...document.querySelectorAll('#qunit-tests > li.fail')].map(li => {
        const module = li.querySelector('.module-name')?.textContent || '';
        const name = li.querySelector('.test-name')?.textContent || '';
        const assertions = [...li.querySelectorAll('.qunit-assert-list li.fail')].map(a => ({
            message: a.querySelector('.test-message')?.textContent || '',
            expected: a.querySelector('.test-expected pre')?.textContent || '',
            actual: a.querySelector('.test-actual pre')?.textContent || '',
            source: a.querySelector('.test-source pre')?.textContent || '',
        }));
        return { module, name, assertions };
    });
    return { summary, failures };
})()`;

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

export async function screenshot(globalOpts: GlobalOptions): Promise<void> {
    await launchChrome(globalOpts.chromePort);
    const client = await getTestTab(globalOpts.chromePort, globalOpts.url);
    try {
        const { Page } = client;
        const { data } = await Page.captureScreenshot({ format: 'png' });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const path = join(tmpdir(), `ember-test-${timestamp}.png`);
        await writeFile(path, Buffer.from(data, 'base64'));
        console.log(path);
    } finally {
        client.close();
    }
}

export async function evaluate(globalOpts: GlobalOptions, expression: string): Promise<void> {
    await launchChrome(globalOpts.chromePort);
    const client = await getTestTab(globalOpts.chromePort, globalOpts.url);
    try {
        const { Runtime } = client;
        await Runtime.enable();

        const { result, exceptionDetails } = await Runtime.evaluate({
            expression,
            returnByValue: true,
            awaitPromise: true,
        });

        if (exceptionDetails) {
            throw new Error(`Error: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
        }

        const output = (result.value && typeof result.value === 'object')
            ? JSON.stringify(result.value, null, 2)
            : result.value;
        console.log(output);
    } finally {
        client.close();
    }
}

async function extractTestResults(Runtime: CDP.Client['Runtime']): Promise<{ summary: string; failures: TestFailure[] }> {
    const { result } = await Runtime.evaluate({
        expression: EXTRACT_RESULTS_SCRIPT,
        returnByValue: true,
    });

    return result.value as { summary: string; failures: TestFailure[] };
}

export interface RunOptions {
    filter?: string;
    timeoutMs?: number;
    quiet?: boolean;
    failFast?: boolean;
}

export interface TestFailure {
    module: string;
    name: string;
    assertions: {
        message: string;
        expected: string;
        actual: string;
        source: string;
    }[];
}

export interface RunResult {
    status: 'pass' | 'fail' | 'timeout';
    summary: string;
    failures: TestFailure[];
    errors: string[];
}

export function parseRunArgs(args: string[]): RunOptions {
    const opts: RunOptions = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--timeout') {
            const val = Number(args[++i]);
            if (isNaN(val) || val <= 0) {
                throw new Error('--timeout must be a positive number (seconds)');
            }
            opts.timeoutMs = val * 1000;
        } else if (arg === '--quiet') {
            opts.quiet = true;
        } else if (arg === '--fail-fast') {
            opts.failFast = true;
        } else {
            if (opts.filter === undefined) {
                opts.filter = arg;
            }
        }
    }

    return opts;
}

export async function run(globalOpts: GlobalOptions, { filter, timeoutMs = DEFAULT_TIMEOUT_MS, quiet = false, failFast = false }: RunOptions = {}): Promise<RunResult> {
    if (!await isDevServerRunning(globalOpts.url)) {
        throw new Error(`Dev server not running at ${globalOpts.url}`);
    }
    await launchChrome(globalOpts.chromePort);

    const client = await getTestTab(globalOpts.chromePort, globalOpts.url);
    try {
        const { Page, Runtime } = client;
        await Page.enable();
        await Runtime.enable();

        const errors: string[] = [];
        Runtime.exceptionThrown(({ exceptionDetails }) => {
            errors.push(exceptionDetails.exception?.description || exceptionDetails.text);
        });
        Runtime.consoleAPICalled(({ type, args }) => {
            if (type === 'error') {
                errors.push(args.map(a => a.value ?? a.description ?? '').join(' '));
            }
        });

        const params = new URLSearchParams({ nolint: 'true' });
        if (filter) params.set('filter', filter);
        const url = `${globalOpts.url}/tests?${params}`;

        if (!quiet) console.error(url);
        const navigateResult = await Page.navigate({ url });
        if (navigateResult.errorText) {
            return { status: 'timeout', summary: `Navigation failed: ${navigateResult.errorText}`, failures: [], errors };
        }
        await Page.loadEventFired();

        const start = Date.now();
        let lastProgress = '';
        const statusScript = makeCheckStatusScript(failFast);

        while (Date.now() - start < timeoutMs) {
            try {
                const { result } = await Runtime.evaluate({
                    expression: statusScript,
                    returnByValue: true,
                });
                const s = result.value as {
                    status: string;
                    progress?: string;
                } | null;

                if (s?.status === 'pass' || s?.status === 'fail') {
                    const { summary, failures } = await extractTestResults(Runtime);
                    return { status: s.status as 'pass' | 'fail', summary, failures, errors };
                }

                if (!quiet && s?.progress && s.progress !== lastProgress) {
                    console.error(`${s.progress}\n`);
                    lastProgress = s.progress;
                }
            } catch (e) {
                // Ignore transient polling errors (e.g. tab navigated away mid-poll)
                if (!isConnectionRefused(e)) {
                    if (!quiet) console.error(`Polling error: ${e instanceof Error ? e.message : String(e)}`);
                }
            }

            await sleep(POLL_MS);
        }

        return { status: 'timeout', summary: 'Timeout waiting for tests', failures: [], errors };
    } finally {
        await client.close();
    }
}
