#!/usr/bin/env node
import { runNativeBenchmarkCli } from "./core/native-benchmark.ts";

const exitCode = await runNativeBenchmarkCli(process.argv.slice(2));
process.exit(exitCode);
