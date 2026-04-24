#!/usr/bin/env node
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import CDP from 'chrome-remote-interface';
import { launch } from 'chrome-launcher';

const DEFAULT_URL = 'http://localhost:4200';
const DEFAULT_CHROME_PORT = 9222;
const CHECK_TIMEOUT_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_MS = 500;
const DEV_SERVER_RETRIES = 5;
const DEV_SERVER_RETRY_MS = 1_000;

const stdout = (msg: unknown) => console.log(msg);
const stderr = (msg: unknown) => console.error(msg);

interface GlobalOptions {
    url: string;
    chromePort: number;
}

function normalizeUrl(url: string): string {
    return url.replace(/\/$/, '');
}

function parseGlobalOptions(args: string[]): { options: GlobalOptions; remaining: string[] } {
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
                stderr('--url requires a value');
                process.exit(1);
            }
            try {
                opts.url = normalizeUrl(val);
                const u = new URL(opts.url);
                if (u.protocol !== 'http:' && u.protocol !== 'https:') {
                    throw new Error('protocol must be http or https');
                }
            } catch {
                stderr(`--url must be a valid http(s) URL (got: ${val})`);
                process.exit(1);
            }
        } else if (arg === '--chrome-port') {
            const val = args[++i];
            const num = Number(val);
            if (!val || !Number.isInteger(num) || num < 1 || num > 65535) {
                stderr('--chrome-port must be an integer between 1 and 65535');
                process.exit(1);
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
        const r = await fetch(`http://localhost:${port}/json/version`);
        return r.ok;
    } catch {
        return false;
    }
}

async function cleanup(port: number): Promise<void> {
    try {
        const info = await fetch(`http://localhost:${port}/json/version`);
        const { webSocketDebuggerUrl } = await info.json() as { webSocketDebuggerUrl: string };
        const browser = await CDP({ target: webSocketDebuggerUrl, port });
        await browser.Browser.close();
        stderr('Chrome closed.');
    } catch (e) {
        stderr(`Failed to close Chrome: ${e instanceof Error ? e.message : e}`);
    }
}

async function launchChrome(port: number): Promise<void> {
    if (await isChromeRunning(port)) return;

    stderr('Launching headless Chrome...');
    await launch({
        port,
        chromeFlags: [
            '--headless',
        ],
    });
}

