# ember-test-runner

[![npm](https://img.shields.io/npm/v/ember-test-runner)](https://www.npmjs.com/package/ember-test-runner)

Run Ember QUnit tests headlessly via Chrome DevTools Protocol. Requires a running `ember serve` dev server.

## Install

```bash
npm install -D ember-test-runner
```

## Usage

```bash
npx ember-test-runner <command>
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

### Global flags

| Flag                | Description                                             |
|---------------------|---------------------------------------------------------|
| `--url <url>`       | Dev server base URL (default: `http://localhost:4200`) |
| `--chrome-port <n>` | Chrome remote-debugging port (default: `9222`)          |

These flags apply to all commands (`run`, `eval`, `screenshot`, `clean`).

### Exit codes

`0` all passed, `1` failures, `2` timeout.

### Output

stdout has test results (summary + failures). stderr has progress and diagnostics (`--quiet` suppresses stderr).
