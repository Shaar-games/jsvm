// @ts-nocheck
const acorn = require("acorn");
const path = require("path");
const fs = require("fs");
const { createEnvironment, getBinding, initBinding, storeBinding, TDZ } = require("./environment");
const { createRegisters, getRegister, setRegister } = require("./registers");
const { executeInstruction, executeInstructionSync } = require("./handlers");
const { buildFunctionTable, parseBytecode } = require("./parser");

class BytecodeVM {
  constructor(program, options = {}) {
    this.program = program;
    this.compiler = options.compiler || null;
    this.filename = options.filename || program.filename || null;
    this.moduleCache = options.moduleCache || new Map();
    this.moduleOverrides = options.modules || {};
    this.require = typeof options.require === "function" ? options.require : require;
    this.hostEval = typeof options.hostEval === "function" ? options.hostEval : globalThis.eval;
    this.preferNativeEval = options.preferNativeEval !== false;
    this.allowVmEvalFallback = options.allowVmEvalFallback !== false;
    this.functionTable = buildFunctionTable(program.functions || []);
    this.staticValues = (program.staticSection && program.staticSection.values) || [];
    this.globalObject = options.runtimeGlobal || buildRuntimeEnv(options.env || options.globals || {});
    this.env = this.globalObject;
    if (!this.globalObject.eval || !this.globalObject.eval.__jsvmDirectEval) {
      const directEval = function jsvmEval() {
        throw new Error("Direct eval interception should be handled by the VM call dispatcher");
      };
      directEval.__jsvmDirectEval = true;
      Object.defineProperty(this.globalObject, "eval", {
        value: directEval,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
    if (!this.globalObject.require || !this.globalObject.require.__jsvmRequire) {
      const directRequire = function jsvmRequire() {
        throw new Error("Require interception should be handled by the VM call dispatcher");
      };
      directRequire.__jsvmRequire = true;
      Object.defineProperty(this.globalObject, "require", {
        value: directRequire,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
  }

  async execute() {
    const state = {
      envStack: [createEnvironment()],
      bindingNameStack: [this.program.scopeBindings || {}],
      registers: createRegisters(),
      thisValue: this.getTopLevelThisValue(),
      tryStack: [],
      exports: {},
      pendingError: undefined,
    };
    const result = await this.executeChunk(this.program.entry, null, [], state);
    this.lastState = state;
    this.lastExports = state.exports;
    return result;
  }

  executeSync() {
    const state = {
      envStack: [createEnvironment()],
      bindingNameStack: [this.program.scopeBindings || {}],
      registers: createRegisters(),
      thisValue: this.getTopLevelThisValue(),
      tryStack: [],
      exports: {},
      pendingError: undefined,
    };
    const result = this.executeChunkSync(this.program.entry, null, [], state);
    this.lastState = state;
    this.lastExports = state.exports;
    return result;
  }

  async executeChunk(bytecode, functionMeta, args = [], runtimeState) {
    const { instructions, labels } = parseBytecode(bytecode);
    const execState = runtimeState || {
      envStack: [createEnvironment()],
      bindingNameStack: [this.program.scopeBindings || {}],
      registers: createRegisters(),
      thisValue: undefined,
      tryStack: [],
      exports: {},
      pendingError: undefined,
    };

    if (functionMeta && Array.isArray(functionMeta.paramBindings)) {
      functionMeta.paramBindings.forEach((bindingRef, index) => {
        initBinding(execState.envStack, bindingRef.depth, bindingRef.slot, args[index]);
      });
    }
    if (functionMeta && functionMeta.argumentsBinding) {
      initBinding(
        execState.envStack,
        functionMeta.argumentsBinding.depth,
        functionMeta.argumentsBinding.slot,
        createArgumentsObject(args)
      );
    }
    if (functionMeta && functionMeta.restBinding) {
      initBinding(
        execState.envStack,
        functionMeta.restBinding.depth,
        functionMeta.restBinding.slot,
        args.slice(functionMeta.restBinding.index)
      );
    }

    const state = {
      envStack: execState.envStack,
      bindingNameStack: execState.bindingNameStack,
      registers: execState.registers,
      labels,
      thisValue: execState.thisValue,
      tryStack: execState.tryStack,
      exports: execState.exports,
      get pendingError() {
        return execState.pendingError;
      },
      set pendingError(value) {
        execState.pendingError = value;
      },
      resolveValue: (token) => this.resolveValue(execState.registers, token),
      setRegister: (registerName, value) => setRegister(execState.registers, registerName, value),
      getBinding: (depth, slot) => this.getBindingValue(execState.envStack, depth, slot),
      initBinding: (depth, slot, value) => initBinding(execState.envStack, depth, slot, value),
      storeBinding: (depth, slot, value) => storeBinding(execState.envStack, depth, slot, value),
      jump: (label) => this.jump(labels, label),
      pushEnv: () => {
        execState.envStack.unshift(createEnvironment());
        execState.bindingNameStack.unshift({});
      },
      popEnv: () => {
        execState.envStack.shift();
        execState.bindingNameStack.shift();
      },
    };
    let ip = 0;

    while (ip < instructions.length) {
      const instruction = instructions[ip];
      try {
        const effect = await executeInstruction(this, state, instruction);
        if (effect && effect.type === "return") {
          return effect.value;
        }
        if (effect && effect.type === "jump") {
          ip = effect.ip;
          continue;
        }
      } catch (error) {
        const handler = state.tryStack.pop();
        if (!handler) {
          throw error;
        }
        state.pendingError = error;
        while (state.envStack.length > handler.envDepth) {
          state.envStack.shift();
        }
        ip = this.jump(labels, handler.catchLabel);
        continue;
      }

      ip += 1;
    }

    return undefined;
  }

  executeChunkSync(bytecode, functionMeta, args = [], runtimeState) {
    const { instructions, labels } = parseBytecode(bytecode);
    const execState = runtimeState || {
      envStack: [createEnvironment()],
      bindingNameStack: [this.program.scopeBindings || {}],
      registers: createRegisters(),
      thisValue: undefined,
      tryStack: [],
      exports: {},
      pendingError: undefined,
    };

    if (functionMeta && functionMeta.isAsync) {
      throw new Error("Async function cannot run in sync VM path");
    }

    if (functionMeta && Array.isArray(functionMeta.paramBindings)) {
      functionMeta.paramBindings.forEach((bindingRef, index) => {
        initBinding(execState.envStack, bindingRef.depth, bindingRef.slot, args[index]);
      });
    }
    if (functionMeta && functionMeta.argumentsBinding) {
      initBinding(
        execState.envStack,
        functionMeta.argumentsBinding.depth,
        functionMeta.argumentsBinding.slot,
        createArgumentsObject(args)
      );
    }
    if (functionMeta && functionMeta.restBinding) {
      initBinding(
        execState.envStack,
        functionMeta.restBinding.depth,
        functionMeta.restBinding.slot,
        args.slice(functionMeta.restBinding.index)
      );
    }

    const state = {
      envStack: execState.envStack,
      bindingNameStack: execState.bindingNameStack,
      registers: execState.registers,
      labels,
      thisValue: execState.thisValue,
      tryStack: execState.tryStack,
      exports: execState.exports,
      get pendingError() {
        return execState.pendingError;
      },
      set pendingError(value) {
        execState.pendingError = value;
      },
      resolveValue: (token) => this.resolveValue(execState.registers, token),
      setRegister: (registerName, value) => setRegister(execState.registers, registerName, value),
      getBinding: (depth, slot) => this.getBindingValue(execState.envStack, depth, slot),
      initBinding: (depth, slot, value) => initBinding(execState.envStack, depth, slot, value),
      storeBinding: (depth, slot, value) => storeBinding(execState.envStack, depth, slot, value),
      jump: (label) => this.jump(labels, label),
      pushEnv: () => {
        execState.envStack.unshift(createEnvironment());
        execState.bindingNameStack.unshift({});
      },
      popEnv: () => {
        execState.envStack.shift();
        execState.bindingNameStack.shift();
      },
    };
    let ip = 0;

    while (ip < instructions.length) {
      const instruction = instructions[ip];
      try {
        const effect = executeInstructionSync(this, state, instruction);
        if (effect && effect.type === "return") {
          return effect.value;
        }
        if (effect && effect.type === "jump") {
          ip = effect.ip;
          continue;
        }
      } catch (error) {
        const handler = state.tryStack.pop();
        if (!handler) {
          throw error;
        }
        state.pendingError = error;
        while (state.envStack.length > handler.envDepth) {
          state.envStack.shift();
        }
        ip = this.jump(labels, handler.catchLabel);
        continue;
      }

      ip += 1;
    }

    return undefined;
  }

  resolveValue(registers, token) {
    if (typeof token === "string" && /^R\d+$/.test(token)) {
      return getRegister(registers, token);
    }
    return token;
  }

  getBindingValue(envStack, depth, slot) {
    const value = getBinding(envStack, depth, slot);
    if (value === TDZ) {
      throw new ReferenceError(`Binding at depth ${depth}, slot ${slot} is in TDZ`);
    }
    return value;
  }

  jump(labels, label) {
    if (!labels.has(label)) {
      throw new Error(`Unknown label: ${label}`);
    }
    return labels.get(label);
  }

  getTopLevelThisValue() {
    return this.program && this.program.sourceType === "module" ? undefined : this.globalObject;
  }

  async importModule(specifier) {
    return this.loadModule(specifier, {
      mode: "import",
      parentFilename: this.filename,
    });
  }

  async evaluateSource(source, state, options = {}) {
    if (typeof source !== "string") {
      return this.globalObject.eval(source);
    }

    if (!options.indirect && this.preferNativeEval && typeof this.hostEval === "function") {
      try {
        return this.executeNativeDirectEval(source, state);
      } catch (error) {
        if (!this.allowVmEvalFallback) {
          throw error;
        }
      }
    }

    if (this.preferNativeEval && typeof this.hostEval === "function") {
      try {
        return this.hostEval(source);
      } catch (error) {
        if (!this.allowVmEvalFallback) {
          throw error;
        }
      }
    }

    if (!this.compiler) {
      return globalThis.eval(source);
    }

    if (!options.indirect) {
      for (const name of collectSloppyBlockFunctionNames(source)) {
        if (!(name in this.globalObject)) {
          this.globalObject[name] = undefined;
        }
      }
    }

    const compiled = await this.compiler(source, {
      sourceType: "script",
      scriptMode: options.indirect ? "global" : "eval",
      filename: `${this.filename || "<eval>"}#eval`,
      predeclaredScopeStack: !options.indirect && state.bindingNameStack
        ? state.bindingNameStack
        : null,
    });
    const program = compiled.program || compiled;
    const evalVm = new BytecodeVM(program, {
      compiler: this.compiler,
      filename: `${this.filename || "<eval>"}#eval`,
      runtimeGlobal: this.globalObject,
      modules: this.moduleOverrides,
      require: this.require,
      hostEval: this.hostEval,
      preferNativeEval: this.preferNativeEval,
      allowVmEvalFallback: this.allowVmEvalFallback,
      moduleCache: this.moduleCache,
    });
    const nextState = {
      envStack: options.indirect ? [createEnvironment()] : state.envStack,
      bindingNameStack: options.indirect ? [program.scopeBindings || {}] : state.bindingNameStack,
      registers: createRegisters(),
      thisValue: options.indirect ? this.globalObject : state.thisValue,
      tryStack: [],
      exports: state.exports,
      pendingError: undefined,
    };
    return evalVm.executeChunk(program.entry, null, [], nextState);
  }

  resolveImportPath(specifier) {
    if (!this.filename) {
      return null;
    }

    if (!specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.match(/^[A-Za-z]:[\\/]/)) {
      return null;
    }

    return path.resolve(path.dirname(this.filename), specifier);
  }

  resolveExternalModule(specifier) {
    if (specifier in this.globalObject) {
      return normalizeModuleNamespace(this.globalObject[specifier], specifier);
    }

    try {
      const required = this.require(specifier);
      return normalizeModuleNamespace(required, specifier);
    } catch (error) {
      const fallback = { default: this.globalObject[specifier], __module: specifier };
      if (fallback.default !== undefined) {
        return fallback;
      }
      throw error;
    }
  }

  async requireModule(specifier, parentFilename = this.filename, state = null) {
    return this.loadModule(specifier, {
      mode: "require",
      parentFilename,
      state,
    });
  }

  async loadModule(specifier, options = {}) {
    const mode = options.mode || "import";
    const parentFilename = options.parentFilename || this.filename;
    const cacheKey = `${mode}:${parentFilename || "<root>"}:${specifier}`;
    if (this.moduleCache.has(cacheKey)) {
      return this.moduleCache.get(cacheKey);
    }

    if (Object.prototype.hasOwnProperty.call(this.moduleOverrides, specifier)) {
      const overrideValue = this.moduleOverrides[specifier];
      const normalized = mode === "import"
        ? normalizeModuleNamespace(overrideValue, specifier)
        : overrideValue;
      this.moduleCache.set(cacheKey, normalized);
      return normalized;
    }

    const resolvedPath = this.resolveModulePath(specifier, parentFilename);
    if (!resolvedPath) {
      const fallback = this.resolveExternalModule(specifier);
      const normalized = mode === "import" ? fallback : ("default" in fallback ? fallback.default : fallback);
      this.moduleCache.set(cacheKey, normalized);
      return normalized;
    }

    if (resolvedPath.endsWith(".json")) {
      const jsonValue = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
      const normalized = mode === "import"
        ? normalizeModuleNamespace(jsonValue, resolvedPath)
        : jsonValue;
      this.moduleCache.set(cacheKey, normalized);
      return normalized;
    }

    const source = fs.readFileSync(resolvedPath, "utf8");
    const sourceType = mode === "import" || looksLikeESModule(source, resolvedPath) ? "module" : "script";
    const compiled = await this.compiler(source, {
      sourceType,
      scriptMode: sourceType === "module" ? "module" : (mode === "require" ? "commonjs" : "global"),
      filename: resolvedPath,
    });
    const childProgram = compiled.program || compiled;
    const childVm = new BytecodeVM(childProgram, {
      compiler: this.compiler,
      filename: resolvedPath,
      runtimeGlobal: this.globalObject,
      modules: this.moduleOverrides,
      require: this.require,
      hostEval: this.hostEval,
      preferNativeEval: this.preferNativeEval,
      allowVmEvalFallback: this.allowVmEvalFallback,
      moduleCache: this.moduleCache,
    });

    let result;
    if (sourceType === "module") {
      await childVm.execute();
      result = childVm.lastExports || {};
      result = mode === "import" ? normalizeModuleNamespace(result, resolvedPath) : result;
    } else {
      if (mode === "require" && options.state && !looksLikeCommonJs(source)) {
        result = await childVm.executeScriptInCallerScope(options.state);
      } else {
        const module = { exports: {} };
        result = await childVm.executeCommonJsModule(module);
      }
      result = mode === "import" ? normalizeModuleNamespace(result, resolvedPath) : result;
    }

    this.moduleCache.set(cacheKey, result);
    return result;
  }

  async executeCommonJsModule(module) {
    const previous = captureGlobalSlots(this.globalObject, [
      "module",
      "exports",
      "__filename",
      "__dirname",
    ]);
    this.globalObject.module = module;
    this.globalObject.exports = module.exports;
    this.globalObject.__filename = this.filename;
    this.globalObject.__dirname = this.filename ? path.dirname(this.filename) : undefined;

    try {
      await this.execute();
      return module.exports;
    } finally {
      restoreGlobalSlots(this.globalObject, previous);
    }
  }

  async executeScriptInCallerScope(state) {
    const nextState = {
      envStack: state.envStack,
      bindingNameStack: state.bindingNameStack,
      registers: createRegisters(),
      thisValue: state.thisValue,
      tryStack: [],
      exports: state.exports,
      pendingError: undefined,
    };
    return this.executeChunk(this.program.entry, null, [], nextState);
  }

  resolveModulePath(specifier, parentFilename = this.filename) {
    if (!specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.match(/^[A-Za-z]:[\\/]/)) {
      return null;
    }

    const basePath = parentFilename ? path.dirname(parentFilename) : process.cwd();
    const absolutePath = path.resolve(basePath, specifier);
    const candidates = [
      absolutePath,
      `${absolutePath}.js`,
      `${absolutePath}.mjs`,
      `${absolutePath}.cjs`,
      `${absolutePath}.json`,
      path.join(absolutePath, "index.js"),
      path.join(absolutePath, "index.mjs"),
      path.join(absolutePath, "index.cjs"),
      path.join(absolutePath, "index.json"),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }

    return null;
  }

  executeNativeDirectEval(source, state) {
    const visibleBindings = this.collectVisibleBindings(state, source);
    const bindingNames = Object.keys(visibleBindings);
    const bindings = {};
    for (const name of bindingNames) {
      bindings[name] = visibleBindings[name].value;
    }

    const runner = createDirectEvalRunner(bindingNames);
    const result = runner(bindings, this.globalObject, source, this.hostEval);

    for (const name of bindingNames) {
      if (!Object.prototype.hasOwnProperty.call(result.bindings, name)) {
        continue;
      }
      const target = visibleBindings[name];
      if (target.existed) {
        storeBinding(state.envStack, target.depth, target.slot, result.bindings[name]);
        continue;
      }
      this.createEvalBinding(state, target.name, result.bindings[name]);
    }

    return result.value;
  }

  collectVisibleBindings(state, source) {
    const visible = {};
    const declaredNames = collectEvalDeclaredNames(source);

    if (state.bindingNameStack) {
      for (let depth = 0; depth < state.bindingNameStack.length; depth += 1) {
        const scopeBindings = state.bindingNameStack[depth] || {};
        for (const [name, binding] of Object.entries(scopeBindings)) {
          if (binding.internal || name in visible) {
            continue;
          }
          let value;
          try {
            value = this.getBindingValue(state.envStack, depth, binding.slot);
          } catch {
            value = undefined;
          }
          visible[name] = {
            name,
            depth,
            slot: binding.slot,
            existed: true,
            value,
          };
        }
      }
    }

    for (const name of declaredNames) {
      if (name in visible) {
        continue;
      }
      visible[name] = {
        name,
        existed: false,
        value: undefined,
      };
    }

    return visible;
  }

  createEvalBinding(state, name, value) {
    const targetDepth = findVariableEnvironmentDepth(state.bindingNameStack || []);
    const env = state.envStack[targetDepth];
    const bindingMap = state.bindingNameStack[targetDepth];
    const nextSlot = Object.values(bindingMap).reduce(
      (max, binding) => Math.max(max, binding.slot + 1),
      env.length
    );
    env[nextSlot] = value;
    bindingMap[name] = {
      slot: nextSlot,
      kind: "eval-var",
      declarationKind: "var",
    };
  }
}

function collectSloppyBlockFunctionNames(source) {
  try {
    const ast = acorn.parse(source, { ecmaVersion: 2022, sourceType: "script" });
    const names = new Set();
    walkForBlockFunctions(ast, false, names);
    return names;
  } catch {
    return [];
  }
}

function walkForBlockFunctions(node, insideBlock, names) {
  if (!node || typeof node !== "object") {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      walkForBlockFunctions(item, insideBlock, names);
    }
    return;
  }

  if (node.type === "FunctionDeclaration" && insideBlock && node.id && node.id.name) {
    names.add(node.id.name);
  }

  const nextInsideBlock = insideBlock || ANNEX_B_FUNCTION_CONTAINERS.has(node.type);
  for (const value of Object.values(node)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    walkForBlockFunctions(value, nextInsideBlock, names);
  }
}

const ANNEX_B_FUNCTION_CONTAINERS = new Set([
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

function buildRuntimeEnv(extraEnv = {}) {
  const runtimeGlobal = {};
  cloneOwnProperties(runtimeGlobal, globalThis);
  cloneOwnProperties(runtimeGlobal, extraEnv);
  Object.defineProperty(runtimeGlobal, "global", {
    value: runtimeGlobal,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(runtimeGlobal, "globalThis", {
    value: runtimeGlobal,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(runtimeGlobal, "self", {
    value: runtimeGlobal,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  if (typeof runtimeGlobal.fnGlobalObject !== "function") {
    Object.defineProperty(runtimeGlobal, "fnGlobalObject", {
      value() {
        return runtimeGlobal;
      },
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
  normalizeLegacyBuiltins(runtimeGlobal);
  return runtimeGlobal;
}

function createDirectEvalRunner(bindingNames) {
  const declarations = bindingNames
    .map((name) => `var ${name} = bindings[${JSON.stringify(name)}];`)
    .join("\n");
  const assignments = bindingNames
    .map((name) => `${JSON.stringify(name)}: ${name}`)
    .join(",\n");

  return new Function(
    "bindings",
    "globals",
    "source",
    "hostEval",
    `
with (globals) {
${declarations}
const __value = hostEval(source);
return {
  value: __value,
  bindings: {
${assignments}
  }
};
}
`
  );
}

function findVariableEnvironmentDepth(bindingNameStack) {
  for (let depth = 0; depth < bindingNameStack.length; depth += 1) {
    const bindings = bindingNameStack[depth] || {};
    if (Object.prototype.hasOwnProperty.call(bindings, "arguments")) {
      return depth;
    }
  }

  return bindingNameStack.length > 0 ? bindingNameStack.length - 1 : 0;
}

function collectEvalDeclaredNames(source) {
  try {
    const ast = acorn.parse(source, { ecmaVersion: 2022, sourceType: "script" });
    const names = new Set();
    walkEvalDeclarations(ast.body || [], names);
    return names;
  } catch {
    return [];
  }
}

function walkEvalDeclarations(nodes, names) {
  for (const node of nodes) {
    if (!node || typeof node !== "object") {
      continue;
    }

    switch (node.type) {
      case "VariableDeclaration":
        if (node.kind === "var") {
          for (const declaration of node.declarations) {
            collectBoundNames(declaration.id, names);
          }
        }
        break;
      case "FunctionDeclaration":
        if (node.id && node.id.name) {
          names.add(node.id.name);
        }
        break;
      case "BlockStatement":
        walkEvalDeclarations(node.body || [], names);
        break;
      case "IfStatement":
        walkEvalDeclarations([node.consequent], names);
        if (node.alternate) {
          walkEvalDeclarations([node.alternate], names);
        }
        break;
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement":
      case "WhileStatement":
      case "DoWhileStatement":
      case "LabeledStatement":
      case "WithStatement":
        if (node.body) {
          walkEvalDeclarations([node.body], names);
        }
        break;
      case "SwitchStatement":
        for (const switchCase of node.cases || []) {
          walkEvalDeclarations(switchCase.consequent || [], names);
        }
        break;
      case "TryStatement":
        if (node.block) {
          walkEvalDeclarations(node.block.body || [], names);
        }
        if (node.handler && node.handler.body) {
          walkEvalDeclarations(node.handler.body.body || [], names);
        }
        if (node.finalizer) {
          walkEvalDeclarations(node.finalizer.body || [], names);
        }
        break;
      default:
        break;
    }
  }
}

function collectBoundNames(patternNode, names) {
  if (!patternNode) {
    return;
  }

  switch (patternNode.type) {
    case "Identifier":
      names.add(patternNode.name);
      break;
    case "RestElement":
      collectBoundNames(patternNode.argument, names);
      break;
    case "AssignmentPattern":
      collectBoundNames(patternNode.left, names);
      break;
    case "ArrayPattern":
      for (const element of patternNode.elements || []) {
        collectBoundNames(element, names);
      }
      break;
    case "ObjectPattern":
      for (const property of patternNode.properties || []) {
        if (property.type === "RestElement") {
          collectBoundNames(property.argument, names);
          continue;
        }
        collectBoundNames(property.value, names);
      }
      break;
    default:
      break;
  }
}

function cloneOwnProperties(target, source) {
  if (!source || (typeof source !== "object" && typeof source !== "function")) {
    return;
  }

  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== "string") {
      continue;
    }

    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) {
      continue;
    }

    if ("value" in descriptor) {
      Object.defineProperty(target, key, descriptor);
      continue;
    }

    let resolvedValue;
    try {
      resolvedValue = typeof descriptor.get === "function"
        ? descriptor.get.call(source)
        : undefined;
    } catch {
      continue;
    }

    Object.defineProperty(target, key, {
      value: resolvedValue,
      writable: typeof descriptor.set === "function",
      enumerable: descriptor.enumerable,
      configurable: descriptor.configurable,
    });
  }
}

function normalizeLegacyBuiltins(runtimeGlobal) {
  normalizeLegacyEscape(runtimeGlobal);
  normalizeArrayBuiltins(runtimeGlobal);
  normalizeLegacyStringHtmlMethods(runtimeGlobal);
  normalizeLegacyRegExpAccessors(runtimeGlobal);
  normalizeLegacyRegExpCompile(runtimeGlobal);
  normalizeArrayBufferExtensions(runtimeGlobal);
  normalizeTemporalBuiltins(runtimeGlobal);
  normalizeIteratorBuiltins(runtimeGlobal);
}

function createArgumentsObject(args) {
  return function makeArgumentsObject() {
    return arguments;
  }(...args);
}

function normalizeLegacyEscape(runtimeGlobal) {
  if (typeof globalThis.escape === "function") {
    const escape = (value) => globalThis.escape(toStringValue(value));
    Object.defineProperty(runtimeGlobal, "escape", {
      value: escape,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  if (typeof globalThis.unescape === "function") {
    const unescape = (value) => globalThis.unescape(toStringValue(value));
    Object.defineProperty(runtimeGlobal, "unescape", {
      value: unescape,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}

function normalizeArrayBuiltins(runtimeGlobal) {
  const ArrayCtor = runtimeGlobal.Array;
  if (typeof ArrayCtor !== "function" || !ArrayCtor.prototype) {
    return;
  }

  const fromAsync = createRealmArrayFromAsync(runtimeGlobal);
  defineBuiltinFunctionMetadata(fromAsync, "fromAsync", 1);
  Object.defineProperty(ArrayCtor, "fromAsync", {
    value: fromAsync,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  const nativeConcat = typeof ArrayCtor.prototype.concat === "function"
    ? ArrayCtor.prototype.concat
    : null;
  if (!nativeConcat) {
    return;
  }

  const concat = createNonConstructorMethod(function concat(...items) {
    if (!shouldUseManualConcat(this, items)) {
      return nativeConcat.apply(this, items);
    }
    return performManualConcat(this, items);
  }, 1);
  defineBuiltinFunctionMetadata(concat, "concat", 1);

  Object.defineProperty(ArrayCtor.prototype, "concat", {
    value: concat,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

function shouldUseManualConcat(receiver, items) {
  if (!Array.isArray(receiver)) {
    return false;
  }

  return items.some((item) => isConcatSpreadable(item));
}

function performManualConcat(receiver, items) {
  const result = [];
  let nextIndex = 0;

  for (const item of [receiver, ...items]) {
    if (!isConcatSpreadable(item)) {
      defineOwnArrayElement(result, nextIndex, item);
      nextIndex += 1;
      continue;
    }

    const length = toLengthValue(item.length);
    if (nextIndex + length > Number.MAX_SAFE_INTEGER) {
      throw new TypeError("Invalid array length");
    }

    for (let index = 0; index < length; index += 1) {
      if (index in item) {
        defineOwnArrayElement(result, nextIndex, item[index]);
      }
      nextIndex += 1;
    }
  }

  result.length = nextIndex;
  return result;
}

function isConcatSpreadable(value) {
  if (value === null || value === undefined || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }

  const spreadable = value[Symbol.isConcatSpreadable];
  if (spreadable !== undefined) {
    return Boolean(spreadable);
  }

  return Array.isArray(value);
}

function toLengthValue(value) {
  if (typeof value === "bigint" || typeof value === "symbol") {
    throw new TypeError("Cannot convert value to length");
  }
  const length = Number(value);
  if (!Number.isFinite(length) || length <= 0) {
    return length === Infinity ? Number.MAX_SAFE_INTEGER : 0;
  }
  return Math.min(Math.floor(length), Number.MAX_SAFE_INTEGER);
}

function defineOwnArrayElement(array, index, value) {
  Object.defineProperty(array, index, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function normalizeLegacyRegExpAccessors(runtimeGlobal) {
  const RegExpCtor = runtimeGlobal.RegExp;
  if (typeof RegExpCtor !== "function") {
    return;
  }

  const accessorSpecs = [
    { names: ["$1", "$2", "$3", "$4", "$5", "$6", "$7", "$8", "$9"], hasSetter: false },
    { names: ["input", "$_"], hasSetter: true },
    { names: ["lastMatch", "$&"], hasSetter: false },
    { names: ["lastParen", "$+"], hasSetter: false },
    { names: ["leftContext", "$`"], hasSetter: false },
    { names: ["rightContext", "$'"], hasSetter: false },
  ];

  for (const spec of accessorSpecs) {
    const canonicalName = spec.names[0];
    const descriptor = Object.getOwnPropertyDescriptor(RegExpCtor, canonicalName);
    if (!descriptor || typeof descriptor.get !== "function") {
      continue;
    }

    const getter = descriptor.get;
    const setter = typeof descriptor.set === "function" ? descriptor.set : undefined;

    for (const name of spec.names) {
      Object.defineProperty(RegExpCtor, name, {
        configurable: true,
        enumerable: false,
        get() {
          if (this !== RegExpCtor) {
            throw new TypeError(`RegExp.${name} getter receiver mismatch`);
          }
          return getter.call(RegExpCtor);
        },
        set: spec.hasSetter
          ? function setLegacyRegExpAccessor(value) {
              if (this !== RegExpCtor) {
                throw new TypeError(`RegExp.${name} setter receiver mismatch`);
              }
              if (setter) {
                return setter.call(RegExpCtor, value);
              }
              return undefined;
            }
          : undefined,
      });
    }
  }
}

function normalizeLegacyStringHtmlMethods(runtimeGlobal) {
  const StringCtor = runtimeGlobal.String;
  if (typeof StringCtor !== "function" || !StringCtor.prototype) {
    return;
  }

  const createHTML = (receiver, tag, attribute, value) => {
    if (receiver === null || receiver === undefined) {
      throw new TypeError("String.prototype HTML wrapper methods require an object-coercible receiver");
    }
    const string = toStringValue(receiver);
    if (!attribute) {
      return `<${tag}>${string}</${tag}>`;
    }
    const attributeValue = toStringValue(value).replaceAll('"', "&quot;");
    return `<${tag} ${attribute}="${attributeValue}">${string}</${tag}>`;
  };

  const methods = {
    anchor(name) {
      return createHTML(this, "a", "name", name);
    },
    fontcolor(color) {
      return createHTML(this, "font", "color", color);
    },
    fontsize(size) {
      return createHTML(this, "font", "size", size);
    },
    link(url) {
      return createHTML(this, "a", "href", url);
    },
  };

  for (const [name, impl] of Object.entries(methods)) {
    Object.defineProperty(StringCtor.prototype, name, {
      value: impl,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}

function normalizeLegacyRegExpCompile(runtimeGlobal) {
  const RegExpCtor = runtimeGlobal.RegExp;
  if (typeof RegExpCtor !== "function" || !RegExpCtor.prototype) {
    return;
  }
  const TypeErrorCtor = runtimeGlobal.TypeError || TypeError;

  const nativeCompile = typeof RegExpCtor.prototype.compile === "function"
    ? RegExpCtor.prototype.compile
    : null;

  Object.defineProperty(RegExpCtor.prototype, "compile", {
    value: function compile(pattern, flags) {
      if (this === null || this === undefined || typeof this !== "object") {
        throw new TypeErrorCtor("RegExp.prototype.compile requires an object receiver");
      }

      if (Object.prototype.toString.call(this) !== "[object RegExp]") {
        throw new TypeErrorCtor("RegExp.prototype.compile requires a RegExp receiver");
      }

      const receiverPrototype = Object.getPrototypeOf(this);
      const receiverConstructor = receiverPrototype && receiverPrototype.constructor;
      if (!prototypeChainIncludes(this, RegExpCtor.prototype) || receiverConstructor !== RegExpCtor) {
        throw new TypeErrorCtor("RegExp.prototype.compile cross-realm receiver mismatch");
      }

      if (nativeCompile) {
        return nativeCompile.call(this, pattern, flags);
      }

      const next = new RegExp(pattern, flags);
      Object.defineProperty(this, "lastIndex", {
        value: 0,
        writable: true,
        enumerable: false,
        configurable: false,
      });
      return next;
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

const immutableArrayBuffers = new WeakSet();

function normalizeArrayBufferExtensions(runtimeGlobal) {
  const ArrayBufferCtor = runtimeGlobal.ArrayBuffer;
  if (typeof ArrayBufferCtor !== "function" || !ArrayBufferCtor.prototype) {
    return;
  }

  const TypeErrorCtor = runtimeGlobal.TypeError || TypeError;
  const nativeResize = typeof ArrayBufferCtor.prototype.resize === "function"
    ? ArrayBufferCtor.prototype.resize
    : null;
  const nativeTransfer = typeof ArrayBufferCtor.prototype.transfer === "function"
    ? ArrayBufferCtor.prototype.transfer
    : null;
  const nativeTransferToFixedLength = typeof ArrayBufferCtor.prototype.transferToFixedLength === "function"
    ? ArrayBufferCtor.prototype.transferToFixedLength
    : null;

  if (typeof ArrayBufferCtor.prototype.transferToImmutable !== "function") {
    const transferToImmutable = createNonConstructorMethod(function transferToImmutable(newLength) {
      requireArrayBufferReceiver(this, TypeErrorCtor, "transferToImmutable");
      const next = nativeTransfer
        ? nativeTransfer.call(this, newLength)
        : this.slice(0);
      immutableArrayBuffers.add(next);
      return next;
    }, 1);
    defineBuiltinFunctionMetadata(transferToImmutable, "transferToImmutable", 1);

    Object.defineProperty(ArrayBufferCtor.prototype, "transferToImmutable", {
      value: transferToImmutable,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  if (nativeResize) {
    const resize = createNonConstructorMethod(function resize(newLength) {
      requireArrayBufferReceiver(this, TypeErrorCtor, "resize");
      if (immutableArrayBuffers.has(this)) {
        throw new TypeErrorCtor("Cannot resize an immutable ArrayBuffer");
      }
      return nativeResize.call(this, newLength);
    }, 1);
    defineBuiltinFunctionMetadata(resize, "resize", 1);

    Object.defineProperty(ArrayBufferCtor.prototype, "resize", {
      value: resize,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  if (nativeTransfer) {
    const transfer = createNonConstructorMethod(function transfer(newLength) {
      requireArrayBufferReceiver(this, TypeErrorCtor, "transfer");
      const normalizedNewLength = normalizeArrayBufferNewLength(newLength);
      if (immutableArrayBuffers.has(this)) {
        throw new TypeErrorCtor("Cannot transfer an immutable ArrayBuffer");
      }
      return nativeTransfer.call(this, normalizedNewLength);
    }, 0);
    defineBuiltinFunctionMetadata(transfer, "transfer", 0);

    Object.defineProperty(ArrayBufferCtor.prototype, "transfer", {
      value: transfer,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  if (nativeTransferToFixedLength) {
    const transferToFixedLength = createNonConstructorMethod(function transferToFixedLength(newLength) {
      requireArrayBufferReceiver(this, TypeErrorCtor, "transferToFixedLength");
      const normalizedNewLength = normalizeArrayBufferNewLength(newLength);
      if (immutableArrayBuffers.has(this)) {
        throw new TypeErrorCtor("Cannot transfer an immutable ArrayBuffer");
      }
      return nativeTransferToFixedLength.call(this, normalizedNewLength);
    }, 0);
    defineBuiltinFunctionMetadata(transferToFixedLength, "transferToFixedLength", 0);

    Object.defineProperty(ArrayBufferCtor.prototype, "transferToFixedLength", {
      value: transferToFixedLength,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}

function requireArrayBufferReceiver(value, TypeErrorCtor, methodName) {
  if (!(value instanceof ArrayBuffer)) {
    throw new TypeErrorCtor(`ArrayBuffer.prototype.${methodName} called on incompatible receiver`);
  }
}

function normalizeArrayBufferNewLength(newLength) {
  if (newLength === undefined) {
    return undefined;
  }

  return toIndexValue(newLength);
}

function toIndexValue(value) {
  const integer = toIntegerOrInfinity(value);
  if (integer < 0) {
    throw new RangeError("Index must be non-negative");
  }
  if (!Number.isFinite(integer)) {
    throw new RangeError("Index must be finite");
  }
  return integer;
}

function toIntegerOrInfinity(value) {
  const number = Number(value);
  if (Number.isNaN(number) || number === 0) {
    return 0;
  }
  if (!Number.isFinite(number)) {
    return number;
  }
  return number < 0 ? Math.ceil(number) : Math.floor(number);
}

function createNonConstructorMethod(impl, length = impl.length) {
  const target = createNonConstructorCallable(length);
  return new Proxy(target, {
    apply(_target, thisArg, args) {
      return impl.apply(thisArg, args);
    },
  });
}

function createNonConstructorCallable(length) {
  switch (length) {
    case 0:
      return () => {};
    case 1:
      return (_arg0) => {};
    case 2:
      return (_arg0, _arg1) => {};
    case 3:
      return (_arg0, _arg1, _arg2) => {};
    default:
      return (..._args) => {};
  }
}

function defineBuiltinFunctionMetadata(fn, name, length) {
  Object.defineProperty(fn, "name", {
    value: name,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(fn, "length", {
    value: length,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  return fn;
}

function createRealmArrayFromAsync(runtimeGlobal) {
  if (typeof runtimeGlobal.Function === "function") {
    const impl = runtimeGlobal.Function(`
      const iteratorSymbol = Symbol.iterator;
      const asyncIteratorSymbol = Symbol.asyncIterator;
      return async function fromAsyncImpl(items, mapFn, thisArg) {
        if (new.target) {
          throw new TypeError("Array.fromAsync is not a constructor");
        }
        if (items === null || items === undefined) {
          throw new TypeError("Array.fromAsync requires a non-null asyncItems value");
        }

        const mapping = mapFn !== undefined;
        if (mapping && typeof mapFn !== "function") {
          throw new TypeError("Array.fromAsync mapFn must be callable");
        }

        const isConstructorValue = (value) => {
          if (typeof value !== "function") {
            return false;
          }
          try {
            Reflect.construct(function noop() {}, [], value);
            return true;
          } catch {
            return false;
          }
        };

        const defineOwnArrayElement = (array, index, value) => {
          Object.defineProperty(array, index, {
            value,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        };

        const toLengthValue = (value) => {
          if (typeof value === "bigint" || typeof value === "symbol") {
            throw new TypeError("Cannot convert value to length");
          }
          const length = Number(value);
          if (!Number.isFinite(length) || length <= 0) {
            return length === Infinity ? Number.MAX_SAFE_INTEGER : 0;
          }
          return Math.min(Math.floor(length), Number.MAX_SAFE_INTEGER);
        };

        const ResultCtor = isConstructorValue(this) ? this : Array;
        const result = new ResultCtor();
        let nextIndex = 0;

        const pushValue = async (value, awaitInput = true) => {
          const awaitedValue = awaitInput ? await value : value;
          const mappedValue = mapping
            ? await mapFn.call(thisArg, awaitedValue, nextIndex)
            : awaitedValue;
          defineOwnArrayElement(result, nextIndex, mappedValue);
          nextIndex += 1;
        };

        const closeAsyncIterator = async (iterator, completion) => {
          const returnMethod = iterator.return;
          if (returnMethod !== undefined && returnMethod !== null) {
            if (typeof returnMethod !== "function") {
              throw completion;
            }
            try {
              const returnResult = await returnMethod.call(iterator);
              if (returnResult === null || returnResult === undefined || (typeof returnResult !== "object" && typeof returnResult !== "function")) {
                throw new TypeError("Iterator return result is not an object");
              }
            } catch (closeError) {
              throw closeError;
            }
          }
          throw completion;
        };

        if (items !== null && items !== undefined) {
          const asyncIteratorFactory = items[asyncIteratorSymbol];
          if (asyncIteratorFactory !== undefined && asyncIteratorFactory !== null && typeof asyncIteratorFactory !== "function") {
            throw new TypeError("@@asyncIterator must be callable");
          }
          if (typeof asyncIteratorFactory === "function") {
            const iterator = asyncIteratorFactory.call(items);
            while (true) {
              let nextResult;
              try {
                nextResult = await iterator.next();
              } catch (error) {
                throw error;
              }
              if (nextResult.done) {
                break;
              }
              try {
                await pushValue(nextResult.value, false);
              } catch (error) {
                await closeAsyncIterator(iterator, error);
              }
            }
            result.length = nextIndex;
            return result;
          }

          const syncIteratorFactory = items[iteratorSymbol];
          if (syncIteratorFactory !== undefined && syncIteratorFactory !== null && typeof syncIteratorFactory !== "function") {
            throw new TypeError("@@iterator must be callable");
          }
          if (typeof syncIteratorFactory === "function") {
            for (const value of items) {
              await pushValue(value);
            }
            result.length = nextIndex;
            return result;
          }
        }

        const arrayLike = Object(items);
        const length = toLengthValue(arrayLike.length);
        for (let index = 0; index < length; index += 1) {
          await pushValue(arrayLike[index]);
        }
        result.length = nextIndex;
        return result;
      };
    `)();
    return createNonConstructorMethod(impl, 1);
  }

  const iteratorSymbol = Symbol.iterator;
  const asyncIteratorSymbol = Symbol.asyncIterator;
  return createNonConstructorMethod(async function fromAsyncImpl(items, mapFn, thisArg) {
    if (new.target) {
      throw new TypeError("Array.fromAsync is not a constructor");
    }
    if (items === null || items === undefined) {
      throw new TypeError("Array.fromAsync requires a non-null asyncItems value");
    }

    const mapping = mapFn !== undefined;
    if (mapping && typeof mapFn !== "function") {
      throw new TypeError("Array.fromAsync mapFn must be callable");
    }

    const ResultCtor = isConstructorValue(this) ? this : runtimeGlobal.Array;
    const result = new ResultCtor();
    let nextIndex = 0;

    const pushValue = async (value, awaitInput = true) => {
      const awaitedValue = awaitInput ? await value : value;
      const mappedValue = mapping
        ? await mapFn.call(thisArg, awaitedValue, nextIndex)
        : awaitedValue;
      defineOwnArrayElement(result, nextIndex, mappedValue);
      nextIndex += 1;
    };

    const closeAsyncIterator = async (iterator, completion) => {
      const returnMethod = iterator.return;
      if (returnMethod !== undefined && returnMethod !== null) {
        if (typeof returnMethod !== "function") {
          throw completion;
        }
        try {
          const returnResult = await returnMethod.call(iterator);
          if (returnResult === null || returnResult === undefined || (typeof returnResult !== "object" && typeof returnResult !== "function")) {
            throw new TypeError("Iterator return result is not an object");
          }
        } catch (closeError) {
          throw closeError;
        }
      }
      throw completion;
    };

    if (items !== null && items !== undefined) {
      const asyncIteratorFactory = items[asyncIteratorSymbol];
      if (asyncIteratorFactory !== undefined && asyncIteratorFactory !== null && typeof asyncIteratorFactory !== "function") {
        throw new TypeError("@@asyncIterator must be callable");
      }
      if (typeof asyncIteratorFactory === "function") {
        const iterator = asyncIteratorFactory.call(items);
        while (true) {
          const nextResult = await iterator.next();
          if (nextResult.done) {
            break;
          }
          try {
            await pushValue(nextResult.value, false);
          } catch (error) {
            await closeAsyncIterator(iterator, error);
          }
        }
        result.length = nextIndex;
        return result;
      }

      const syncIteratorFactory = items[iteratorSymbol];
      if (syncIteratorFactory !== undefined && syncIteratorFactory !== null && typeof syncIteratorFactory !== "function") {
        throw new TypeError("@@iterator must be callable");
      }
      if (typeof syncIteratorFactory === "function") {
        for (const value of items) {
          await pushValue(value);
        }
        result.length = nextIndex;
        return result;
      }
    }

    const arrayLike = Object(items);
    const length = toLengthValue(arrayLike.length);
    for (let index = 0; index < length; index += 1) {
      await pushValue(arrayLike[index]);
    }
    result.length = nextIndex;
    return result;
  }, 1);
}

function isConstructorValue(value) {
  if (typeof value !== "function") {
    return false;
  }

  try {
    Reflect.construct(function noop() {}, [], value);
    return true;
  } catch {
    return false;
  }
}

function normalizeTemporalBuiltins(runtimeGlobal) {
  const DateCtor = runtimeGlobal.Date;
  if (typeof DateCtor !== "function" || !DateCtor.prototype) {
    return;
  }

  const temporal = getOrCreateTemporalNamespace(runtimeGlobal);
  const InstantCtor = getOrCreateTemporalInstantIntrinsic(runtimeGlobal, temporal);

  if (typeof DateCtor.prototype.toTemporalInstant !== "function") {
    const toTemporalInstant = createNonConstructorMethod(function toTemporalInstant() {
      if (!(this instanceof DateCtor)) {
        throw new TypeError("Date.prototype.toTemporalInstant requires a Date receiver");
      }

      const epochMilliseconds = this.valueOf();
      if (Number.isNaN(epochMilliseconds)) {
        throw new RangeError("Invalid time value");
      }

      return InstantCtor.fromEpochMilliseconds(epochMilliseconds);
    }, 0);
    defineBuiltinFunctionMetadata(toTemporalInstant, "toTemporalInstant", 0);

    Object.defineProperty(DateCtor.prototype, "toTemporalInstant", {
      value: toTemporalInstant,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}

function getOrCreateTemporalNamespace(runtimeGlobal) {
  if (runtimeGlobal.Temporal && (typeof runtimeGlobal.Temporal === "object" || typeof runtimeGlobal.Temporal === "function")) {
    return runtimeGlobal.Temporal;
  }

  const temporal = {};
  Object.defineProperty(runtimeGlobal, "Temporal", {
    value: temporal,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  return temporal;
}

function getOrCreateTemporalInstantIntrinsic(runtimeGlobal, temporal) {
  const existing = temporal.Instant;
  if (typeof existing === "function" && typeof existing.fromEpochMilliseconds === "function") {
    return existing;
  }

  const Instant = typeof existing === "function"
    ? existing
    : function Instant() {
        throw new TypeError("Temporal.Instant cannot be constructed directly");
      };
  const prototype = Instant.prototype && typeof Instant.prototype === "object"
    ? Instant.prototype
    : {};

  Object.defineProperty(prototype, Symbol.toStringTag, {
    value: "Temporal.Instant",
    writable: false,
    enumerable: false,
    configurable: true,
  });

  if (typeof prototype.toString !== "function") {
    Object.defineProperty(prototype, "toString", {
      value: function toString() {
        return `${this.epochNanoseconds}`;
      },
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  Object.defineProperty(Instant, "prototype", {
    value: prototype,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  const fromEpochMilliseconds = createNonConstructorMethod(function fromEpochMilliseconds(value) {
    const epochMilliseconds = Number(value);
    if (!Number.isFinite(epochMilliseconds)) {
      throw new RangeError("Invalid epoch milliseconds");
    }
    return createTemporalInstantValue(
      BigInt(Math.trunc(epochMilliseconds)) * 1000000n,
      Instant.prototype
    );
  }, 1);
  defineBuiltinFunctionMetadata(fromEpochMilliseconds, "fromEpochMilliseconds", 1);

  Object.defineProperty(Instant, "fromEpochMilliseconds", {
    value: fromEpochMilliseconds,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  defineBuiltinFunctionMetadata(Instant, "Instant", 0);
  Object.defineProperty(temporal, "Instant", {
    value: Instant,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  return Instant;
}

function createTemporalInstantValue(epochNanoseconds, prototype) {
  const instant = Object.create(prototype);
  Object.defineProperty(instant, "epochNanoseconds", {
    value: epochNanoseconds,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  return instant;
}

function normalizeIteratorBuiltins(runtimeGlobal) {
  const IteratorCtor = getOrCreateIteratorIntrinsic(runtimeGlobal);
  if (typeof IteratorCtor.concat !== "function") {
    const concat = createNonConstructorMethod(function concat(...items) {
      const records = items.map((item) => {
        if (item === null || item === undefined || (typeof item !== "object" && typeof item !== "function")) {
          throw new TypeError("Iterator.concat requires object iterables");
        }
        const openMethod = item[Symbol.iterator];
        if (openMethod === null || openMethod === undefined || typeof openMethod !== "function") {
          throw new TypeError("Iterator.concat requires a callable @@iterator method");
        }
        return { iterable: item, openMethod };
      });

      return createIteratorConcatHelper(records, IteratorCtor.prototype);
    }, 0);
    defineBuiltinFunctionMetadata(concat, "concat", 0);

    Object.defineProperty(IteratorCtor, "concat", {
      value: concat,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  if (typeof IteratorCtor.zipKeyed !== "function") {
    const zipKeyed = createNonConstructorMethod(function zipKeyed(iterables, options) {
      return createIteratorZipKeyedHelper(
        createZipKeyedRecords(iterables, options),
        IteratorCtor.prototype
      );
    }, 1);
    defineBuiltinFunctionMetadata(zipKeyed, "zipKeyed", 1);

    Object.defineProperty(IteratorCtor, "zipKeyed", {
      value: zipKeyed,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}

function getOrCreateIteratorIntrinsic(runtimeGlobal) {
  const existing = runtimeGlobal.Iterator;
  if (typeof existing === "function" && existing.prototype && typeof existing.prototype[Symbol.iterator] === "function") {
    return existing;
  }

  const IteratorCtor = typeof existing === "function"
    ? existing
    : function Iterator() {
        throw new TypeError("Iterator cannot be constructed directly");
      };
  const prototype = IteratorCtor.prototype && typeof IteratorCtor.prototype === "object"
    ? IteratorCtor.prototype
    : {};

  Object.defineProperty(prototype, Symbol.iterator, {
    value: function iterator() {
      return this;
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });

  Object.defineProperty(IteratorCtor, "prototype", {
    value: prototype,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  defineBuiltinFunctionMetadata(IteratorCtor, "Iterator", 0);

  Object.defineProperty(runtimeGlobal, "Iterator", {
    value: IteratorCtor,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  return IteratorCtor;
}

function createIteratorConcatHelper(records, iteratorPrototype) {
  const state = {
    records,
    currentIndex: 0,
    currentIterator: null,
    done: false,
    executing: false,
    started: false,
  };

  const helper = Object.create(iteratorPrototype);

  Object.defineProperty(helper, "next", {
    value: createNonConstructorMethod(function next() {
      if (state.executing) {
        throw new TypeError("Iterator helper is already executing");
      }
      if (state.done) {
        return { done: true, value: undefined };
      }

      state.executing = true;
      state.started = true;
      try {
        while (true) {
          if (!state.currentIterator) {
            if (state.currentIndex >= state.records.length) {
              state.done = true;
              return { done: true, value: undefined };
            }

            const record = state.records[state.currentIndex++];
            const iterator = record.openMethod.call(record.iterable);
            if (iterator === null || iterator === undefined || (typeof iterator !== "object" && typeof iterator !== "function")) {
              throw new TypeError("Iterator.concat expected @@iterator to return an object");
            }
            state.currentIterator = iterator;
          }

          const result = state.currentIterator.next();
          if (result === null || result === undefined || (typeof result !== "object" && typeof result !== "function")) {
            throw new TypeError("Iterator result is not an object");
          }

          if (result.done) {
            state.currentIterator = null;
            continue;
          }

          return {
            done: false,
            value: result.value,
          };
        }
      } finally {
        state.executing = false;
      }
    }, 0),
    writable: true,
    enumerable: false,
    configurable: true,
  });

  Object.defineProperty(helper, "return", {
    value: createNonConstructorMethod(function iteratorReturn() {
      if (state.executing) {
        throw new TypeError("Iterator helper is already executing");
      }

      if (state.done) {
        return { done: true, value: undefined };
      }

      state.executing = true;
      try {
        if (state.started && state.currentIterator) {
          const returnMethod = state.currentIterator.return;
          if (returnMethod !== null && returnMethod !== undefined) {
            if (typeof returnMethod !== "function") {
              throw new TypeError("Iterator return method is not callable");
            }
            const returnResult = returnMethod.call(state.currentIterator);
            if (returnResult === null || returnResult === undefined || (typeof returnResult !== "object" && typeof returnResult !== "function")) {
              throw new TypeError("Iterator return result is not an object");
            }
          }
        }

        state.currentIterator = null;
        state.currentIndex = state.records.length;
        state.done = true;
        return { done: true, value: undefined };
      } finally {
        state.executing = false;
      }
    }, 0),
    writable: true,
    enumerable: false,
    configurable: true,
  });

  return helper;
}

function createZipKeyedRecords(iterables, options) {
  if (iterables === null || iterables === undefined || (typeof iterables !== "object" && typeof iterables !== "function")) {
    throw new TypeError("Iterator.zipKeyed requires an object");
  }

  const optionsObject = options === null || options === undefined ? undefined : Object(options);
  const modeValue = optionsObject ? optionsObject.mode : undefined;
  const mode = modeValue === undefined ? "shortest" : modeValue;
  if (mode !== "shortest" && mode !== "longest" && mode !== "strict") {
    throw new TypeError("Iterator.zipKeyed mode must be shortest, longest, or strict");
  }
  const paddingObject = mode === "longest" && optionsObject ? optionsObject.padding : undefined;

  const records = [];
  try {
    for (const key of Reflect.ownKeys(iterables)) {
      const desc = Object.getOwnPropertyDescriptor(iterables, key);
      if (!desc || !desc.enumerable) {
        continue;
      }

      const value = iterables[key];
      if (value === undefined) {
        continue;
      }

      const iteratorRecord = getIteratorFlattenableRecord(value);
      records.push({
        key,
        iterator: iteratorRecord.iterator,
        nextMethod: iteratorRecord.nextMethod,
        done: false,
        padding: mode === "longest" && paddingObject !== null && paddingObject !== undefined
          ? paddingObject[key]
          : undefined,
      });
    }
  } catch (error) {
    closeOpenIterators(records, error);
    throw error;
  }

  return { mode, records };
}

function getIteratorFlattenableRecord(value) {
  if (value === null || value === undefined || (typeof value !== "object" && typeof value !== "function")) {
    throw new TypeError("Iterator.zipKeyed requires object or iterator values");
  }

  const method = value[Symbol.iterator];
  let iterator;
  if (method === undefined) {
    iterator = value;
  } else {
    if (method === null || typeof method !== "function") {
      throw new TypeError("Iterator.zipKeyed requires a callable @@iterator method");
    }
    iterator = method.call(value);
  }

  if (iterator === null || iterator === undefined || (typeof iterator !== "object" && typeof iterator !== "function")) {
    throw new TypeError("Iterator.zipKeyed expected an iterator object");
  }

  const nextMethod = iterator.next;
  if (typeof nextMethod !== "function") {
    throw new TypeError("Iterator.zipKeyed expected a callable next method");
  }

  return { iterator, nextMethod };
}

function closeOpenIterators(records, completionError = null) {
  let preservedError = completionError;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record || !record.iterator) {
      continue;
    }

    try {
      const returnMethod = record.iterator.return;
      if (returnMethod === undefined || returnMethod === null) {
        continue;
      }
      if (typeof returnMethod !== "function") {
        throw new TypeError("Iterator return method is not callable");
      }
      const returnResult = returnMethod.call(record.iterator);
      if (returnResult === null || returnResult === undefined || (typeof returnResult !== "object" && typeof returnResult !== "function")) {
        throw new TypeError("Iterator return result is not an object");
      }
    } catch (closeError) {
      if (!preservedError) {
        preservedError = closeError;
      }
    }
  }

  if (!completionError && preservedError) {
    throw preservedError;
  }
}

function createIteratorZipKeyedHelper(zipState, iteratorPrototype) {
  const state = {
    mode: zipState.mode,
    records: zipState.records,
    done: false,
    executing: false,
  };

  const helper = Object.create(iteratorPrototype);

  Object.defineProperty(helper, "next", {
    value: createNonConstructorMethod(function next() {
      if (state.executing) {
        throw new TypeError("Iterator helper is already executing");
      }
      if (state.done) {
        return { done: true, value: undefined };
      }

      state.executing = true;
      try {
        if (state.records.length === 0) {
          state.done = true;
          return { done: true, value: undefined };
        }

        const row = new Array(state.records.length);
        let doneCount = 0;
        let sawDone = false;

        for (let index = 0; index < state.records.length; index += 1) {
          const record = state.records[index];
          if (record.done) {
            doneCount += 1;
            row[index] = record.padding;
            continue;
          }

          const result = record.nextMethod.call(record.iterator);
          if (result === null || result === undefined || (typeof result !== "object" && typeof result !== "function")) {
            throw new TypeError("Iterator result is not an object");
          }

          if (result.done) {
            sawDone = true;
            doneCount += 1;
            record.done = true;
            row[index] = record.padding;
            if (state.mode === "shortest") {
              state.done = true;
              closeOpenIterators(state.records);
              return { done: true, value: undefined };
            }
            continue;
          }

          row[index] = result.value;
        }

        if (state.mode === "strict" && sawDone) {
          state.done = true;
          closeOpenIterators(state.records);
          if (doneCount !== state.records.length) {
            throw new TypeError("Iterator.zipKeyed strict mode requires equal lengths");
          }
          return { done: true, value: undefined };
        }

        if (doneCount === state.records.length) {
          state.done = true;
          return { done: true, value: undefined };
        }

        return {
          done: false,
          value: createZipResultObject(state.records, row),
        };
      } finally {
        state.executing = false;
      }
    }, 0),
    writable: true,
    enumerable: false,
    configurable: true,
  });

  Object.defineProperty(helper, "return", {
    value: createNonConstructorMethod(function iteratorReturn() {
      if (state.executing) {
        throw new TypeError("Iterator helper is already executing");
      }
      if (state.done) {
        return { done: true, value: undefined };
      }

      state.executing = true;
      try {
        closeOpenIterators(state.records);
        state.done = true;
        return { done: true, value: undefined };
      } finally {
        state.executing = false;
      }
    }, 0),
    writable: true,
    enumerable: false,
    configurable: true,
  });

  return helper;
}

function createZipResultObject(records, values) {
  const result = Object.create(null);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    Object.defineProperty(result, record.key, {
      value: values[index],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return result;
}

function prototypeChainIncludes(value, prototype) {
  let current = Object.getPrototypeOf(value);
  while (current) {
    if (current === prototype) {
      return true;
    }
    current = Object.getPrototypeOf(current);
  }
  return false;
}

function toStringValue(value) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "symbol") {
    throw new TypeError("Cannot convert a Symbol value to a string");
  }
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value !== "object" && typeof value !== "function") {
    return String(value);
  }

  const exoticToPrimitive = value[Symbol.toPrimitive];
  if (typeof exoticToPrimitive === "function") {
    const primitive = exoticToPrimitive.call(value, "string");
    if (isPrimitive(primitive)) {
      return String(primitive);
    }
    throw new TypeError("Cannot convert object to primitive value");
  }

  const toStringMethod = value.toString;
  if (typeof toStringMethod === "function") {
    const stringResult = toStringMethod.call(value);
    if (isPrimitive(stringResult)) {
      return String(stringResult);
    }
  }

  const valueOfMethod = value.valueOf;
  if (typeof valueOfMethod === "function") {
    const valueResult = valueOfMethod.call(value);
    if (isPrimitive(valueResult)) {
      return String(valueResult);
    }
  }

  throw new TypeError("Cannot convert object to primitive value");
}

function isPrimitive(value) {
  return value === null || (typeof value !== "object" && typeof value !== "function");
}

function normalizeModuleNamespace(moduleValue, specifier = null) {
  if (moduleValue && (typeof moduleValue === "object" || typeof moduleValue === "function")) {
    if ("default" in moduleValue && "__module" in moduleValue) {
      return moduleValue;
    }

    return {
      ...moduleValue,
      default: "default" in moduleValue ? moduleValue.default : moduleValue,
      __module: specifier,
    };
  }

  return {
    default: moduleValue,
    __module: specifier,
  };
}

function looksLikeESModule(source, filename) {
  if (filename && /\.mjs$/i.test(filename)) {
    return true;
  }

  return /^\s*(import|export)\b/m.test(source);
}

function looksLikeCommonJs(source) {
  return /\bmodule\.exports\b|\bexports\.[A-Za-z_$]|\brequire\s*\(/.test(source);
}

function captureGlobalSlots(globalObject, names) {
  return names.map((name) => ({
    name,
    existed: Object.prototype.hasOwnProperty.call(globalObject, name),
    value: globalObject[name],
  }));
}

function restoreGlobalSlots(globalObject, entries) {
  for (const entry of entries) {
    if (entry.existed) {
      globalObject[entry.name] = entry.value;
    } else {
      delete globalObject[entry.name];
    }
  }
}

async function executeCompiledProgram(compiledProgram, options = {}) {
  const program = compiledProgram.program || compiledProgram;
  const vm = new BytecodeVM(program, options);
  return vm.execute();
}

module.exports = {
  BytecodeVM,
  executeCompiledProgram,
  normalizeLegacyBuiltins,
};

export {};
