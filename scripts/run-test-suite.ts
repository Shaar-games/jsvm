// @ts-nocheck
const fs = require("fs");
const path = require("path");
const os = require("os");
const { fork } = require("child_process");
const { compileProgram } = require("../compiler/index");
const { executeCompiledProgram } = require("../vm/index");
const { findWorkspaceRoot } = require("./paths");
const { buildCompileSource, canExecuteInVmHost, parseTest262Metadata } = require("./test262-metadata");

const workspaceRoot = findWorkspaceRoot(__dirname);
const reportsDir = path.join(workspaceRoot, "reports");
const localTestDir = path.join(workspaceRoot, "test");
const vmFixturesDir = path.join(localTestDir, "vm-fixtures");
const test262Root = path.join(workspaceRoot, "external", "test262");
const test262TestRoot = path.join(test262Root, "test");
const vmManifest = require(path.join(workspaceRoot, "scripts", "vm-fixture-manifest.json"));
const args = new Set(process.argv.slice(2));
const filterArg = process.argv.slice(2).find((arg) => arg.startsWith("--filter="));
const limitArg = process.argv.slice(2).find((arg) => arg.startsWith("--limit="));
const skipArg = process.argv.slice(2).find((arg) => arg.startsWith("--skip="));
const workerChunkArg = process.argv.slice(2).find((arg) => arg.startsWith("--worker-chunk="));
const testFilter = filterArg ? filterArg.slice("--filter=".length).toLowerCase() : "";
const testLimit = limitArg ? Number(limitArg.slice("--limit=".length)) : null;
const testSkip = skipArg ? Number(skipArg.slice("--skip=".length)) : 0;
const failFast = args.has("--fail-fast");
const workersArg = process.argv.slice(2).find((arg) => arg.startsWith("--workers="));
const requestedWorkers = workersArg ? Number(workersArg.slice("--workers=".length)) : null;
const requestedWorkerChunk = workerChunkArg ? Number(workerChunkArg.slice("--worker-chunk=".length)) : null;
const vmHostRuntime = "node";

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
  const files = fs
    .readdirSync(localTestDir)
    .filter((file) => file.endsWith(".js"))
    .filter((file) => !file.endsWith(".expected.js"))
    .filter((file) => file !== "my-module.js")
    .filter((file) => !testFilter || file.toLowerCase().includes(testFilter))
    .sort();
  return applyTestWindow(files);
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
  let filtered = files;
  if (testFilter) {
    filtered = filtered.filter((file) => file.toLowerCase().includes(testFilter));
  }

  filtered = applyTestWindow(filtered);
  return filtered;
}

function applyTestWindow(items) {
  let selected = items;
  if (Number.isFinite(testSkip) && testSkip > 0) {
    selected = selected.slice(testSkip);
  }

  if (Number.isFinite(testLimit) && testLimit > 0) {
    selected = selected.slice(0, testLimit);
  }

  return selected;
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
        durationMs: Date.now() - startedAt,
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
          : "compile-error",
      });

      if (failFast) {
        break;
      }
    }
  }

  return results;
}

