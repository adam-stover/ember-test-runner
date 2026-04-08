# ember-test-runner

[![npm](https://img.shields.io/npm/v/ember-test-runner)](https://www.npmjs.com/package/ember-test-runner)

Run Ember QUnit tests headlessly via Chrome DevTools Protocol. Requires a running `ember serve` dev server.

## Setup

```bash
npm install
```

## Usage

```bash
npx tsx index.ts <command>
```

| Command                | Description                       |
|------------------------|-----------------------------------|
| `run [filter]`         | Run tests and wait for results    |
| `eval <expression>`    | Evaluate JS in the test page      |
| `screenshot`           | Screenshot the test page (PNG)    |
| `clean`                | Kill the headless Chrome instance |

### Run flags

| Flag               | Description                                  |
|--------------------|----------------------------------------------|
| `--timeout <secs>` | Test timeout in seconds (default: 120)       |
| `--quiet`          | No progress output, concise source locations |
| `--fail-fast`      | Stop on first failure                        |

### Exit codes

`0` all passed, `1` failures, `2` timeout.

### Output

stdout has test results (summary + failures). stderr has progress and diagnostics (`--quiet` suppresses stderr).
