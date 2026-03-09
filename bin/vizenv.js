#!/usr/bin/env node
import { parse as parseDotenv } from "dotenv";
import {
  readIfExists,
  extractComposeEnvVars,
  getSearcher,
  buildRows,
} from "../lib/vizenv.js";

const dir = process.cwd();

const envRaw = readIfExists(dir, ".env");
const exampleRaw = readIfExists(dir, ".env.example");
const composeRaw = readIfExists(dir, "compose.yaml");

const envVars = envRaw ? parseDotenv(envRaw) : {};
const exampleVars = exampleRaw ? parseDotenv(exampleRaw) : {};
const composeVars = extractComposeEnvVars(composeRaw);

const searcher = getSearcher();

const allKeys = [
  ...new Set([
    ...Object.keys(composeVars),
    ...Object.keys(envVars),
    ...Object.keys(exampleVars),
  ]),
];

if (allKeys.length === 0) {
  console.log("No environment variables found.");
  process.exit(0);
}

const rows = buildRows(composeVars, envVars, exampleVars, dir, searcher);

console.log(
  `\nFiles found:${envRaw !== null ? " .env" : ""}${exampleRaw !== null ? " .env.example" : ""}${composeRaw !== null ? " compose.yaml" : ""}`
);
console.log(`Search tool: ${searcher ? searcher.name : "none found"}\n`);
console.table(rows);
