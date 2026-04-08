# ember-test-runner

Run Ember QUnit tests headlessly via Chrome DevTools Protocol. Requires a running `ember serve` dev server.

## Setup

```bash
npm install
```

## Usage

```bash
npx tsx index.ts <command>
```

| Command             | Description                       |
|---------------------|-----------------------------------|
| `run [filter]`      | Run tests and wait for results    |
| `eval <expression>` | Evaluate JS in the test page      |
| `screenshot`        | Screenshot the test page          |
| `clean`             | Kill the headless Chrome instance |

