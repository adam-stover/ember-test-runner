import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeUrl,
    parseGlobalOptions,
    parseRunArgs,
    isConnectionRefused,
    DEFAULT_URL,
    DEFAULT_CHROME_PORT,
} from '../lib.js';

describe('normalizeUrl', () => {
    it('strips a single trailing slash', () => {
        assert.strictEqual(normalizeUrl('http://localhost:4200/'), 'http://localhost:4200');
    });

    it('leaves a url without trailing slash alone', () => {
        assert.strictEqual(normalizeUrl('http://localhost:4200'), 'http://localhost:4200');
    });

    it('only strips one trailing slash', () => {
        assert.strictEqual(normalizeUrl('http://localhost:4200//'), 'http://localhost:4200/');
    });
});

describe('parseGlobalOptions', () => {
    it('returns defaults when no flags are given', () => {
        const { options, remaining } = parseGlobalOptions(['run']);
        assert.strictEqual(options.url, DEFAULT_URL);
        assert.strictEqual(options.chromePort, DEFAULT_CHROME_PORT);
        assert.deepStrictEqual(remaining, ['run']);
    });

    it('parses --url', () => {
        const { options, remaining } = parseGlobalOptions(['run', '--url', 'http://localhost:3000']);
        assert.strictEqual(options.url, 'http://localhost:3000');
        assert.deepStrictEqual(remaining, ['run']);
    });

    it('normalizes trailing slash on --url', () => {
        const { options } = parseGlobalOptions(['--url', 'http://localhost:3000/']);
        assert.strictEqual(options.url, 'http://localhost:3000');
    });

    it('parses --chrome-port', () => {
        const { options } = parseGlobalOptions(['--chrome-port', '9223']);
        assert.strictEqual(options.chromePort, 9223);
    });

    it('parses both flags in any order', () => {
        const { options } = parseGlobalOptions(['--chrome-port', '9223', '--url', 'http://host:3000']);
        assert.strictEqual(options.url, 'http://host:3000');
        assert.strictEqual(options.chromePort, 9223);
    });

    it('leaves unrecognized args in remaining', () => {
        const { options, remaining } = parseGlobalOptions(['run', '--quiet', 'my-filter']);
        assert.strictEqual(options.url, DEFAULT_URL);
        assert.deepStrictEqual(remaining, ['run', '--quiet', 'my-filter']);
    });

    it('rejects missing --url value', () => {
        assert.throws(() => parseGlobalOptions(['--url']), /requires a value/);
    });

    it('rejects malformed --url', () => {
        assert.throws(() => parseGlobalOptions(['--url', 'htp://bad']), /valid http\(s\) URL/);
        assert.throws(() => parseGlobalOptions(['--url', 'foo']), /valid http\(s\) URL/);
    });

    it('rejects non-http(s) protocol', () => {
        assert.throws(() => parseGlobalOptions(['--url', 'ftp://localhost:4200']), /valid http\(s\) URL/);
    });

    it('rejects non-integer --chrome-port', () => {
        assert.throws(() => parseGlobalOptions(['--chrome-port', '9222.5']), /integer between 1 and 65535/);
    });

    it('rejects out-of-range --chrome-port', () => {
        assert.throws(() => parseGlobalOptions(['--chrome-port', '0']), /integer between 1 and 65535/);
        assert.throws(() => parseGlobalOptions(['--chrome-port', '99999']), /integer between 1 and 65535/);
    });

    it('rejects missing --chrome-port value', () => {
        assert.throws(() => parseGlobalOptions(['--chrome-port']), /integer between 1 and 65535/);
    });
});

describe('parseRunArgs', () => {
    it('returns empty opts for no args', () => {
        assert.deepStrictEqual(parseRunArgs([]), {});
    });

    it('parses --timeout in seconds to milliseconds', () => {
        assert.deepStrictEqual(parseRunArgs(['--timeout', '30']), { timeoutMs: 30_000 });
    });

    it('parses --quiet', () => {
        assert.deepStrictEqual(parseRunArgs(['--quiet']), { quiet: true });
    });

    it('parses --fail-fast', () => {
        assert.deepStrictEqual(parseRunArgs(['--fail-fast']), { failFast: true });
    });

    it('parses a positional filter', () => {
        assert.deepStrictEqual(parseRunArgs(['Unit | Service | todo']), { filter: 'Unit | Service | todo' });
    });

    it('parses flags and filter together', () => {
        assert.deepStrictEqual(
            parseRunArgs(['--timeout', '60', '--quiet', 'my-filter']),
            { timeoutMs: 60_000, quiet: true, filter: 'my-filter' }
        );
    });

    it('rejects non-numeric --timeout', () => {
        assert.throws(() => parseRunArgs(['--timeout', 'abc']), /positive number/);
    });

    it('rejects negative --timeout', () => {
        assert.throws(() => parseRunArgs(['--timeout', '-5']), /positive number/);
    });

    it('rejects zero --timeout', () => {
        assert.throws(() => parseRunArgs(['--timeout', '0']), /positive number/);
    });
});

describe('isConnectionRefused', () => {
    it('returns true for ECONNREFUSED TypeError', () => {
        const err = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
        assert.strictEqual(isConnectionRefused(err), true);
    });

    it('returns false for other TypeErrors', () => {
        const err = new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
        assert.strictEqual(isConnectionRefused(err), false);
    });

    it('returns false for plain Errors', () => {
        assert.strictEqual(isConnectionRefused(new Error('foo')), false);
    });

    it('returns false for null', () => {
        assert.strictEqual(isConnectionRefused(null), false);
    });
});