async function isDevServerRunning(url: string): Promise<boolean> {
    for (let i = 0; i < DEV_SERVER_RETRIES; i++) {
        try {
            await fetch(url, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
            return true;
        } catch {
            if (i < DEV_SERVER_RETRIES - 1) {
                await sleep(DEV_SERVER_RETRY_MS);
            }
        }
    }
    stderr(`Dev server not running at ${url}`);
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

const CHECK_STATUS_SCRIPT = `(() => {
    const banner = document.getElementById('qunit-banner');
    if (!banner) return { status: 'loading' };
    if (banner.className.includes('qunit-pass')) return { status: 'pass' };
    if (banner.className.includes('qunit-fail')) return { status: 'fail' };
    const d = document.getElementById('qunit-testresult-display');
    const progress = (d?.innerText || '').replace(/Rerun.*$/, '').trim();
    return { status: 'running', progress };
})()`;

const CHECK_STATUS_FAIL_FAST_SCRIPT = `(() => {
    const banner = document.getElementById('qunit-banner');
    if (!banner) return { status: 'loading' };
    if (banner.className.includes('qunit-pass')) return { status: 'pass' };
    if (banner.className.includes('qunit-fail')) return { status: 'fail' };
    if (document.querySelector('#qunit-tests > li.fail')) return { status: 'fail' };
    const d = document.getElementById('qunit-testresult-display');
    const progress = (d?.innerText || '').replace(/Rerun.*$/, '').trim();
    return { status: 'running', progress };
})()`;

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

async function screenshot(globalOpts: GlobalOptions): Promise<void> {
    await launchChrome(globalOpts.chromePort);
    const client = await getTestTab(globalOpts.chromePort, globalOpts.url);
    const { Page } = client;

    const { data } = await Page.captureScreenshot({ format: 'png' });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(tmpdir(), `ember-test-${timestamp}.png`);
    await writeFile(path, Buffer.from(data, 'base64'));
    stdout(path);
    await client.close();
}

async function evaluate(globalOpts: GlobalOptions, expression: string): Promise<void> {
    await launchChrome(globalOpts.chromePort);
    const client = await getTestTab(globalOpts.chromePort, globalOpts.url);
    const { Runtime } = client;
    await Runtime.enable();

    const { result, exceptionDetails } = await Runtime.evaluate({
        expression,
        returnByValue: true,
        awaitPromise: true,
    });

    if (exceptionDetails) {
        stderr(`Error: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
        await client.close();
        process.exit(1);
    }

    const output = (result.value && typeof result.value === 'object')
        ? JSON.stringify(result.value, null, 2)
        : result.value;
    stdout(output);
    await client.close();
}

function extractTestSource(source: string): string {
    // Find the first frame pointing to a test file, strip the URL noise
    const lines = source.split('\n');
    for (const line of lines) {
        const match = line.match(/\/(tests\/[^?#]+)[^:]*:(\d+)(?::\d+)?/);
        if (match) return `at ${match[1]}:${match[2]}`;
    }
    // Fallback: try to extract any source file reference (not .map files)
    for (const line of lines) {
        const match = line.match(/\/([^/]+\.(?:gjs|gts|js|ts))(?<!\.map)[^:]*:(\d+)(?::\d+)?/);
        if (match) return `at ${match[1]}:${match[2]}`;
    }
    return source.trim().split('\n')[0];
}

async function handleCompletedTests(Runtime: CDP.Client['Runtime'], quiet = false) {
    const { result } = await Runtime.evaluate({
        expression: EXTRACT_RESULTS_SCRIPT,
        returnByValue: true,
    });

    const data = result.value as {
        summary: string;
        failures: {
            module: string;
            name: string;
            assertions: {
                message: string;
                expected: string;
                actual: string;
                source: string;
            }[];
        }[];
    };

    stdout(data.summary);
    for (const f of data.failures) {
        stdout(`\nFAILED: ${f.module}: ${f.name}`);
        for (const a of f.assertions) {
            if (a.message)  stdout(`  ${a.message}`);
            if (a.expected) stdout(`  Expected: ${a.expected}`);
            if (a.actual)   stdout(`  Actual: ${a.actual}`);
            if (a.source) {
                if (quiet) {
                    stdout(`  ${extractTestSource(a.source)}`);
                } else {
                    stdout(`  Source: ${a.source.trim()}`);
                }
            }
        }
    }
}

interface RunOptions {
    filter?: string;
    timeoutMs?: number;
    quiet?: boolean;
    failFast?: boolean;
}

function parseRunArgs(args: string[]): RunOptions {
    const opts: RunOptions = {};
    const flagArgs = new Set<number>();

    const timeoutIdx = args.indexOf('--timeout');
    if (timeoutIdx !== -1) {
        const val = Number(args[timeoutIdx + 1]);
        if (isNaN(val) || val <= 0) {
            stderr('--timeout must be a positive number (seconds)');
            process.exit(1);
        }
        opts.timeoutMs = val * 1000;
        flagArgs.add(timeoutIdx);
        flagArgs.add(timeoutIdx + 1);
    }

    if (args.includes('--quiet')) {
        opts.quiet = true;
        flagArgs.add(args.indexOf('--quiet'));
    }

    if (args.includes('--fail-fast')) {
        opts.failFast = true;
        flagArgs.add(args.indexOf('--fail-fast'));
    }

    opts.filter = args.find((_, i) => !flagArgs.has(i));
    return opts;
}

async function run(globalOpts: GlobalOptions, { filter, timeoutMs = DEFAULT_TIMEOUT_MS, quiet = false, failFast = false }: RunOptions = {}): Promise<void> {
    if (!await isDevServerRunning(globalOpts.url)) process.exit(1);
    await launchChrome(globalOpts.chromePort);

    const client = await getTestTab(globalOpts.chromePort, globalOpts.url);
    const { Page, Runtime } = client;
    await Page.enable();
    await Runtime.enable();

    const errors: string[] = [];
    Runtime.exceptionThrown(({ exceptionDetails }) => {
        errors.push(exceptionDetails.exception?.description || exceptionDetails.text);
    });
    Runtime.consoleAPICalled(({ type, args }) => {
        if (type === 'error') {
            errors.push(args.map(a => a.value || a.description || '').join(' '));
        }
    });

    const params = new URLSearchParams({ nolint: 'true' });
    if (filter) params.set('filter', filter);
    const url = `${globalOpts.url}/tests?${params}`;

    if (!quiet) stderr(url);
    const navigateResult = await Page.navigate({ url });
    if (navigateResult.errorText) {
        stderr(`Error navigating: ${navigateResult.errorText}`);
        process.exit(1);
    }
    await Page.loadEventFired();

    const start = Date.now();
    let lastProgress = '';
    const statusScript = failFast ? CHECK_STATUS_FAIL_FAST_SCRIPT : CHECK_STATUS_SCRIPT;

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
                await handleCompletedTests(Runtime, quiet);
                await client.close();
                process.exit(s.status === 'pass' ? 0 : 1);
            }

            if (!quiet && s?.progress && s.progress !== lastProgress) {
                stderr(`${s.progress}\n`);
                lastProgress = s.progress;
            }
        } catch {
            // keep polling baby
        }

        await sleep(POLL_MS);
    }

    stderr('Timeout waiting for tests');
    if (errors.length) {
        stderr('Errors encountered:');
        for (const e of errors) stderr(`  ${e}`);
    }
    await client.close();
    process.exit(2);
}

const [_cmd, ..._args] = process.argv.slice(2);
const { options: globalOpts, remaining } = parseGlobalOptions([_cmd, ..._args]);
const cmd = remaining.shift();
const args = remaining;

switch (cmd) {
    case 'run': {
        await run(globalOpts, parseRunArgs(args));
        break;
    }
    case 'eval':
        if (!args.length) {
            stderr('Usage: ember-test-runner eval <expression>');
            process.exit(1);
        }
        await evaluate(globalOpts, args.join(' '));
        break;
    case 'screenshot':
        await screenshot(globalOpts);
        break;
    case 'clean':
        await cleanup(globalOpts.chromePort);
        break;
    default:
        stdout(`Usage: ember-test-runner <command> [args]

Commands:
  run [filter] [options]   Run tests and wait for results
    --timeout <seconds>    Set test timeout (default: 120)
    --quiet                Concise output (no progress, short source locations)
    --fail-fast            Stop on first failure
  eval <expression>        Evaluate JS in the test page
  screenshot               Screenshot the test page
  clean                    Cleanup after yourself (kill Chrome)

Global flags:
  --url <url>              Dev server base URL (default: http://localhost:4200)
  --chrome-port <port>     Chrome remote-debugging port (default: 9222)
`);
        process.exit(cmd ? 1 : 0);
}
