import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import {
  categorize,
  extractComposeEnvVars,
  readIfExists,
  which,
  getSearcher,
  countOccurrences,
  buildRows,
} from "../lib/vizenv.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, "..", "bin", "vizenv.js");

describe("categorize", () => {
  it("returns verbatim for plain values", () => {
    assert.deepStrictEqual(categorize("hello"), {
      value: "hello",
      type: "verbatim",
    });
  });

  it("returns verbatim for empty string", () => {
    assert.deepStrictEqual(categorize(""), { value: "", type: "verbatim" });
  });

  it("returns verbatim for numeric values", () => {
    assert.deepStrictEqual(categorize("3000"), {
      value: "3000",
      type: "verbatim",
    });
  });

  it("detects ${VAR} interpolation", () => {
    assert.deepStrictEqual(categorize("${DATABASE_URL}"), {
      value: "${DATABASE_URL}",
      type: "interpolation",
    });
  });

  it("detects ${VAR:-default} interpolation", () => {
    assert.deepStrictEqual(categorize("${PORT:-3000}"), {
      value: "${PORT:-3000}",
      type: "interpolation",
    });
  });

  it("detects $VAR interpolation", () => {
    assert.deepStrictEqual(categorize("$HOME/app"), {
      value: "$HOME/app",
      type: "interpolation",
    });
  });

  it("detects interpolation in mixed content", () => {
    assert.deepStrictEqual(categorize("postgres://${DB_USER}:${DB_PASS}@localhost"), {
      value: "postgres://${DB_USER}:${DB_PASS}@localhost",
      type: "interpolation",
    });
  });
});

describe("extractComposeEnvVars", () => {
  it("returns empty object for null input", () => {
    assert.deepStrictEqual(extractComposeEnvVars(null), {});
  });

  it("returns empty object for empty string", () => {
    assert.deepStrictEqual(extractComposeEnvVars(""), {});
  });

  it("returns empty object for yaml without services", () => {
    assert.deepStrictEqual(extractComposeEnvVars("version: '3'"), {});
  });

  it("extracts array-style environment variables", () => {
    const yaml = `
services:
  app:
    environment:
      - PORT=3000
      - DEBUG=true
`;
    const result = extractComposeEnvVars(yaml);
    assert.deepStrictEqual(result.PORT, { value: "3000", type: "verbatim" });
    assert.deepStrictEqual(result.DEBUG, { value: "true", type: "verbatim" });
  });

  it("extracts object-style environment variables", () => {
    const yaml = `
services:
  app:
    environment:
      PORT: 3000
      DEBUG: true
`;
    const result = extractComposeEnvVars(yaml);
    assert.deepStrictEqual(result.PORT, { value: "3000", type: "verbatim" });
    assert.deepStrictEqual(result.DEBUG, { value: "true", type: "verbatim" });
  });

  it("handles empty array-style entries (no value)", () => {
    const yaml = `
services:
  app:
    environment:
      - SECRET_KEY
`;
    const result = extractComposeEnvVars(yaml);
    assert.deepStrictEqual(result.SECRET_KEY, { value: "", type: "empty" });
  });

  it("handles null object-style values", () => {
    const yaml = `
services:
  app:
    environment:
      SECRET_KEY: null
`;
    const result = extractComposeEnvVars(yaml);
    assert.deepStrictEqual(result.SECRET_KEY, { value: "", type: "empty" });
  });

  it("detects interpolation in compose values", () => {
    const yaml = `
services:
  db:
    environment:
      - DATABASE_URL=\${DB_CONNECTION_STRING}
      - PORT=\${PORT:-5432}
`;
    const result = extractComposeEnvVars(yaml);
    assert.strictEqual(result.DATABASE_URL.type, "interpolation");
    assert.strictEqual(result.PORT.type, "interpolation");
  });

  it("extracts from multiple services", () => {
    const yaml = `
services:
  web:
    environment:
      - WEB_PORT=8080
  api:
    environment:
      API_PORT: 3000
`;
    const result = extractComposeEnvVars(yaml);
    assert.ok("WEB_PORT" in result);
    assert.ok("API_PORT" in result);
  });

  it("handles services without environment", () => {
    const yaml = `
services:
  app:
    image: nginx
  db:
    environment:
      DB_NAME: test
`;
    const result = extractComposeEnvVars(yaml);
    assert.deepStrictEqual(result.DB_NAME, { value: "test", type: "verbatim" });
  });
});

describe("readIfExists", () => {
  let tempDir;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vizenv-test-"));
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null for non-existent file", () => {
    assert.strictEqual(readIfExists(tempDir, "nonexistent.txt"), null);
  });

  it("reads existing file content", () => {
    writeFileSync(join(tempDir, "test.txt"), "hello world");
    assert.strictEqual(readIfExists(tempDir, "test.txt"), "hello world");
  });
});

describe("which", () => {
  it("returns true for common commands", () => {
    assert.strictEqual(which("node"), true);
  });

  it("returns false for non-existent commands", () => {
    assert.strictEqual(which("nonexistent-command-xyz"), false);
  });
});

describe("getSearcher", () => {
  it("returns a search tool object or undefined", () => {
    const searcher = getSearcher();
    if (searcher) {
      assert.ok(typeof searcher.name === "string");
      assert.ok(typeof searcher.buildCmd === "function");
    }
  });
});

