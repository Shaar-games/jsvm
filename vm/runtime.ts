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
      registers: createRegisters(),
      thisValue: this.getTopLevelThisValue(),
      tryStack: [],
      exports: {},
      pendingError: undefined,
    };
    const result = await this.executeChunk(this.program.entry, null, [], state);
    this.lastExports = state.exports;
    return result;
  }

  executeSync() {
    const state = {
      envStack: [createEnvironment()],
      registers: createRegisters(),
      thisValue: this.getTopLevelThisValue(),
      tryStack: [],
      exports: {},
      pendingError: undefined,
    };
    const result = this.executeChunkSync(this.program.entry, null, [], state);
    this.lastExports = state.exports;
    return result;
  }

  async executeChunk(bytecode, functionMeta, args = [], runtimeState) {
    const { instructions, labels } = parseBytecode(bytecode);
    const execState = runtimeState || {
      envStack: [createEnvironment()],
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
      pushEnv: () => execState.envStack.unshift(createEnvironment()),
      popEnv: () => execState.envStack.shift(),
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
      pushEnv: () => execState.envStack.unshift(createEnvironment()),
      popEnv: () => execState.envStack.shift(),
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
    });
    const program = compiled.program || compiled;
    const evalVm = new BytecodeVM(program, {
      compiler: this.compiler,
      filename: `${this.filename || "<eval>"}#eval`,
      runtimeGlobal: this.globalObject,
      modules: this.moduleOverrides,
      require: this.require,
      moduleCache: this.moduleCache,
    });
    const nextState = {
      envStack: options.indirect ? [createEnvironment()] : state.envStack,
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
  normalizeLegacyStringHtmlMethods(runtimeGlobal);
  normalizeLegacyRegExpAccessors(runtimeGlobal);
  normalizeLegacyRegExpCompile(runtimeGlobal);
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

      if (!prototypeChainIncludes(this, RegExpCtor.prototype)) {
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
