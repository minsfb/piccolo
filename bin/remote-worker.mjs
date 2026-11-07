#!/usr/bin/env node
import { remoteWorker } from "../src/remote.ts";
try { await remoteWorker(process.argv[2], process.argv[3]); }
catch (error) { console.error(error.message); process.exitCode = 1; }