describe("countOccurrences", () => {
  let tempDir;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vizenv-count-"));
    writeFileSync(join(tempDir, "app.js"), "const PORT = process.env.PORT;\nconst port = PORT;");
    writeFileSync(join(tempDir, "config.js"), "module.exports = { port: PORT }");
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns ? when no searcher available", () => {
    assert.strictEqual(countOccurrences("PORT", tempDir, null), "?");
  });

  it("counts occurrences with available searcher", () => {
    const searcher = getSearcher();
    if (searcher) {
      const count = countOccurrences("PORT", tempDir, searcher);
      assert.ok(typeof count === "number");
      assert.ok(count >= 3); // PORT appears at least 3 times
    }
  });

  it("returns 0 for non-existent key", () => {
    const searcher = getSearcher();
    if (searcher) {
      assert.strictEqual(countOccurrences("NONEXISTENT_VAR_XYZ", tempDir, searcher), 0);
    }
  });
});

describe("buildRows", () => {
  it("builds rows from all sources", () => {
    const composeVars = {
      PORT: { value: "${PORT:-3000}", type: "interpolation" },
    };
    const envVars = { PORT: "8080", SECRET: "abc" };
    const exampleVars = { PORT: "3000", API_KEY: "" };

    const rows = buildRows(composeVars, envVars, exampleVars, process.cwd(), null);

    assert.strictEqual(rows.length, 3); // PORT, SECRET, API_KEY
    assert.ok(rows.some((r) => r.Variable === "PORT"));
    assert.ok(rows.some((r) => r.Variable === "SECRET"));
    assert.ok(rows.some((r) => r.Variable === "API_KEY"));
  });

  it("marks compose presence correctly", () => {
    const composeVars = { DB_URL: { value: "postgres://", type: "verbatim" } };
    const envVars = { DB_URL: "postgres://localhost" };
    const exampleVars = {};

    const rows = buildRows(composeVars, envVars, exampleVars, process.cwd(), null);

    const dbRow = rows.find((r) => r.Variable === "DB_URL");
    assert.strictEqual(dbRow["In Compose"], "✔");
    assert.ok(dbRow["Compose Value"].includes("(verbatim)"));
  });

  it("sorts variables alphabetically", () => {
    const composeVars = {};
    const envVars = { ZEBRA: "1", APPLE: "2", MANGO: "3" };
    const exampleVars = {};

    const rows = buildRows(composeVars, envVars, exampleVars, process.cwd(), null);

    assert.strictEqual(rows[0].Variable, "APPLE");
    assert.strictEqual(rows[1].Variable, "MANGO");
    assert.strictEqual(rows[2].Variable, "ZEBRA");
  });
});

describe("CLI integration", () => {
  let tempDir;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vizenv-cli-"));
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("outputs 'No environment variables found' when no files exist", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "vizenv-empty-"));
    try {
      const output = execSync(`node ${cliPath}`, {
        cwd: emptyDir,
        encoding: "utf-8",
      });
      assert.ok(output.includes("No environment variables found"));
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("processes .env file", () => {
    const testDir = mkdtempSync(join(tmpdir(), "vizenv-env-"));
    writeFileSync(join(testDir, ".env"), "PORT=3000\nDEBUG=true");
    try {
      const output = execSync(`node ${cliPath}`, {
        cwd: testDir,
        encoding: "utf-8",
      });
      assert.ok(output.includes(".env"));
      assert.ok(output.includes("PORT"));
      assert.ok(output.includes("DEBUG"));
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("processes compose.yaml file", () => {
    const testDir = mkdtempSync(join(tmpdir(), "vizenv-compose-"));
    writeFileSync(
      join(testDir, "compose.yaml"),
      `
services:
  app:
    environment:
      - API_URL=http://localhost
`
    );
    try {
      const output = execSync(`node ${cliPath}`, {
        cwd: testDir,
        encoding: "utf-8",
      });
      assert.ok(output.includes("compose.yaml"));
      assert.ok(output.includes("API_URL"));
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("shows search tool in output", () => {
    const testDir = mkdtempSync(join(tmpdir(), "vizenv-search-"));
    writeFileSync(join(testDir, ".env"), "TEST=1");
    try {
      const output = execSync(`node ${cliPath}`, {
        cwd: testDir,
        encoding: "utf-8",
      });
      assert.ok(output.includes("Search tool:"));
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("handles all three files together", () => {
    const testDir = mkdtempSync(join(tmpdir(), "vizenv-all-"));
    writeFileSync(join(testDir, ".env"), "SECRET=real-secret");
    writeFileSync(join(testDir, ".env.example"), "SECRET=example-secret");
    writeFileSync(
      join(testDir, "compose.yaml"),
      `
services:
  app:
    environment:
      SECRET: \${SECRET}
`
    );
    try {
      const output = execSync(`node ${cliPath}`, {
        cwd: testDir,
        encoding: "utf-8",
      });
      assert.ok(output.includes(".env"));
      assert.ok(output.includes(".env.example"));
      assert.ok(output.includes("compose.yaml"));
      assert.ok(output.includes("SECRET"));
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
