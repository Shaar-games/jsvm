// @ts-nocheck
const fs = require("fs");
const path = require("path");
const { parentPort, workerData } = require("worker_threads");
const { compileProgram } = require("../compiler/index");
const { executeCompiledProgram } = require("../vm/index");
const { createTest262Harness } = require("./test262-harness");
const { buildVmSource, getVmExecutionPlan, parseTest262Metadata } = require("./test262-metadata");

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

function getErrorType(error) {
  if (!error) {
    return null;
  }

  if (error.name) {
    return error.name;
  }

  if (error.constructor && error.constructor.name) {
    return error.constructor.name;
  }

  return null;
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

async function runCompileCase(fullPath, workspaceRoot, test262TestRoot) {
  const relativeFile = path.relative(workspaceRoot, fullPath);
  const startedAt = Date.now();
  const code = fs.readFileSync(fullPath, "utf8");
  const metadata = parseTest262Metadata(code);

  try {
    await silenceCompilerLogs(() =>
      compileProgram(code, { sourceType: metadata.sourceType, filename: fullPath })
    );

    if (metadata.expectCompileFailure) {
      return {
        id: path.relative(test262TestRoot, fullPath),
        suite: "test262-compiler",
        status: "failed",
        expected: "parse-fail",
        file: relativeFile,
        durationMs: Date.now() - startedAt,
        classification: "unexpected-compile-success",
        error: "Expected a parse failure, but compilation succeeded.",
      };
    }

    return {
      id: path.relative(test262TestRoot, fullPath),
      suite: "test262-compiler",
      status: "passed",
      expected: "pass",
      file: relativeFile,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const message = getErrorMessage(error);

    if (metadata.expectCompileFailure) {
      return {
        id: path.relative(test262TestRoot, fullPath),
        suite: "test262-compiler",
        status: "passed",
        expected: "parse-fail",
        file: relativeFile,
        durationMs: Date.now() - startedAt,
        note: message,
      };
    }

    return {
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
    };
  }
}

async function runVmCase(fullPath, workspaceRoot, test262TestRoot) {
  const relativeFile = path.relative(workspaceRoot, fullPath);
  const startedAt = Date.now();
  const code = fs.readFileSync(fullPath, "utf8");
  const metadata = parseTest262Metadata(code);
  const vmPlan = getVmExecutionPlan(code, metadata);
  const id = path.relative(test262TestRoot, fullPath);

  if (!vmPlan.eligible) {
    return {
      id,
      suite: "test262-vm",
      status: "unsupported",
      expected: metadata.negativeType || "pass",
      file: relativeFile,
      durationMs: Date.now() - startedAt,
      classification: vmPlan.classification,
      note: vmPlan.reason,
    };
  }

  try {
    const source = buildVmSource(code, metadata);
    const compiled = await silenceCompilerLogs(() =>
      compileProgram(source, { sourceType: metadata.sourceType, filename: fullPath })
    );

    await executeCompiledProgram(compiled, {
      compiler: compileProgram,
      filename: fullPath,
      env: createTest262Harness(),
    });

    if (metadata.negativePhase) {
      return {
        id,
        suite: "test262-vm",
        status: "failed",
        expected: metadata.negativeType || metadata.negativePhase,
        file: relativeFile,
        durationMs: Date.now() - startedAt,
        classification: "vm-unexpected-success",
        error: `Expected ${metadata.negativeType || metadata.negativePhase} to be thrown during execution.`,
      };
    }

    return {
      id,
      suite: "test262-vm",
      status: "passed",
      expected: "pass",
      file: relativeFile,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const message = getErrorMessage(error);
    const errorType = getErrorType(error);

    if (metadata.negativePhase) {
      if (!metadata.negativeType || metadata.negativeType === errorType) {
        return {
          id,
          suite: "test262-vm",
          status: "passed",
          expected: metadata.negativeType || metadata.negativePhase,
          file: relativeFile,
          durationMs: Date.now() - startedAt,
          note: message,
        };
      }

      return {
        id,
        suite: "test262-vm",
        status: "failed",
        expected: metadata.negativeType || metadata.negativePhase,
        file: relativeFile,
        durationMs: Date.now() - startedAt,
        classification: "vm-wrong-error-type",
        error: `Expected ${metadata.negativeType}, got ${errorType || "unknown"}: ${message}`,
      };
    }

    if (message.startsWith("Unsupported")) {
      return {
        id,
        suite: "test262-vm",
        status: "unsupported",
        expected: "pass",
        file: relativeFile,
        durationMs: Date.now() - startedAt,
        classification: "unsupported",
        note: message,
      };
    }

    return {
      id,
      suite: "test262-vm",
      status: "failed",
      expected: "pass",
      file: relativeFile,
      durationMs: Date.now() - startedAt,
      classification: "vm-runtime-error",
      error: message,
    };
  }
}

async function runBatch() {
  const { files, workspaceRoot, test262TestRoot, mode } = workerData;
  const results = [];

  for (const fullPath of files) {
    if (mode === "compile") {
      results.push(await runCompileCase(fullPath, workspaceRoot, test262TestRoot));
      continue;
    }

    if (mode === "vm") {
      results.push(await runVmCase(fullPath, workspaceRoot, test262TestRoot));
      continue;
    }

    throw new Error(`Unknown worker mode: ${mode}`);
  }

  parentPort.postMessage({ type: "done", results });
}

runBatch().catch((error) => {
  parentPort.postMessage({
    type: "error",
    error: error && (error.stack || error.message) ? (error.stack || error.message) : String(error),
  });
});

export {};
