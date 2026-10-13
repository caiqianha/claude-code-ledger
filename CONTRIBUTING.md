# Contributing

Thanks for helping. ccledger is a small zero-dependency Node CLI, so the loop is short.

## Setup

```bash
git clone https://github.com/caiqianha/claude-code-ledger
cd claude-code-ledger
npm test          # node --test, no install step
npm run demo      # run the CLI against synthetic data in /tmp/ccledger-demo
```

Node 18 or newer. There are no runtime dependencies and we would like to keep it that way.

## Ground rules

1. **Never read message content.** The loader only looks at usage, model, timestamps, tool names, tool input shapes and result sizes. A PR that touches `src/loader.js` or `src/parse.js` must keep that property, and tests must use the synthetic generator in `scripts/demo-data.mjs`, never a real transcript.
2. **One behaviour per PR.** Bug fix, new detector, new command: pick one.
3. **Add a test** in `test/features.test.js` (or `test/analyze.test.js` for pricing/aggregation) that fails before your change.
4. **Update `CHANGELOG.md`** under an "Unreleased" heading; the maintainer sets the version.
5. **Pricing changes** go through `pricing.json` with a source link in the PR description.

## Adding a waste detector

Detectors live in `src/analyze.js` and return `{ kind, tool, detail, count, cost }`. Keep the detail string free of user data: file basenames are fine, file contents and command arguments are not.

## Reporting a problem

Open an issue with the output of `ccledger --version`, your Node version, and the command you ran. Do not attach transcripts; if a specific line shape breaks the parser, describe the keys and types instead.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
