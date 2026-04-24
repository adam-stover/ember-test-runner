#!/usr/bin/env node
import {
    parseGlobalOptions,
    parseRunArgs,
    run,
    evaluate,
    screenshot,
    cleanup,
    type RunResult,
} from './lib.js';

async function main() {
    const rawArgs = process.argv.slice(2);
    const { options: globalOpts, remaining } = (() => {
        try {
            return parseGlobalOptions(rawArgs);
        } catch (e) {
            console.error(e instanceof Error ? e.message : String(e));
            process.exit(1);
        }
    })();
    const cmd = remaining.shift();
    const args = remaining;

    switch (cmd) {
        case 'run': {
            const runOpts = (() => {
                try {
                    return parseRunArgs(args);
                } catch (e) {
                    console.error(e instanceof Error ? e.message : String(e));
                    process.exit(1);
                }
            })();
            const result = await run(globalOpts, runOpts);
            printRunResult(result, runOpts.quiet ?? false);
            process.exit(result.status === 'pass' ? 0 : result.status === 'fail' ? 1 : 2);
            break;
        }
        case 'eval':
            if (!args.length) {
                console.error('Usage: ember-test-runner eval <expression>');
                process.exit(1);
            }
            try {
                await evaluate(globalOpts, args.join(' '));
            } catch (e) {
                console.error(e instanceof Error ? e.message : String(e));
                process.exit(1);
            }
            break;
        case 'screenshot':
            await screenshot(globalOpts);
            break;
        case 'clean':
            await cleanup(globalOpts.chromePort);
            break;
        default:
            console.log(`Usage: ember-test-runner <command> [args]

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
}

function extractTestSource(source: string): string {
    const lines = source.split('\n');
    for (const line of lines) {
        const match = line.match(/\/(tests\/[^?#]+)[^:]*:(\d+)(?::\d+)?/);
        if (match) return `at ${match[1]}:${match[2]}`;
    }
    for (const line of lines) {
        const match = line.match(/\/([^/]+\.(?:gjs|gts|js|ts))(?<!\.map)[^:]*:(\d+)(?::\d+)?/);
        if (match) return `at ${match[1]}:${match[2]}`;
    }
    return source.trim().split('\n')[0];
}

function printRunResult(result: RunResult, quiet: boolean): void {
    console.log(result.summary);
    for (const f of result.failures) {
        console.log(`\nFAILED: ${f.module}: ${f.name}`);
        for (const a of f.assertions) {
            if (a.message)  console.log(`  ${a.message}`);
            if (a.expected) console.log(`  Expected: ${a.expected}`);
            if (a.actual)   console.log(`  Actual: ${a.actual}`);
            if (a.source) {
                if (quiet) {
                    console.log(`  ${extractTestSource(a.source)}`);
                } else {
                    console.log(`  Source: ${a.source.trim()}`);
                }
            }
        }
    }
    if (result.status === 'timeout' && result.errors.length) {
        console.error('Errors encountered:');
        for (const e of result.errors) console.error(`  ${e}`);
    }
}

main().catch(e => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
});
