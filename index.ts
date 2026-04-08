import CDP from 'chrome-remote-interface';
import * as ChromeLauncher from 'chrome-launcher';

const CHROME_PORT = 9222;
const DEV_SERVER = 'https://localhost:4200';

// Chrome

async function isChromeRunning(): Promise<boolean> {
    try {
        const r = await fetch(`http://localhost:${CHROME_PORT}/json/version`);
        return r.ok;
    } catch {
        return false;
    }
}

async function cleanup(): Promise<void> {
    await ChromeLauncher.killAll();
}

async function launchChrome(): Promise<void> {
    if (await isChromeRunning()) return;

	try {
    	await ChromeLauncher.launch({
        	startingUrl: DEV_SERVER,
        	chromeFlags: [
        		'--headless',
        		`--remote-debugging-port=${CHROME_PORT}`,
        	],
    	});
	} catch (e) {
    	console.error(e);
	}
}


