#!/usr/bin/env node
// Render assets/demo.gif with vhs, injecting the current node's PATH so the tape stays portable.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Output paths in a tape are relative to the cwd, and "ccledger" only exists on PATH after npm install,
// so the tape defines a shell function pointing at this checkout instead.
const tape = fs
  .readFileSync("demo.tape", "utf8")
  .replace("__NODE__", process.execPath)
  .replace("__BIN__", path.resolve("bin/ccledger.js"));
const tmp = path.join(os.tmpdir(), "ccledger-demo.tape");
fs.writeFileSync(tmp, tape);
execFileSync("vhs", [tmp], { stdio: "inherit" });
