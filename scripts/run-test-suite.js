const fs = require("fs");
const path = require("path");
const { loadCompiler } = require("./compiler-adapter");

const workspaceRoot = path.resolve(__dirname, "..");
const reportsDir = path.join(workspaceRoot, "reports");
const localTestDir = path.join(workspaceRoot, "test");
const test262Root = path.join(workspaceRoot, "external", "test262");
const test262TestRoot = path.join(test262Root, "test");
const args = new Set(process.argv.slice(2));

function now() {
  return new Date().toISOString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function discoverLocalTests() {
  return fs
    .readdirSync(localTestDir)
    .filter((file) => file.endsWith(".js"))
    .filter((file) => !file.endsWith(".expected.js"))
    .filter((file) => file !== "my-module.js")
    .sort();
}

function walkJsFiles(rootDir) {
  const files = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".js")) {
        continue;
      }

      if (entry.name.includes("_FIXTURE")) {
        continue;
      }

      files.push(fullPath);
    }
  }

  files.sort();
  return files;
}

function parseFlags(text) {
  const flagsMatch = text.match(/flags:\s*\[([^\]]*)\]/);
  if (!flagsMatch) {
    return [];
  }

  return flagsMatch[1]
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseNegativePhase(text) {
  const negativeBlock = text.match(/negative:\s*([\s\S]*?)(?:\n[a-zA-Z][^:\n]*:|\n---)/);
  if (!negativeBlock) {
    return null;
  }

  const phaseMatch = negativeBlock[1].match(/phase:\s*([^\n]+)/);
  return phaseMatch ? phaseMatch[1].trim() : null;
}

function parseTest262Metadata(code) {
  const frontmatterMatch = code.match(/\/\*---([\s\S]*?)---\*\//);
  const frontmatter = frontmatterMatch ? frontmatterMatch[1] : "";
  const flags = parseFlags(frontmatter);
  const negativePhase = parseNegativePhase(frontmatter);

  return {
    flags,
    negativePhase,
    sourceType: flags.includes("module") ? "module" : "script",
    expectCompileFailure: negativePhase === "parse"
  };
}

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function silenceCompilerLogs(callback) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await callback();
  } finally {
    console.log = originalLog;
  }
}

