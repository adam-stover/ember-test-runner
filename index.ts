#!/usr/bin/env node
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import CDP from 'chrome-remote-interface';
import { launch } from 'chrome-launcher';

const CHROME_PORT = 9222;
const DEV_SERVER = 'http://localhost:4200';
const CHECK_TIMEOUT_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_MS = 500;

const stdout = (msg: unknown) => console.log(msg);
const stderr = (msg: unknown) => console.error(msg);

async function isChromeRunning(): Promise<boolean> {
    try {
        const r = await fetch(`http://localhost:${CHROME_PORT}/json/version`);
        return r.ok;
    } catch {
        return false;
    }
}

async function cleanup(): Promise<void> {
    try {
        const info = await fetch(`http://localhost:${CHROME_PORT}/json/version`);
        const { webSocketDebuggerUrl } = await info.json() as { webSocketDebuggerUrl: string };
        const browser = await CDP({ target: webSocketDebuggerUrl, port: CHROME_PORT });
        await browser.Browser.close();
        stderr('Chrome closed.');
    } catch (e) {
        stderr(`Failed to close Chrome: ${e instanceof Error ? e.message : e}`);
    }
}

async function launchChrome(): Promise<void> {
    if (await isChromeRunning()) return;

	stderr('Launching headless Chrome...');
	await launch({
    	port: CHROME_PORT,
    	chromeFlags: [
    		'--headless',
    	],
	});
}

async function isDevServerRunning(): Promise<boolean> {
    try {
        await fetch(DEV_SERVER, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
        return true;
    } catch {
        stderr(`Dev server not running at ${DEV_SERVER}`)
        return false;
    }
}

async function getTestTab(): Promise<CDP.Client> {
    const targets = await CDP.List({ port: CHROME_PORT });
    const tab = targets.find(t => t.type === 'page' && t.url.includes('localhost:4200'));
    if (tab) return CDP({ port: CHROME_PORT, target: tab });

    const created = await CDP.New({ port: CHROME_PORT, url: 'about:blank' });

	return CDP({ port: CHROME_PORT, target: created });
}

const CHECK_STATUS_SCRIPT = `(() => {
    const banner = document.getElementById('qunit-banner');
    if (!banner) return { status: 'loading' };
    if (banner.className.includes('qunit-pass')) return { status: 'pass' };
    if (banner.className.includes('qunit-fail')) return { status: 'fail' };
    const p = document.getElementById('qunit-testresult');
    return { status: 'running', progress: p?.textContent || '' };
})()`;

const EXTRACT_RESULTS_SCRIPT = `(() => {
    const el = document.getElementById('qunit-testresult');
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
    return { summary: el?.textContent || '', failures };
})()`;

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

async function screenshot(): Promise<void> {
    await launchChrome();
    const client = await getTestTab();
    const { Page } = client;

	const { data } = await Page.captureScreenshot({ format: 'png' });
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const path = join(tmpdir(), `ember-test-${timestamp}.png`);
	await writeFile(path, Buffer.from(data, 'base64'));
	stdout(path);
	await client.close();
}

async function evaluate(expression: string): Promise<void> {
    await launchChrome();
    const client = await getTestTab();
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

async function handleCompletedTests(Runtime: CDP.Client['Runtime']) {
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
        	if (a.source)   stdout(`  Source: ${a.source.trim()}`);
    	}
	}
}

async function run(filter?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    if (!await isDevServerRunning()) process.exit(1);
    await launchChrome();

	const client = await getTestTab();
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
	const url = `${DEV_SERVER}/tests?${params}`;

	stderr(url);
	const navigateResult = await Page.navigate({ url });
	if (navigateResult.errorText) {
    	stderr(`Error navigating: ${navigateResult.errorText}`);
    	process.exit(1);
	}
	await Page.loadEventFired();

	const start = Date.now();
	let lastProgress = '';

	while (Date.now() - start < timeoutMs) {
    	try {
        	const { result } = await Runtime.evaluate({
    			expression: CHECK_STATUS_SCRIPT,
    			returnByValue: true,
        	});
        	const s = result.value as {
            	status: string;
            	progress?: string;
        	} | null;

        	if (s?.status === 'pass' || s?.status === 'fail') {
            	await handleCompletedTests(Runtime);
            	await client.close();
            	process.exit(s.status === 'pass' ? 0 : 1);
        	}
    		if (s?.progress && s.progress !== lastProgress) {
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

const [cmd, ...args] = process.argv.slice(2);

function parseTimeout(args: string[]): number | undefined {
    const idx = args.indexOf('--timeout');
    if (idx === -1) return undefined;
    const val = Number(args[idx + 1]);
    if (isNaN(val) || val <= 0) {
        stderr('--timeout must be a positive number (seconds)');
        process.exit(1);
    }
    return val * 1000;
}

switch (cmd) {
    case 'run': {
    	const timeout = parseTimeout(args);
    	const filter = args.find((a, i) => a !== '--timeout' && args[i - 1] !== '--timeout');
    	await run(filter, timeout);
    	break;
    }
    case 'eval':
    	if (!args.length) {
        	stderr('Usage: ember-test-runner eval <expression>');
        	process.exit(1);
    	}
    	await evaluate(args.join(' '));
    	break;
    case 'screenshot':
    	await screenshot();
    	break;
    case 'clean':
    	await cleanup();
    	break;
    default:
        stdout(`Usage: ember-test-runner <command> [args]

Commands:
  run [filter] [--timeout <seconds>]   Run tests and wait for results
  eval <expression>                    Evaluate JS in the test page
  screenshot                           Screenshot the test page
  clean                                Cleanup after yourself (kill Chrome)
`);
        process.exit(cmd ? 1 : 0);
}

