// @ts-nocheck
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
    this.globalObject = buildRuntimeEnv(options.env || options.globals || {});
    this.env = this.globalObject;
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
    if (this.moduleCache.has(specifier)) {
      return this.moduleCache.get(specifier);
    }

    if (Object.prototype.hasOwnProperty.call(this.moduleOverrides, specifier)) {
      const overrideValue = this.moduleOverrides[specifier];
      const namespace = normalizeModuleNamespace(overrideValue);
      this.moduleCache.set(specifier, namespace);
      return namespace;
    }

    if (!this.compiler || !this.filename) {
      const fallback = this.resolveExternalModule(specifier);
      this.moduleCache.set(specifier, fallback);
      return fallback;
    }

    const resolvedPath = this.resolveImportPath(specifier);
    if (!resolvedPath) {
      const fallback = this.resolveExternalModule(specifier);
      this.moduleCache.set(specifier, fallback);
      return fallback;
    }
    const source = fs.readFileSync(resolvedPath, "utf8");
    const compiled = await this.compiler(source, {
      sourceType: "module",
      filename: resolvedPath,
    });
    const childProgram = compiled.program || compiled;
    const childVm = new BytecodeVM(childProgram, {
      compiler: this.compiler,
      filename: resolvedPath,
      env: this.env,
      modules: this.moduleOverrides,
      require: this.require,
      moduleCache: this.moduleCache,
    });
    await childVm.execute();
    const namespace = childVm.lastExports || {};
    this.moduleCache.set(specifier, namespace);
    return namespace;
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
}

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

  const nativeCompile = typeof RegExpCtor.prototype.compile === "function"
    ? RegExpCtor.prototype.compile
    : null;

  Object.defineProperty(RegExpCtor.prototype, "compile", {
    value: function compile(pattern, flags) {
      if (this === null || this === undefined || typeof this !== "object") {
        throw new TypeError("RegExp.prototype.compile requires an object receiver");
      }

      if (Object.prototype.toString.call(this) !== "[object RegExp]") {
        throw new TypeError("RegExp.prototype.compile requires a RegExp receiver");
      }

      if (!prototypeChainIncludes(this, RegExpCtor.prototype)) {
        throw new TypeError("RegExp.prototype.compile cross-realm receiver mismatch");
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

async function executeCompiledProgram(compiledProgram, options = {}) {
  const program = compiledProgram.program || compiledProgram;
  const vm = new BytecodeVM(program, options);
  return vm.execute();
}

module.exports = {
  BytecodeVM,
  executeCompiledProgram,
};

export {};
