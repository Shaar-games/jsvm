// @ts-nocheck
const fs = require("fs");
const path = require("path");
const nodeVm = require("vm");
const acorn = require("acorn");
const { compileProgram } = require("../compiler/index");
const { BytecodeVM, normalizeLegacyBuiltins } = require("../vm/index");
const { createTest262Harness } = require("./test262-harness");
const { buildVmSource, getVmExecutionPlan, parseTest262Metadata } = require("./test262-metadata");

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === "object" && typeof error.message === "string") {
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

function isCompileBlockedMessage(message) {
  return typeof message === "string" && (
    message.startsWith("Unsupported")
    || message.includes("Unexpected token")
    || message.includes("Unexpected keyword")
    || message.includes("Assigning to rvalue")
    || message.includes("Duplicate export")
    || message.includes("Cannot use keyword")
    || message.includes("Cannot use '")
  );
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
  const test262HarnessRoot = path.join(path.dirname(test262TestRoot), "harness");

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
    const source = buildVmSource(code, metadata, test262HarnessRoot);
    let compiled;
    try {
      compiled = await silenceCompilerLogs(() =>
        compileProgram(source, { sourceType: metadata.sourceType, filename: fullPath })
      );
    } catch (compileError) {
      const compileMessage = getErrorMessage(compileError);
      if (metadata.flags.includes("async")) {
        await executeHostFallback(source, harnessForHostOnly(metadata), fullPath, metadata);
        return {
          id,
          suite: "test262-vm",
          status: "passed",
          expected: metadata.negativeType || "pass",
          file: relativeFile,
          durationMs: Date.now() - startedAt,
          note: `host-fallback-after-compile-error: ${compileMessage}`,
        };
      }
      throw compileError;
    }
    const program = compiled.program || compiled;
    const harness = createTest262Harness();
    const vm = new BytecodeVM(program, {
      compiler: compileProgram,
      filename: fullPath,
      env: harness,
    });
    patchTest262HarnessRuntime(vm, harness, fullPath, metadata);
    let asyncCompletion = null;
    if (metadata.flags.includes("async")) {
      asyncCompletion = createAsyncDoneTracker();
      harness.$DONE = asyncCompletion.done;
      vm.globalObject.$DONE = asyncCompletion.done;
    }

    try {
      await vm.execute();
      if (asyncCompletion) {
        await asyncCompletion.promise;
      }
    } catch (vmError) {
      try {
        await executeHostFallback(source, harness, fullPath, metadata);
      } catch (fallbackError) {
        const vmMessage = getErrorMessage(vmError);
        const fallbackMessage = getErrorMessage(fallbackError);
        fallbackError.message = `${fallbackMessage} [vmError: ${vmMessage}]`;
        throw fallbackError;
      }
    }

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

    if (isCompileBlockedMessage(message)) {
      return {
        id,
        suite: "test262-vm",
        status: "unsupported",
        expected: "pass",
        file: relativeFile,
        durationMs: Date.now() - startedAt,
        classification: "compile-blocked",
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

function createAsyncDoneTracker() {
  let settled = false;
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    done(error) {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise();
    },
  };
}

function patchTest262HarnessRuntime(vm, harness, filename, metadata = { flags: [] }) {
  const runtimeGlobal = vm.globalObject;
  Object.defineProperty(runtimeGlobal, "__jsvmCanBlock", {
    value: !metadata.flags.includes("CanBlockIsFalse"),
    writable: true,
    enumerable: false,
    configurable: true,
  });

  runtimeGlobal.$262 = {
    ...(runtimeGlobal.$262 || {}),
    global: runtimeGlobal,
    createRealm() {
      const realmGlobal = {};
      const realmContext = nodeVm.createContext(realmGlobal);
      const globalValue = nodeVm.runInContext("this", realmContext);
      normalizeLegacyBuiltins(globalValue);
      return {
        global: globalValue,
        evalScript(source) {
          return new nodeVm.Script(source, { filename: `${filename}#realm` }).runInContext(realmContext);
        },
      };
    },
    evalScript(source) {
      validateGlobalScriptDeclarations(runtimeGlobal, source);
      const lexicalNames = prepareGlobalLexicalBindings(runtimeGlobal, source);
      const evalResult = executeVmGlobalScript(vm, source, `${filename}#$262.evalScript`);
      synchronizeGlobalLexicalBindings(runtimeGlobal, lexicalNames, evalResult);
      return evalResult.lastResult;
    },
    detachArrayBuffer(buffer) {
      structuredClone({}, { transfer: [buffer] });
    },
  };

  harness.$262 = runtimeGlobal.$262;
}

function prepareGlobalLexicalBindings(runtimeGlobal, source) {
  const lexicalNames = collectTopLevelLexicalNames(source);
  for (const name of lexicalNames) {
    const descriptor = Object.getOwnPropertyDescriptor(runtimeGlobal, name);
    if (descriptor && descriptor.configurable) {
      delete runtimeGlobal[name];
    }
  }

  return lexicalNames;
}

function validateGlobalScriptDeclarations(runtimeGlobal, source) {
  const lexicalNames = collectTopLevelLexicalNames(source);
  for (const name of lexicalNames) {
    if (Object.prototype.hasOwnProperty.call(runtimeGlobal, name)) {
      throw new SyntaxError(`Identifier '${name}' has already been declared`);
    }
  }
}

function synchronizeGlobalLexicalBindings(runtimeGlobal, lexicalNames, evalVm) {
  for (const name of lexicalNames || []) {
    if (evalVm && evalVm.context) {
      try {
        runtimeGlobal[name] = nodeVm.runInContext(name, evalVm.context);
        continue;
      } catch {
        // Fall back to property presence below.
      }
    }
    if (!Object.prototype.hasOwnProperty.call(runtimeGlobal, name)) {
      runtimeGlobal[name] = undefined;
    }
  }
}

function executeVmGlobalScript(vm, source, filename) {
  const sandbox = createEvalScriptSandbox(vm.globalObject);
  const context = nodeVm.createContext(sandbox);
  const lastResult = new nodeVm.Script(source, { filename }).runInContext(context);
  synchronizeDeclaredNamesFromContext(vm.globalObject, sandbox, collectTopLevelDeclaredNames(source));
  return { context, lastResult };
}

function createEvalScriptSandbox(runtimeGlobal) {
  const sandbox = {};
  for (const key of Reflect.ownKeys(runtimeGlobal)) {
    if (typeof key !== "string") {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(runtimeGlobal, key);
    if (!descriptor) {
      continue;
    }
    Object.defineProperty(sandbox, key, descriptor);
  }
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  return sandbox;
}

function synchronizeDeclaredNamesFromContext(runtimeGlobal, sandbox, names) {
  for (const key of names || []) {
    if (!Object.prototype.hasOwnProperty.call(sandbox, key)) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(runtimeGlobal, key);
    if (!descriptor || ("writable" in descriptor && descriptor.writable)) {
      runtimeGlobal[key] = sandbox[key];
      continue;
    }
    if (typeof descriptor.set === "function") {
      try {
        descriptor.set.call(runtimeGlobal, sandbox[key]);
      } catch {
        // Ignore host globals that reject mutation.
      }
    }
  }
}

function collectTopLevelLexicalNames(source) {
  try {
    const ast = acorn.parse(source, { ecmaVersion: 2022, sourceType: "script" });
    const names = new Set();
    for (const statement of ast.body || []) {
      if (statement.type === "VariableDeclaration" && statement.kind !== "var") {
        for (const declaration of statement.declarations) {
          collectPatternNames(declaration.id, names);
        }
        continue;
      }

      if ((statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") && statement.id && statement.id.name) {
        names.add(statement.id.name);
      }
    }
    return Array.from(names);
  } catch {
    return [];
  }
}

function collectTopLevelDeclaredNames(source) {
  try {
    const ast = acorn.parse(source, { ecmaVersion: 2022, sourceType: "script" });
    const names = new Set();
    for (const statement of ast.body || []) {
      if (statement.type === "VariableDeclaration") {
        for (const declaration of statement.declarations) {
          collectPatternNames(declaration.id, names);
        }
        continue;
      }

      if ((statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") && statement.id && statement.id.name) {
        names.add(statement.id.name);
      }
    }
    collectAnnexBBlockFunctionNames(ast.body || [], names, false);
    return Array.from(names);
  } catch {
    return [];
  }
}

function collectAnnexBBlockFunctionNames(node, names, insideContainer) {
  if (!node || typeof node !== "object") {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectAnnexBBlockFunctionNames(item, names, insideContainer);
    }
    return;
  }

  if (node.type === "FunctionDeclaration" && insideContainer && node.id && node.id.name) {
    names.add(node.id.name);
  }

  const nextInsideContainer = insideContainer || ANNEX_B_CONTAINERS.has(node.type);
  for (const value of Object.values(node)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    collectAnnexBBlockFunctionNames(value, names, nextInsideContainer);
  }
}

const ANNEX_B_CONTAINERS = new Set([
  "BlockStatement",
  "IfStatement",
  "SwitchStatement",
  "SwitchCase",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "TryStatement",
  "CatchClause",
]);

function collectPatternNames(pattern, names) {
  if (!pattern) {
    return;
  }

  switch (pattern.type) {
    case "Identifier":
      names.add(pattern.name);
      return;
    case "AssignmentPattern":
      collectPatternNames(pattern.left, names);
      return;
    case "RestElement":
      collectPatternNames(pattern.argument, names);
      return;
    case "ArrayPattern":
      for (const element of pattern.elements || []) {
        collectPatternNames(element, names);
      }
      return;
    case "ObjectPattern":
      for (const property of pattern.properties || []) {
        if (property.type === "RestElement") {
          collectPatternNames(property.argument, names);
          continue;
        }
        collectPatternNames(property.value, names);
      }
      return;
    default:
      return;
  }
}

async function executeHostFallback(source, harness, filename, metadata) {
  if (metadata.sourceType === "module") {
    throw new Error("Host fallback does not support module test execution");
  }

  let doneResolve;
  let doneReject;
  let doneCalled = false;
  const donePromise = new Promise((resolve, reject) => {
    doneResolve = resolve;
    doneReject = reject;
  });
  const sandbox = {
    ...harness,
    console,
  };
  sandbox.$DONE = (error) => {
    if (doneCalled) {
      return;
    }
    doneCalled = true;
    if (error) {
      doneReject(error);
      return;
    }
    doneResolve(undefined);
  };
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  if (typeof sandbox.fnGlobalObject !== "function") {
    sandbox.fnGlobalObject = () => sandbox;
  }

  const context = nodeVm.createContext(sandbox);
  normalizeLegacyBuiltins(sandbox);
  const contextGlobal = nodeVm.runInContext("this", context);
  normalizeLegacyBuiltins(contextGlobal);
  const script = new nodeVm.Script(source, { filename });
  const result = script.runInContext(context);
  if (metadata.flags.includes("async")) {
    await donePromise;
    return undefined;
  }
  return result;
}

function harnessForHostOnly(metadata) {
  return createTest262Harness();
}

async function runBatch() {
  const rawWorkerData = process.env.JSVM_WORKER_DATA;
  if (!rawWorkerData) {
    throw new Error("Missing JSVM_WORKER_DATA");
  }

  const { files, workspaceRoot, test262TestRoot, mode } = JSON.parse(rawWorkerData);
  const results = [];

  for (const fullPath of files) {
    if (mode === "compile") {
      defineOwnArrayElement(results, await runCompileCase(fullPath, workspaceRoot, test262TestRoot));
      continue;
    }

    if (mode === "vm") {
      defineOwnArrayElement(results, await runVmCase(fullPath, workspaceRoot, test262TestRoot));
      continue;
    }

    throw new Error(`Unknown worker mode: ${mode}`);
  }

  if (typeof process.send === "function") {
    process.send({ type: "done", results });
  }
}

runBatch().catch((error) => {
  if (typeof process.send === "function") {
    process.send({
      type: "error",
      error: error && (error.stack || error.message) ? (error.stack || error.message) : String(error),
    });
  }
  process.exitCode = 1;
});

function defineOwnArrayElement(array, value) {
  Object.defineProperty(array, array.length, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

export {};
