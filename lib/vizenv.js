import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { parse as parseYaml } from "yaml";
import { parse as parseDotenv } from "dotenv";
import { resolve } from "path";

export function readIfExists(dir, filename) {
  const path = resolve(dir, filename);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

export function categorize(val) {
  // Check for Docker Compose variable interpolation: ${VAR} or ${VAR:-default} or $VAR
  if (/\$\{[^}]+\}/.test(val) || /\$[A-Za-z_][A-Za-z0-9_]*/.test(val)) {
    return { value: val, type: "interpolation" };
  }
  return { value: val, type: "verbatim" };
}

export function extractComposeEnvVars(composeContent) {
  if (!composeContent) return {};
  const doc = parseYaml(composeContent);
  const vars = {};

  if (!doc?.services) return vars;

  for (const [, service] of Object.entries(doc.services)) {
    const env = service?.environment;
    if (!env) continue;

    if (Array.isArray(env)) {
      for (const entry of env) {
        const eqIdx = entry.indexOf("=");
        if (eqIdx === -1) {
          vars[entry] = { value: "", type: "empty" };
        } else {
          const key = entry.slice(0, eqIdx);
          const val = entry.slice(eqIdx + 1);
          vars[key] = categorize(val);
        }
      }
    } else if (typeof env === "object") {
      for (const [key, val] of Object.entries(env)) {
        if (val === null || val === undefined) {
          vars[key] = { value: "", type: "empty" };
        } else {
          vars[key] = categorize(String(val));
        }
      }
    }
  }

  return vars;
}

export function which(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export const searchTools = [
  {
    name: "rg",
    buildCmd: (key) =>
      `rg --fixed-strings --no-filename --count-matches -g '!.env' -g '!.env.example' -g '!compose.yaml' -g '!node_modules' -- ${JSON.stringify(key)} .`,
  },
  {
    name: "ack",
    buildCmd: (key) =>
      `ack --literal --no-filename --count --ignore-dir=node_modules --ignore-file=match:/^\\.env/ --ignore-file=match:/^compose\\.yaml$/ -- ${JSON.stringify(key)} .`,
  },
  {
    name: "ag",
    buildCmd: (key) =>
      `ag --literal --no-filename --count --ignore=node_modules --ignore=.env --ignore=.env.example --ignore=compose.yaml -- ${JSON.stringify(key)} .`,
  },
  {
    name: "grep",
    buildCmd: (key) =>
      `grep -r --fixed-strings --exclude=.env --exclude=.env.example --exclude=compose.yaml --exclude-dir=node_modules -c -- ${JSON.stringify(key)} .`,
  },
];

export function getSearcher() {
  return searchTools.find((t) => which(t.name));
}

export function countOccurrences(key, dir, searcher) {
  if (!searcher) return "?";
  try {
    const out = execSync(searcher.buildCmd(key), {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: dir,
    }).toString();
    let total = 0;
    for (const line of out.trim().split("\n")) {
      if (!line) continue;
      const num = parseInt(line.includes(":") ? line.split(":").pop() : line, 10);
      if (!isNaN(num)) total += num;
    }
    return total;
  } catch {
    return 0;
  }
}

export function buildRows(composeVars, envVars, exampleVars, dir, searcher) {
  const allKeys = [...new Set([
    ...Object.keys(composeVars),
    ...Object.keys(envVars),
    ...Object.keys(exampleVars),
  ])].sort();

  return allKeys.map((key) => {
    const inCompose = key in composeVars;
    const c = composeVars[key];
    let composeVal = "";
    if (inCompose) {
      const tag = c.type === "interpolation" ? " (interpolation)" : c.type === "verbatim" ? " (verbatim)" : "";
      composeVal = c.value + tag;
    }

    return {
      Variable: key,
      "In Compose": inCompose ? "✔" : "",
      "Compose Value": composeVal,
      ".env": envVars[key] ?? "",
      ".env.example": exampleVars[key] ?? "",
      "Source Refs": countOccurrences(key, dir, searcher),
    };
  });
}
