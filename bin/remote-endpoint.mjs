#!/usr/bin/env node
import { remoteRequest } from "../src/remote.ts";
try {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input, "utf8") > 200000) throw new Error("Request too large");
  }
  console.log(JSON.stringify(remoteRequest(JSON.parse(input))));
} catch (error) { console.error(error.message); process.exitCode = 1; }