async function runVmExecutionSuite() {
  const fixtures = applyTestWindow(
    vmManifest.filter((fixture) => !testFilter || fixture.file.toLowerCase().includes(testFilter))
  );
  const results = [];

  for (const fixture of fixtures) {
    const fixturePath = path.join(vmFixturesDir, fixture.file);
    const code = fs.readFileSync(fixturePath, "utf8");
    const logs = [];
    const startedAt = Date.now();

    try {
      const compiled = await silenceCompilerLogs(() =>
        compileProgram(code, { sourceType: "module", filename: fixturePath })
      );

      await executeCompiledProgram(compiled, {
        compiler: compileProgram,
        filename: fixturePath,
        env: {
          console: {
            log: (...args) => logs.push(args.join(" ")),
          },
        },
      });

      const expected = JSON.stringify(fixture.logs);
      const actual = JSON.stringify(logs);
      if (expected !== actual) {
        results.push({
          id: fixture.file,
          suite: "local-vm",
          status: "failed",
          expected,
          file: path.relative(workspaceRoot, fixturePath),
          durationMs: Date.now() - startedAt,
          classification: "vm-output-mismatch",
          error: `Expected ${expected}, got ${actual}`,
        });

        if (failFast) {
          break;
        }

        continue;
      }

      results.push({
        id: fixture.file,
        suite: "local-vm",
        status: "passed",
        expected: JSON.stringify(fixture.logs),
        file: path.relative(workspaceRoot, fixturePath),
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      results.push({
        id: fixture.file,
        suite: "local-vm",
        status: "failed",
        expected: JSON.stringify(fixture.logs),
        file: path.relative(workspaceRoot, fixturePath),
        durationMs: Date.now() - startedAt,
        classification: "vm-runtime-error",
        error: getErrorMessage(error),
      });

      if (failFast) {
        break;
      }
    }
  }

  return results;
}

function chunkFiles(files, chunkSize) {
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
    return [files];
  }

  const chunks = [];
  for (let index = 0; index < files.length; index += chunkSize) {
    chunks.push(files.slice(index, index + chunkSize));
  }
  return chunks;
}

function shouldLogProgress(current, total, options = {}) {
  const { isFailFast = false } = options;
  if (current <= 5 || current === total) {
    return true;
  }

  if (isFailFast) {
    if (total <= 100) {
      return current % 10 === 0;
    }
    if (total <= 1000) {
      return current % 25 === 0;
    }
    return current % 50 === 0;
  }

  if (total <= 100) {
    return true;
  }
  if (total <= 1000) {
    return current % 25 === 0;
  }
  return current % 100 === 0;
}

async function runWorkerBatch(workerPath, batch, mode) {
  return new Promise((resolve, reject) => {
    const worker = fork(workerPath, [], {
      cwd: workspaceRoot,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
        JSVM_WORKER_DATA: JSON.stringify({
          files: batch,
          workspaceRoot,
          test262TestRoot,
          mode,
        }),
      },
    });

    worker.on("message", (message) => {
      if (message.type === "done") {
        worker.disconnect();
        resolve(message.results);
        return;
      }

      if (message.type === "error") {
        reject(new Error(message.error));
      }
    });

    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Worker exited with code ${code}`));
      }
    });
  });
}

function buildWorkerCrashResult(file, mode, error) {
  const relativeFile = path.relative(workspaceRoot, file);
  const testId = path.relative(test262TestRoot, file);
  const message = getErrorMessage(error);

  if (mode === "compile") {
    return {
      id: testId,
      suite: "test262-compiler",
      status: "failed",
      expected: "pass",
      file: relativeFile,
      durationMs: 0,
      classification: "worker-crash",
      error: message,
    };
  }

  return {
    id: testId,
    suite: "test262-vm",
    status: "failed",
    expected: "pass",
    file: relativeFile,
    durationMs: 0,
    classification: "worker-crash",
    error: message,
  };
}

async function runWorkerSuite(suiteName, files, mode) {
  if (files.length === 0) {
    return [];
  }

  const cpuCount = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
  const workerCount = Math.max(1, Math.min(
    requestedWorkers || Math.max(1, Math.min(cpuCount - 1, 8)),
    files.length
  ));
  const defaultChunkSize = mode === "vm" ? 50 : 250;
  const chunkSize = Math.max(1, requestedWorkerChunk || defaultChunkSize);
  const batches = chunkFiles(files, chunkSize);

  console.log(
    `Parallel ${suiteName} run: ${files.length} files across ${workerCount} workers (${batches.length} batches, chunk=${chunkSize})`
  );

  const workerPath = path.join(__dirname, "test-worker.js");

  if (failFast) {
    console.log(`Fail-fast ${suiteName} run: ${files.length} files`);
    const results = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      try {
        const batchResults = await runWorkerBatch(workerPath, [file], mode);
        results.push(...batchResults);
      } catch (error) {
        results.push(buildWorkerCrashResult(file, mode, error));
      }

      if (shouldLogProgress(index + 1, files.length, { isFailFast: true })) {
        console.log(`Progress: ${index + 1}/${files.length}`);
      }
      const lastResult = results[results.length - 1];
      if (lastResult && lastResult.status === "failed") {
        break;
      }
    }

    results.sort((left, right) => left.id.localeCompare(right.id));
    return results;
  }

  const results = [];
  let completed = 0;
  const queue = batches.slice().reverse();

  async function consumeBatches() {
    while (queue.length > 0) {
      const batch = queue.pop();
      if (!batch || batch.length === 0) {
        continue;
      }

      try {
        const batchResults = await runWorkerBatch(workerPath, batch, mode);
        results.push(...batchResults);
        completed += batch.length;
        if (shouldLogProgress(completed, files.length)) {
          console.log(`Progress: ${completed}/${files.length}`);
        }
      } catch (error) {
        if (batch.length === 1) {
          results.push(buildWorkerCrashResult(batch[0], mode, error));
          completed += 1;
          if (shouldLogProgress(completed, files.length)) {
            console.log(`Progress: ${completed}/${files.length}`);
          }
          continue;
        }

        const midpoint = Math.floor(batch.length / 2);
        queue.push(batch.slice(midpoint));
        queue.push(batch.slice(0, midpoint));
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(workerCount, batches.length) }, () => consumeBatches())
  );

  results.sort((left, right) => left.id.localeCompare(right.id));
  return results;
}

async function runTest262CompilerSuite() {
  const files = walkJsFiles(test262TestRoot);
  if (files.length === 0) {
    return [];
  }

  if (failFast) {
    const results = [];
    let index = 0;

    for (const fullPath of files) {
      index += 1;
      if (shouldLogProgress(index, files.length, { isFailFast: true })) {
        console.log(`Progress: ${index}/${files.length}`);
      }

      const relativeFile = path.relative(workspaceRoot, fullPath);
      const startedAt = Date.now();
      const code = fs.readFileSync(fullPath, "utf8");
      const metadata = parseTest262Metadata(code);
      const compileSource = buildCompileSource(code, metadata);

      try {
        await silenceCompilerLogs(() =>
          compileProgram(compileSource, { sourceType: metadata.sourceType, filename: fullPath })
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
            error: "Expected a parse failure, but compilation succeeded.",
          });
          break;
        }

        results.push({
          id: path.relative(test262TestRoot, fullPath),
          suite: "test262-compiler",
          status: "passed",
          expected: "pass",
          file: relativeFile,
          durationMs: Date.now() - startedAt,
        });
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
            note: message,
          });
          continue;
        }

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
          error: message,
        });
        break;
      }
    }

    return results;
  }

  return runWorkerSuite("test262-compiler", files, "compile");
}

async function runTest262VmSuite(filesOverride) {
  if (failFast) {
    console.log("Fail-fast test262-vm run: discovering files...");
  }
  const files = filesOverride || walkJsFiles(test262TestRoot);
  if (failFast) {
    return runFailFastTest262VmSuite(files);
  }

  const eligibleFiles = [];
  let skippedForHost = 0;

  for (const fullPath of files) {
    const code = fs.readFileSync(fullPath, "utf8");
    const metadata = parseTest262Metadata(code);
    if (!canExecuteInVmHost(code, metadata, vmHostRuntime)) {
      skippedForHost += 1;
      continue;
    }
    eligibleFiles.push(fullPath);
  }

  if (skippedForHost > 0) {
    console.log(`Filtered ${skippedForHost} test262 VM files not compatible with ${vmHostRuntime} host runtime.`);
  }
  return runWorkerSuite("test262-vm", eligibleFiles, "vm");
}

async function runFailFastTest262VmSuite(files) {
  const workerPath = path.join(__dirname, "test-worker.js");
  const results = [];
  let skippedForHost = 0;
  let scanned = 0;
  let executed = 0;

  console.log(`Fail-fast test262-vm run: scanning ${files.length} files lazily`);

  for (const fullPath of files) {
    scanned += 1;
    const id = path.relative(test262TestRoot, fullPath);
    const code = fs.readFileSync(fullPath, "utf8");
    const metadata = parseTest262Metadata(code);

    if (!canExecuteInVmHost(code, metadata, vmHostRuntime)) {
      skippedForHost += 1;
      if (shouldLogProgress(scanned, files.length, { isFailFast: true })) {
        console.log(`Scanned: ${scanned}/${files.length} | executed: ${executed} | skipped: ${skippedForHost}`);
      }
      continue;
    }

    executed += 1;
    console.log(`Running ${executed}: ${id}`);

    try {
      const batchResults = await runWorkerBatch(workerPath, [fullPath], "vm");
      results.push(...batchResults);
    } catch (error) {
      results.push(buildWorkerCrashResult(fullPath, "vm", error));
    }

    const lastResult = results[results.length - 1];
    if (lastResult && lastResult.status === "failed") {
      break;
    }

    if (shouldLogProgress(scanned, files.length, { isFailFast: true })) {
      console.log(`Scanned: ${scanned}/${files.length} | executed: ${executed} | skipped: ${skippedForHost}`);
    }
  }

  if (skippedForHost > 0) {
    console.log(`Filtered ${skippedForHost} test262 VM files not compatible with ${vmHostRuntime} host runtime.`);
  }

  return results;
}

function summarize(results) {
  const summary = {
    total: results.length,
    passed: 0,
    failed: 0,
    unsupported: 0,
    bySuite: {},
    byClassification: {},
    test262Metrics: null,
  };

  for (const result of results) {
    if (!summary.bySuite[result.suite]) {
      summary.bySuite[result.suite] = { total: 0, passed: 0, failed: 0, unsupported: 0 };
    }

    summary.bySuite[result.suite].total += 1;
    if (summary[result.status] === undefined) {
      summary[result.status] = 0;
    }
    summary[result.status] += 1;
    summary.bySuite[result.suite][result.status] += 1;

    if (result.classification) {
      summary.byClassification[result.classification] =
        (summary.byClassification[result.classification] || 0) + 1;
    }
  }

  const compileResults = results.filter((result) => result.suite === "test262-compiler");
  const vmResults = results.filter((result) => result.suite === "test262-vm");
  if (compileResults.length > 0 || vmResults.length > 0) {
    const compileById = new Map(compileResults.map((result) => [result.id, result]));
    const vmById = new Map(vmResults.map((result) => [result.id, result]));
    const compilePassedIds = new Set(
      compileResults.filter((result) => result.status === "passed").map((result) => result.id)
    );
    const vmPassedIds = new Set(
      vmResults.filter((result) => result.status === "passed").map((result) => result.id)
    );
    let vmPassedAmongCompilable = 0;
    for (const id of vmPassedIds) {
      if (compilePassedIds.has(id) || compileResults.length === 0) {
        vmPassedAmongCompilable += 1;
      }
    }

    summary.test262Metrics = {
      hasCompileRun: compileResults.length > 0,
      hasVmRun: vmResults.length > 0,
      totalTests: compileResults.length || vmResults.length,
      compilePassed: compileResults.filter((result) => result.status === "passed").length,
      compileFailed: compileResults.filter((result) => result.status === "failed").length,
      vmPassed: vmResults.filter((result) => result.status === "passed").length,
      vmFailed: vmResults.filter((result) => result.status === "failed").length,
      vmUnsupported: vmResults.filter((result) => result.status === "unsupported").length,
      vmPassVsTotal: vmResults.length > 0 && (compileResults.length || vmResults.length) > 0
        ? vmResults.filter((result) => result.status === "passed").length / (compileResults.length || vmResults.length)
        : null,
      vmPassVsCompilable: vmResults.length > 0 && compileResults.length > 0 && compilePassedIds.size > 0
        ? vmPassedAmongCompilable / compilePassedIds.size
        : null,
      compileCoverage: compileResults.length > 0
        ? compilePassedIds.size / (compileResults.length || vmResults.length)
        : null,
      compileOnlyIds: compileResults.length > 0
        ? Array.from(compilePassedIds).filter((id) => !vmById.has(id)).length
        : 0,
      vmPassedAmongCompilable,
      compileResultCount: compileResults.length,
      vmResultCount: vmResults.length,
    };
  }

  return summary;
}

function renderHtml(report) {
  const nonPassing = report.results
    .filter((result) => result.status !== "passed")
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
<td>${suiteSummary.unsupported || 0}</td>
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

  const test262Metrics = report.summary.test262Metrics
    ? `<h2>test262 VM vs Compile</h2>
    <table>
      <thead>
        <tr>
          <th>Total</th>
          <th>Compile Passed</th>
          <th>VM Passed</th>
          <th>VM Failed</th>
          <th>VM Unsupported</th>
          <th>Compile Coverage</th>
          <th>VM vs Total</th>
          <th>VM vs Compilable</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>${report.summary.test262Metrics.totalTests}</td>
          <td>${report.summary.test262Metrics.compilePassed}</td>
          <td>${report.summary.test262Metrics.hasVmRun ? report.summary.test262Metrics.vmPassed : "n/a"}</td>
          <td>${report.summary.test262Metrics.hasVmRun ? report.summary.test262Metrics.vmFailed : "n/a"}</td>
          <td>${report.summary.test262Metrics.hasVmRun ? report.summary.test262Metrics.vmUnsupported : "n/a"}</td>
          <td>${formatPercent(report.summary.test262Metrics.compileCoverage)}</td>
          <td>${formatPercent(report.summary.test262Metrics.vmPassVsTotal)}</td>
          <td>${formatPercent(report.summary.test262Metrics.vmPassVsCompilable)}</td>
        </tr>
      </tbody>
    </table>`
    : "";

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
      <div class="metric"><strong>Unsupported</strong><br>${report.summary.unsupported || 0}</div>
    </div>
    <h2>By Suite</h2>
    <table>
      <thead>
        <tr>
          <th>Suite</th>
          <th>Total</th>
          <th>Passed</th>
          <th>Failed</th>
          <th>Unsupported</th>
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
    ${test262Metrics}
    <h2>Non-passing Results</h2>
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
        ${nonPassing}
      </tbody>
    </table>
  </div>
</body>
</html>`;
}

function formatPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }

  return `${(value * 100).toFixed(2)}%`;
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
  console.log(
    `Passed: ${report.summary.passed}/${report.summary.total} | Failed: ${report.summary.failed} | Unsupported: ${report.summary.unsupported || 0}`
  );

  for (const [suiteName, suiteSummary] of Object.entries(report.summary.bySuite)) {
    console.log(
      ` - ${suiteName}: ${suiteSummary.passed}/${suiteSummary.total} passed, ${suiteSummary.failed} failed, ${suiteSummary.unsupported || 0} unsupported`
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

  if (report.summary.test262Metrics) {
    const metrics = report.summary.test262Metrics;
    console.log("test262 metrics:");
    if (metrics.hasCompileRun) {
      console.log(` - compile coverage: ${formatPercent(metrics.compileCoverage)} (${metrics.compilePassed}/${metrics.totalTests})`);
    }
    if (metrics.hasVmRun) {
      console.log(` - VM pass vs total: ${formatPercent(metrics.vmPassVsTotal)} (${metrics.vmPassed}/${metrics.totalTests})`);
      console.log(` - VM pass vs compilable: ${formatPercent(metrics.vmPassVsCompilable)} (${metrics.vmPassedAmongCompilable}/${metrics.compilePassed || 0})`);
    } else {
      console.log(" - VM metrics: not available in compile-only run");
    }
    if (metrics.hasVmRun && metrics.vmUnsupported > 0) {
      console.log(` - VM unsupported: ${metrics.vmUnsupported}`);
    }
  }

  const nonPassing = report.results.filter((result) => result.status !== "passed");
  if (nonPassing.length > 0) {
    console.log("");
    console.log("Sample non-passing results:");
    nonPassing.slice(0, 25).forEach((result) => {
      console.log(` - ${result.suite} :: ${result.id} :: ${result.error || result.note}`);
    });
    console.log(`Full details: ${path.join(reportsDir, "test-report.json")}`);
  }
}

async function main() {
  const wantsTest262Compiler = !args.has("--no-test262");
  const wantsTest262Vm = args.has("--test262-vm");

  if ((wantsTest262Compiler || wantsTest262Vm) && !fs.existsSync(test262TestRoot)) {
    throw new Error(
      "Missing submodule at external/test262. Run `git submodule update --init --recursive`."
    );
  }

  const results = [];
  let compileResults = [];

  if (!args.has("--no-local")) {
    results.push(...(await runLocalCompilerSuite()));
  }

  if (!args.has("--no-vm")) {
    results.push(...(await runVmExecutionSuite()));
  }

  if (wantsTest262Compiler) {
    compileResults = await runTest262CompilerSuite();
    results.push(...compileResults);
  }

  if (wantsTest262Vm) {
    const vmFiles = compileResults.length > 0
      ? compileResults
          .filter((result) => result.status === "passed" && result.expected === "pass")
          .map((result) => path.join(workspaceRoot, result.file))
      : null;
    results.push(...(await runTest262VmSuite(vmFiles)));
  }

  const report = {
    generatedAt: now(),
    summary: summarize(results),
    results,
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

export {};