async function runLocalCompilerSuite() {
  const { compileProgram } = loadCompiler();
  const files = discoverLocalTests();
  const results = [];

  for (const file of files) {
    const fullPath = path.join(localTestDir, file);
    const code = fs.readFileSync(fullPath, "utf8");
    const startedAt = Date.now();

    try {
      await silenceCompilerLogs(() =>
        compileProgram(code, { sourceType: "module" })
      );
      results.push({
        id: file,
        suite: "local-compiler",
        status: "passed",
        expected: "pass",
        file: path.relative(workspaceRoot, fullPath),
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      const message = getErrorMessage(error);
      results.push({
        id: file,
        suite: "local-compiler",
        status: "failed",
        expected: "pass",
        file: path.relative(workspaceRoot, fullPath),
        durationMs: Date.now() - startedAt,
        error: message,
        classification: message.startsWith("Unsupported")
          ? "unsupported"
          : "compile-error"
      });
    }
  }

  return results;
}

async function runTest262CompilerSuite() {
  const { compileProgram } = loadCompiler();
  const files = walkJsFiles(test262TestRoot);
  const results = [];
  let index = 0;

  for (const fullPath of files) {
    index += 1;
    if (index % 1000 === 0) {
      console.log(`Progress: ${index}/${files.length}`);
    }

    const relativeFile = path.relative(workspaceRoot, fullPath);
    const startedAt = Date.now();
    const code = fs.readFileSync(fullPath, "utf8");
    const metadata = parseTest262Metadata(code);

    try {
      await silenceCompilerLogs(() =>
        compileProgram(code, { sourceType: metadata.sourceType })
      );
      if (metadata.expectCompileFailure) {
        results.push({
          id: path.relative(test262TestRoot, fullPath),
          suite: "test262-compiler",
          status: "failed",
          expected: "parse-fail",
          file: relativeFile,
          durationMs: Date.now() - startedAt,
          classification: "unexpected-compile-success",
          error: "Expected a parse failure, but compilation succeeded."
        });
      } else {
        results.push({
          id: path.relative(test262TestRoot, fullPath),
          suite: "test262-compiler",
          status: "passed",
          expected: "pass",
          file: relativeFile,
          durationMs: Date.now() - startedAt
        });
      }
    } catch (error) {
      const message = getErrorMessage(error);
      if (metadata.expectCompileFailure) {
        results.push({
          id: path.relative(test262TestRoot, fullPath),
          suite: "test262-compiler",
          status: "passed",
          expected: "parse-fail",
          file: relativeFile,
          durationMs: Date.now() - startedAt,
          note: message
        });
      } else {
        results.push({
          id: path.relative(test262TestRoot, fullPath),
          suite: "test262-compiler",
          status: "failed",
          expected: "pass",
          file: relativeFile,
          durationMs: Date.now() - startedAt,
          classification: message.startsWith("Unsupported")
            ? "unsupported"
            : "compile-error",
          error: message
        });
      }
    }
  }

  return results;
}

function summarize(results) {
  const summary = {
    total: results.length,
    passed: 0,
    failed: 0,
    bySuite: {},
    byClassification: {}
  };

  for (const result of results) {
    if (!summary.bySuite[result.suite]) {
      summary.bySuite[result.suite] = { total: 0, passed: 0, failed: 0 };
    }

    summary.bySuite[result.suite].total += 1;
    summary[result.status] += 1;
    summary.bySuite[result.suite][result.status] += 1;

    if (result.classification) {
      summary.byClassification[result.classification] =
        (summary.byClassification[result.classification] || 0) + 1;
    }
  }

  return summary;
}

function renderHtml(report) {
  const failures = report.results
    .filter((result) => result.status === "failed")
    .map((result) => {
      const details = result.error || result.note || "";
      return `<tr>
<td>${escapeHtml(result.suite)}</td>
<td>${escapeHtml(result.id)}</td>
<td>${escapeHtml(result.status)}</td>
<td>${escapeHtml(result.expected)}</td>
<td>${escapeHtml(result.file)}</td>
<td>${escapeHtml(result.durationMs)}</td>
<td>${escapeHtml(details)}</td>
</tr>`;
    })
    .join("\n");

  const suiteRows = Object.entries(report.summary.bySuite)
    .map(
      ([suiteName, suiteSummary]) => `<tr>
<td>${escapeHtml(suiteName)}</td>
<td>${suiteSummary.total}</td>
<td>${suiteSummary.passed}</td>
<td>${suiteSummary.failed}</td>
</tr>`
    )
    .join("\n");

  const classificationRows = Object.entries(report.summary.byClassification)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(
      ([name, count]) => `<tr>
<td>${escapeHtml(name)}</td>
<td>${count}</td>
</tr>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>jsvm test report</title>
  <style>
    :root {
      --bg: #f6f1e8;
      --panel: #fffdf8;
      --text: #1f2933;
      --muted: #52606d;
      --pass: #1f7a4c;
      --fail: #b42318;
      --border: #d9cdbd;
    }
    body {
      margin: 0;
      padding: 32px;
      background: linear-gradient(180deg, #f7efe3 0%, #efe4d3 100%);
      color: var(--text);
      font: 16px/1.5 Georgia, "Times New Roman", serif;
    }
    .panel {
      max-width: 1200px;
      margin: 0 auto;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 24px;
      box-shadow: 0 16px 40px rgba(69, 57, 43, 0.08);
    }
    h1 {
      margin-top: 0;
      font-size: 32px;
    }
    .summary {
      display: flex;
      gap: 24px;
      flex-wrap: wrap;
      margin-bottom: 24px;
    }
    .metric {
      padding: 12px 16px;
      border: 1px solid var(--border);
      border-radius: 12px;
      min-width: 140px;
    }
    .muted {
      color: var(--muted);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      text-align: left;
      vertical-align: top;
    }
    .passed {
      color: var(--pass);
      font-weight: 700;
    }
    .failed {
      color: var(--fail);
      font-weight: 700;
    }
  </style>
</head>
<body>
  <div class="panel">
    <h1>jsvm test report</h1>
    <p class="muted">Generated at ${escapeHtml(report.generatedAt)}</p>
    <div class="summary">
      <div class="metric"><strong>Total</strong><br>${report.summary.total}</div>
      <div class="metric"><strong class="passed">Passed</strong><br>${report.summary.passed}</div>
      <div class="metric"><strong class="failed">Failed</strong><br>${report.summary.failed}</div>
    </div>
    <h2>By Suite</h2>
    <table>
      <thead>
        <tr>
          <th>Suite</th>
          <th>Total</th>
          <th>Passed</th>
          <th>Failed</th>
        </tr>
      </thead>
      <tbody>
        ${suiteRows}
      </tbody>
    </table>
    <h2>Top Failure Classes</h2>
    <table>
      <thead>
        <tr>
          <th>Classification</th>
          <th>Count</th>
        </tr>
      </thead>
      <tbody>
        ${classificationRows}
      </tbody>
    </table>
    <h2>Failures</h2>
    <table>
      <thead>
        <tr>
          <th>Suite</th>
          <th>Test</th>
          <th>Status</th>
          <th>Expected</th>
          <th>File</th>
          <th>ms</th>
          <th>Details</th>
        </tr>
      </thead>
      <tbody>
        ${failures}
      </tbody>
    </table>
  </div>
</body>
</html>`;
}

function writeReports(report) {
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportsDir, "test-report.json"),
    JSON.stringify(report, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(reportsDir, "test-report.html"),
    renderHtml(report),
    "utf8"
  );
}

function printSummary(report) {
  console.log(`Generated: ${report.generatedAt}`);
  console.log(`Passed: ${report.summary.passed}/${report.summary.total}`);

  for (const [suiteName, suiteSummary] of Object.entries(report.summary.bySuite)) {
    console.log(
      ` - ${suiteName}: ${suiteSummary.passed}/${suiteSummary.total} passed`
    );
  }

  const classifications = Object.entries(report.summary.byClassification)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  if (classifications.length > 0) {
    console.log("Top failure classes:");
    classifications.forEach(([name, count]) => {
      console.log(` - ${name}: ${count}`);
    });
  }

  const failures = report.results.filter((result) => result.status === "failed");
  if (failures.length > 0) {
    console.log("");
    console.log("Sample failures:");
    failures.slice(0, 25).forEach((failure) => {
      console.log(` - ${failure.suite} :: ${failure.id} :: ${failure.error}`);
    });
    console.log(`Full details: ${path.join(reportsDir, "test-report.json")}`);
  }
}

async function main() {
  if (!fs.existsSync(test262TestRoot)) {
    throw new Error(
      "Missing submodule at external/test262. Run `git submodule update --init --recursive`."
    );
  }

  const results = [];

  if (!args.has("--no-local")) {
    results.push(...(await runLocalCompilerSuite()));
  }

  if (!args.has("--no-test262")) {
    results.push(...(await runTest262CompilerSuite()));
  }
  const report = {
    generatedAt: now(),
    summary: summarize(results),
    results
  };

  writeReports(report);
  printSummary(report);

  if (report.summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
