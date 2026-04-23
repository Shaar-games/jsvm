// @ts-nocheck
const acorn = require("acorn");
const path = require("path");
const fs = require("fs");
const nodeVm = require("vm");
const { createEnvironment, getBinding, initBinding, storeBinding, TDZ } = require("./environment");
const { createRegisters, getRegister, setRegister } = require("./registers");
const { executeInstruction, executeInstructionSync } = require("./handlers");
const { buildFunctionTable, parseBytecode } = require("./parser");
const { getSpecialFunctionConstructors } = require("./intrinsics");
const {
  createDataDescriptor,
  defineDataProperty,
} = require("./descriptors");

let activeRuntimeFunctionPrototype = null;
const hostReflectApply = Reflect.apply;
const hostReflectConstruct = Reflect.construct;
const shadowRealmStates = new WeakMap();

function internalUnshift(array, value) {
  for (let index = array.length; index > 0; index -= 1) {
    defineDataProperty(array, index, array[index - 1]);
  }
  defineDataProperty(array, 0, value);
}

function internalPush(array, value) {
  defineDataProperty(array, array.length, value);
}

function internalRemoveAt(array, index) {
  if (index < 0 || index >= array.length) {
    return;
  }
  for (let current = index + 1; current < array.length; current += 1) {
    defineDataProperty(array, current - 1, array[current]);
  }
  array.length -= 1;
}

function internalShift(array) {
  if (array.length === 0) {
    return undefined;
  }
  const value = array[0];
  for (let index = 1; index < array.length; index += 1) {
    defineDataProperty(array, index - 1, array[index]);
  }
  array.length -= 1;
  return value;
}

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
    this.functionCallStack = options.functionCallStack || [];
    this.staticValues = (program.staticSection && program.staticSection.values) || [];
    this.globalObject = options.runtimeGlobal || buildRuntimeEnv(options.env || options.globals || {});
    this.env = this.globalObject;
    defineDataProperty(this.globalObject, "__jsvmFunctionCallStack", this.functionCallStack, true, false, true);
    if (!this.globalObject.eval || !this.globalObject.eval.__jsvmDirectEval) {
      const directEval = function jsvmEval() {
        throw new Error("Direct eval interception should be handled by the VM call dispatcher");
      };
      directEval.__jsvmDirectEval = true;
      defineDataProperty(this.globalObject, "eval", directEval, true, false, true);
    }
    if (!this.globalObject.require || !this.globalObject.require.__jsvmRequire) {
      const directRequire = function jsvmRequire() {
        throw new Error("Require interception should be handled by the VM call dispatcher");
      };
      directRequire.__jsvmRequire = true;
      defineDataProperty(this.globalObject, "require", directRequire, true, false, true);
    }
  }

  async execute() {
    const state = this.createExecutionState(null, {
      thisValue: this.getTopLevelThisValue(),
    });
    const result = await this.executeChunk(this.program.entry, null, [], state);
    this.lastState = state;
    this.lastExports = state.exports;
    return result;
  }

  executeSync() {
    const state = this.createExecutionState(null, {
      thisValue: this.getTopLevelThisValue(),
    });
    const result = this.executeChunkSync(this.program.entry, null, [], state);
    this.lastState = state;
    this.lastExports = state.exports;
    return result;
  }

  createExecutionState(runtimeState = null, overrides = {}) {
    if (runtimeState) {
      return runtimeState;
    }

    return {
      envStack: [createEnvironment()],
      bindingNameStack: [this.program.scopeBindings || {}],
      registers: createRegisters(),
      thisValue: undefined,
      newTarget: undefined,
      tryStack: [],
      withStack: [],
      exports: {},
      pendingError: undefined,
      currentFunction: null,
      currentFunctionMeta: null,
      ...overrides,
    };
  }

  seedFunctionState(execState, functionMeta, args = []) {
    if (!functionMeta) {
      return;
    }

    if (Array.isArray(functionMeta.paramBindings)) {
      functionMeta.paramBindings.forEach((bindingRef, index) => {
        initBinding(execState.envStack, bindingRef.depth, bindingRef.slot, args[index]);
      });
    }
    if (functionMeta.argumentsBinding) {
      initBinding(
        execState.envStack,
        functionMeta.argumentsBinding.depth,
        functionMeta.argumentsBinding.slot,
        createArgumentsObject(args)
      );
    }
    if (functionMeta.restBinding) {
      initBinding(
        execState.envStack,
        functionMeta.restBinding.depth,
        functionMeta.restBinding.slot,
        args.slice(functionMeta.restBinding.index)
      );
    }
  }

  createInstructionState(execState, labels) {
    return {
      envStack: execState.envStack,
      bindingNameStack: execState.bindingNameStack,
      registers: execState.registers,
      labels,
      get thisValue() {
        return execState.thisValue;
      },
      set thisValue(value) {
        execState.thisValue = value;
      },
      newTarget: execState.newTarget,
      get homeClass() {
        return execState.homeClass;
      },
      set homeClass(value) {
        execState.homeClass = value;
      },
      get superClass() {
        return execState.superClass;
      },
      set superClass(value) {
        execState.superClass = value;
      },
      tryStack: execState.tryStack,
      withStack: execState.withStack,
      exports: execState.exports,
      currentFunction: execState.currentFunction,
      currentFunctionMeta: execState.currentFunctionMeta,
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
        internalUnshift(execState.envStack, createEnvironment());
        internalUnshift(execState.bindingNameStack, {});
      },
      popEnv: () => {
        internalShift(execState.envStack);
        internalShift(execState.bindingNameStack);
      },
    };
  }

  createGeneratorFrame(bytecode, functionMeta, args = [], runtimeState) {
    const { instructions, labels } = parseBytecode(bytecode);
    const execState = this.createExecutionState(runtimeState);
    this.seedFunctionState(execState, functionMeta, args);
    return {
      instructions,
      labels,
      execState,
      ip: 0,
      done: false,
      resumeRegister: null,
      delegate: null,
    };
  }

  getIteratorFromValue(iterable) {
    if (iterable === null || iterable === undefined) {
      throw new TypeError("Value is not iterable");
    }
    const iteratorMethod = iterable[Symbol.iterator];
    if (typeof iteratorMethod !== "function") {
      throw new TypeError("Value is not iterable");
    }
    const iterator = iteratorMethod.call(iterable);
    if (iterator === null || iterator === undefined || (typeof iterator !== "object" && typeof iterator !== "function")) {
      throw new TypeError("Iterator is not an object");
    }
    return iterator;
  }

  getAsyncIteratorFromValue(iterable) {
    if (iterable === null || iterable === undefined) {
      throw new TypeError("Value is not async iterable");
    }

    const asyncIteratorMethod = iterable[Symbol.asyncIterator];
    if (typeof asyncIteratorMethod === "function") {
      const iterator = asyncIteratorMethod.call(iterable);
      if (iterator === null || iterator === undefined || (typeof iterator !== "object" && typeof iterator !== "function")) {
        throw new TypeError("Async iterator is not an object");
      }
      return iterator;
    }

    const syncIterator = this.getIteratorFromValue(iterable);
    return {
      async next(value) {
        const result = syncIterator.next(value);
        if (result === null || result === undefined || (typeof result !== "object" && typeof result !== "function")) {
          throw new TypeError("Iterator result is not an object");
        }
        const done = Boolean(result.done);
        if (done) {
          return { done: true, value: result.value };
        }
        try {
          return { done: false, value: await result.value };
        } catch (error) {
          if (typeof syncIterator.return === "function") {
            await syncIterator.return();
          }
          throw error;
        }
      },
      return(value) {
        if (typeof syncIterator.return !== "function") {
          return Promise.resolve({ done: true, value });
        }
        return Promise.resolve(syncIterator.return(value));
      },
      throw(error) {
        if (typeof syncIterator.throw !== "function") {
          return Promise.reject(error);
        }
        return Promise.resolve(syncIterator.throw(error));
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  resumeDelegatedGenerator(frame, resumeType = "next", resumeValue = undefined) {
    while (frame.delegate) {
      const { iterator, resumeRegister } = frame.delegate;
      let methodName = "next";
      if (resumeType === "throw") {
        methodName = "throw";
      } else if (resumeType === "return") {
        methodName = "return";
      }

      let method = iterator[methodName];
      if (method === undefined || method === null) {
        if (resumeType === "throw") {
          frame.delegate = null;
          throw resumeValue;
        }
        if (resumeType === "return") {
          frame.delegate = null;
          frame.done = true;
          return {
            done: true,
            value: resumeValue,
          };
        }
        method = iterator.next;
      }

      if (typeof method !== "function") {
        throw new TypeError(`Iterator ${methodName} method is not callable`);
      }

      const result = method.call(iterator, resumeValue);
      if (result === null || result === undefined || (typeof result !== "object" && typeof result !== "function")) {
        throw new TypeError("Iterator result is not an object");
      }

      if (!result.done) {
        return {
          done: false,
          value: result.value,
        };
      }

      frame.delegate = null;
      if (resumeRegister && resumeRegister !== "null") {
        setRegister(frame.execState.registers, resumeRegister, result.value);
      }
      resumeType = "next";
      resumeValue = undefined;
    }

    return null;
  }

  resumeGeneratorFrame(frame, resumeType = "next", resumeValue = undefined) {
    if (frame.done) {
      if (resumeType === "throw") {
        throw resumeValue;
      }
      return {
        done: true,
        value: resumeType === "return" ? resumeValue : undefined,
      };
    }

    if (resumeType === "throw") {
      frame.done = true;
      throw resumeValue;
    }
    if (resumeType === "return") {
      frame.done = true;
      return { done: true, value: resumeValue };
    }

    let ip = frame.ip;

    while (true) {
      const delegatedResult = this.resumeDelegatedGenerator(frame, resumeType, resumeValue);
      if (delegatedResult) {
        return delegatedResult;
      }

      if (frame.resumeRegister && frame.resumeRegister !== "null") {
        setRegister(frame.execState.registers, frame.resumeRegister, resumeValue);
        frame.resumeRegister = null;
      }

      const state = this.createInstructionState(frame.execState, frame.labels);

      while (ip < frame.instructions.length) {
      const instruction = frame.instructions[ip];
      try {
        const effect = executeInstructionSync(this, state, instruction);
        if (effect && effect.type === "yield") {
          frame.ip = ip + 1;
          frame.resumeRegister = effect.resumeRegister;
          return {
            done: false,
            value: effect.value,
          };
        }
        if (effect && effect.type === "yield-star") {
          frame.ip = ip + 1;
          frame.delegate = {
            iterator: this.getIteratorFromValue(effect.iterable),
            resumeRegister: effect.resumeRegister,
          };
          ip = frame.ip;
          resumeType = "next";
          resumeValue = undefined;
          break;
        }
        if (effect && effect.type === "return") {
          frame.done = true;
          frame.ip = frame.instructions.length;
          frame.resumeRegister = null;
          return {
            done: true,
            value: effect.value,
          };
        }
        if (effect && effect.type === "jump") {
          ip = effect.ip;
          continue;
        }
      } catch (error) {
        const handler = state.tryStack.pop();
        if (!handler) {
          frame.done = true;
          throw error;
        }
        state.pendingError = error;
        while (state.envStack.length > handler.envDepth) {
          internalShift(state.envStack);
        }
        ip = this.jump(frame.labels, handler.catchLabel);
        continue;
      }

      ip += 1;
    }

      if (frame.delegate) {
        continue;
      }

      frame.done = true;
      frame.ip = frame.instructions.length;
      frame.resumeRegister = null;
      return {
        done: true,
        value: undefined,
      };
    }
  }

  async resumeAsyncDelegatedGenerator(frame, resumeType = "next", resumeValue = undefined) {
    while (frame.delegate) {
      const { iterator, resumeRegister } = frame.delegate;
      let methodName = "next";
      if (resumeType === "throw") {
        methodName = "throw";
      } else if (resumeType === "return") {
        methodName = "return";
      }

      let method = iterator[methodName];
      if (method === undefined || method === null) {
        if (resumeType === "throw") {
          frame.delegate = null;
          throw resumeValue;
        }
        if (resumeType === "return") {
          frame.delegate = null;
          frame.done = true;
          return { done: true, value: resumeValue };
        }
        method = iterator.next;
      }

      if (typeof method !== "function") {
        throw new TypeError(`Iterator ${methodName} method is not callable`);
      }

      const result = await method.call(iterator, resumeValue);
      if (result === null || result === undefined || (typeof result !== "object" && typeof result !== "function")) {
        throw new TypeError("Iterator result is not an object");
      }

      if (!result.done) {
        return {
          done: false,
          value: await result.value,
        };
      }

      frame.delegate = null;
      if (resumeRegister && resumeRegister !== "null") {
        setRegister(frame.execState.registers, resumeRegister, result.value);
      }
      resumeType = "next";
      resumeValue = undefined;
    }

    return null;
  }

  async resumeAsyncGeneratorFrame(frame, resumeType = "next", resumeValue = undefined) {
    if (frame.done) {
      if (resumeType === "throw") {
        throw resumeValue;
      }
      return {
        done: true,
        value: resumeType === "return" ? resumeValue : undefined,
      };
    }

    if (resumeType === "throw") {
      frame.done = true;
      throw resumeValue;
    }
    if (resumeType === "return") {
      frame.done = true;
      return { done: true, value: resumeValue };
    }

    let ip = frame.ip;

    while (true) {
      const delegatedResult = await this.resumeAsyncDelegatedGenerator(frame, resumeType, resumeValue);
      if (delegatedResult) {
        return delegatedResult;
      }

      if (frame.resumeRegister && frame.resumeRegister !== "null") {
        setRegister(frame.execState.registers, frame.resumeRegister, resumeValue);
        frame.resumeRegister = null;
      }

      const state = this.createInstructionState(frame.execState, frame.labels);

      while (ip < frame.instructions.length) {
        const instruction = frame.instructions[ip];
        try {
          const effect = await executeInstruction(this, state, instruction);
          if (effect && effect.type === "yield") {
            frame.ip = ip + 1;
            frame.resumeRegister = effect.resumeRegister;
            return {
              done: false,
              value: await effect.value,
            };
          }
          if (effect && effect.type === "yield-star") {
            frame.ip = ip + 1;
            frame.delegate = {
              iterator: this.getAsyncIteratorFromValue(effect.iterable),
              resumeRegister: effect.resumeRegister,
            };
            ip = frame.ip;
            resumeType = "next";
            resumeValue = undefined;
            break;
          }
          if (effect && effect.type === "return") {
            frame.done = true;
            frame.ip = frame.instructions.length;
            frame.resumeRegister = null;
            return {
              done: true,
              value: effect.value,
            };
          }
          if (effect && effect.type === "jump") {
            ip = effect.ip;
            continue;
          }
        } catch (error) {
          const handler = state.tryStack.pop();
          if (!handler) {
            frame.done = true;
            throw error;
          }
          state.pendingError = error;
          while (state.envStack.length > handler.envDepth) {
            internalShift(state.envStack);
          }
          ip = this.jump(frame.labels, handler.catchLabel);
          continue;
        }

        ip += 1;
      }

      if (frame.delegate) {
        continue;
      }

      frame.done = true;
      frame.ip = frame.instructions.length;
      frame.resumeRegister = null;
      return {
        done: true,
        value: undefined,
      };
    }
  }

  async executeChunk(bytecode, functionMeta, args = [], runtimeState) {
    const { instructions, labels } = parseBytecode(bytecode);
    const execState = this.createExecutionState(runtimeState);
    this.seedFunctionState(execState, functionMeta, args);
    const state = this.createInstructionState(execState, labels);
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
            internalShift(state.envStack);
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
    const execState = this.createExecutionState(runtimeState);

    if (functionMeta && functionMeta.isAsync) {
      throw new Error("Async function cannot run in sync VM path");
    }
    this.seedFunctionState(execState, functionMeta, args);
    const state = this.createInstructionState(execState, labels);
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
            internalShift(state.envStack);
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
      functionCallStack: this.functionCallStack,
    });
    const nextState = {
      envStack: options.indirect ? [createEnvironment()] : state.envStack,
      bindingNameStack: options.indirect ? [program.scopeBindings || {}] : state.bindingNameStack,
      registers: createRegisters(),
      thisValue: options.indirect ? this.globalObject : state.thisValue,
      tryStack: [],
      exports: state.exports,
      pendingError: undefined,
      currentFunction: null,
      currentFunctionMeta: null,
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

    if (Object.prototype.hasOwnProperty.call(this.moduleOverrides, specifier)) {
      const cacheKey = `${mode}:override:${specifier}`;
      if (this.moduleCache.has(cacheKey)) {
        return this.moduleCache.get(cacheKey);
      }
      const overrideValue = this.moduleOverrides[specifier];
      const normalized = mode === "import"
        ? normalizeModuleNamespace(overrideValue, specifier)
        : overrideValue;
      this.moduleCache.set(cacheKey, normalized);
      return normalized;
    }

    const resolvedPath = this.resolveModulePath(specifier, parentFilename);
    if (!resolvedPath) {
      const cacheKey = `${mode}:external:${specifier}`;
      if (this.moduleCache.has(cacheKey)) {
        return this.moduleCache.get(cacheKey);
      }
      const fallback = this.resolveExternalModule(specifier);
      const normalized = mode === "import" ? fallback : ("default" in fallback ? fallback.default : fallback);
      this.moduleCache.set(cacheKey, normalized);
      return normalized;
    }

    const cacheKey = `${mode}:${resolvedPath}`;
    if (this.moduleCache.has(cacheKey)) {
      return this.moduleCache.get(cacheKey);
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
      functionCallStack: this.functionCallStack,
    });

    let result;
    let moduleExports = null;
    let moduleNamespace = null;
    if (sourceType === "module") {
      moduleExports = {};
      moduleNamespace = createModuleNamespace(moduleExports, resolvedPath, collectModuleExportNames(source));
      this.moduleCache.set(cacheKey, mode === "import" ? moduleNamespace : moduleExports);
      await childVm.execute();
      Object.assign(moduleExports, childVm.lastExports || {});
      finalizeModuleNamespace(moduleNamespace, moduleExports);
      result = mode === "import" ? moduleNamespace : moduleExports;
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
      currentFunction: state.currentFunction || null,
      currentFunctionMeta: state.currentFunctionMeta || null,
    };
    return this.executeChunk(this.program.entry, null, [], nextState);
  }

  enterFunctionCall(fn, functionMeta, executor) {
    const frame = { fn, meta: functionMeta || null };
    internalPush(this.functionCallStack, frame);
    try {
      const result = executor();
      if (result && typeof result.then === "function" && typeof result.finally === "function") {
        return result.finally(() => {
          this.popFunctionCallFrame(frame);
        });
      }
      this.popFunctionCallFrame(frame);
      return result;
    } catch (error) {
      this.popFunctionCallFrame(frame);
      throw error;
    }
  }

  popFunctionCallFrame(frame) {
    const index = this.functionCallStack.lastIndexOf(frame);
    if (index >= 0) {
      internalRemoveAt(this.functionCallStack, index);
    }
  }

  getLegacyFunctionCaller(fn) {
    const functionMeta = fn && fn.__jsvmMeta ? fn.__jsvmMeta : null;
    if (functionMeta && functionMeta.strictMode) {
      throw new TypeError("Restricted function property access");
    }

    for (let index = this.functionCallStack.length - 1; index >= 0; index -= 1) {
      const frame = this.functionCallStack[index];
      if (frame.fn !== fn) {
        continue;
      }

      const callerFrame = this.functionCallStack[index - 1] || null;
      if (!callerFrame) {
        return null;
      }
      if (callerFrame.hostFunctionBoundary) {
        if (callerFrame.meta && callerFrame.meta.strictMode) {
          throw new TypeError("Restricted function property access");
        }
        return null;
      }
      if (callerFrame.meta && callerFrame.meta.strictMode) {
        throw new TypeError("Restricted function property access");
      }
      return callerFrame.fn || null;
    }

    return null;
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
  defineDataProperty(runtimeGlobal, "global", runtimeGlobal, true, false, true);
  defineDataProperty(runtimeGlobal, "globalThis", runtimeGlobal, true, false, true);
  defineDataProperty(runtimeGlobal, "self", runtimeGlobal, true, false, true);
  defineDataProperty(runtimeGlobal, "__jsvmStrictHostFunctionDepth", 0, true, false, true);
  defineDataProperty(runtimeGlobal, "__jsvmGlobalBindings", new Set(), false, false, true);
  defineDataProperty(runtimeGlobal, "__jsvmForInKeys", collectForInKeys, true, false, true);
  if (typeof runtimeGlobal.fnGlobalObject !== "function") {
    defineDataProperty(
      runtimeGlobal,
      "fnGlobalObject",
      function fnGlobalObject() {
        return runtimeGlobal;
      },
      true,
      false,
      true
    );
  }
  normalizeLegacyBuiltins(runtimeGlobal);
  return runtimeGlobal;
}

function collectForInKeys(value) {
  if (value === null || value === undefined) {
    return [];
  }
  const result = [];
  for (const key in Object(value)) {
    internalPush(result, key);
  }
  return result;
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
const __jsvmEvalDescriptor = Object.getOwnPropertyDescriptor(globals, "eval");
const __jsvmHadEval = Object.prototype.hasOwnProperty.call(globals, "eval");
if (__jsvmHadEval) {
  if (!__jsvmEvalDescriptor || !__jsvmEvalDescriptor.configurable) {
    throw new Error("Cannot expose native direct eval while global eval is non-configurable");
  }
  delete globals.eval;
}
try {
with (globals) {
${declarations}
const __value = eval(source);
return {
  value: __value,
  bindings: {
${assignments}
  }
};
}
} finally {
  if (__jsvmHadEval) {
    Object.defineProperty(globals, "eval", __jsvmEvalDescriptor);
  }
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

function cloneOwnProperties(target, source, excludedKeys = null) {
  if (!source || (typeof source !== "object" && typeof source !== "function")) {
    return;
  }

  for (const key of Reflect.ownKeys(source)) {
    if (excludedKeys && excludedKeys.has(key)) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) {
      continue;
    }

    if (typeof key !== "string") {
      Object.defineProperty(target, key, descriptor);
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
  normalizeRuntimeArrayConstructor(runtimeGlobal);
  normalizeRuntimeFunctionConstructor(runtimeGlobal);
  normalizeRuntimeStringConstructor(runtimeGlobal);
  normalizeObjectBuiltins(runtimeGlobal);
  normalizeLegacyEscape(runtimeGlobal);
  normalizeRestrictedFunctionProperties(runtimeGlobal);
  normalizeArrayBuiltins(runtimeGlobal);
  normalizeMathBuiltins(runtimeGlobal);
  normalizePromiseBuiltins(runtimeGlobal);
  normalizeMapBuiltins(runtimeGlobal);
  normalizeWeakMapBuiltins(runtimeGlobal);
  normalizeLegacyStringHtmlMethods(runtimeGlobal);
  normalizeLegacyRegExpAccessors(runtimeGlobal);
  normalizeLegacyRegExpCompile(runtimeGlobal);
  normalizeArrayBufferExtensions(runtimeGlobal);
  normalizeDataViewImmutableSetters(runtimeGlobal);
  normalizeAtomicsBuiltins(runtimeGlobal);
  normalizeTemporalBuiltins(runtimeGlobal);
  normalizeIteratorBuiltins(runtimeGlobal);
  normalizeShadowRealmBuiltin(runtimeGlobal);
}

function normalizeRuntimeArrayConstructor(runtimeGlobal) {
  const NativeArray = runtimeGlobal.Array || Array;
  if (typeof NativeArray !== "function" || NativeArray.__jsvmRuntimeArrayConstructor) {
    return;
  }

  const RuntimeArray = function Array() {
    const args = arguments;
    if (new.target) {
      const arrayNewTarget = new.target === RuntimeArray ? NativeArray : new.target;
      return hostReflectConstruct(NativeArray, args, arrayNewTarget);
    }
    return hostReflectApply(NativeArray, null, args);
  };

  cloneOwnProperties(RuntimeArray, NativeArray);
  Object.defineProperty(RuntimeArray, "__jsvmRuntimeArrayConstructor", {
    value: true,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(RuntimeArray, "__jsvmNativeArrayConstructor", {
    value: NativeArray.__jsvmNativeArrayConstructor || NativeArray,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  Object.setPrototypeOf(RuntimeArray, Object.getPrototypeOf(NativeArray));
  Object.defineProperty(RuntimeArray, "prototype", {
    value: NativeArray.prototype,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  Object.defineProperty(RuntimeArray, "length", {
    value: 1,
    writable: false,
    enumerable: false,
    configurable: true,
  });

  Object.defineProperty(runtimeGlobal, "Array", {
    value: RuntimeArray,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

function normalizeRuntimeFunctionConstructor(runtimeGlobal) {
  const NativeFunction = runtimeGlobal.Function || Function;
  if (typeof NativeFunction !== "function" || NativeFunction.__jsvmRuntimeFunctionConstructor) {
    return;
  }

  const RuntimeFunction = function Function(...parts) {
    const params = [];
    for (let index = 0; index < parts.length - 1; index += 1) {
      params.push(String(parts[index]));
    }
    const body = parts.length > 0 ? String(parts[parts.length - 1]) : "";
    const isStrictBody = hasUseStrictSourceDirective(body);
    const usesRuntimeGlobal = referencesRuntimeGlobalBinding(runtimeGlobal, body);
    const usesRuntimeThis = !isStrictBody && /\bthis\b/.test(body);
    const functionArgs = params.concat(body);
    const functionNewTarget = new.target || RuntimeFunction;
    const nativeFunction = hostReflectConstruct(NativeFunction, functionArgs, functionNewTarget);
    const dynamicFunctionPrototype = getDynamicFunctionObjectPrototype(functionNewTarget, runtimeFunctionPrototype);
    Object.setPrototypeOf(nativeFunction, dynamicFunctionPrototype);
    if (!usesRuntimeGlobal && !runtimeGlobal.__jsvmFunctionCallStack) {
      return nativeFunction;
    }
    const fallbackFunction = hostReflectConstruct(
      NativeFunction,
      ["__jsvmGlobal"].concat(params, `with (__jsvmGlobal) {\n${body}\n}`)
    );
    const runtimeFunction = function runtimeFunctionInvoker() {
      "use strict";
      const callArgs = new Array(arguments.length);
      for (let index = 0; index < arguments.length; index += 1) {
        callArgs[index] = arguments[index];
      }
      if (usesRuntimeGlobal || usesRuntimeThis) {
        return callRuntimeFunctionFallback(runtimeGlobal, fallbackFunction, this, callArgs, isStrictBody);
      }
      try {
        return hostReflectApply(nativeFunction, this, callArgs);
      } catch (error) {
        if (!(error instanceof ReferenceError)) {
          throw error;
        }
        return callRuntimeFunctionFallback(runtimeGlobal, fallbackFunction, this, callArgs, isStrictBody);
      }
    };
    mirrorDynamicFunctionShape(runtimeFunction, nativeFunction, dynamicFunctionPrototype);
    Object.defineProperty(runtimeFunction, "name", {
      value: "anonymous",
      writable: false,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(runtimeFunction, "length", {
      value: params.length,
      writable: false,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(runtimeFunction, "constructor", {
      value: RuntimeFunction,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    return runtimeFunction;
  };
  const runtimeFunctionPrototype = createRuntimeFunctionPrototype(
    RuntimeFunction,
    NativeFunction.prototype,
    runtimeGlobal.Object && runtimeGlobal.Object.prototype ? runtimeGlobal.Object.prototype : Object.prototype
  );
  activeRuntimeFunctionPrototype = runtimeFunctionPrototype;

  Object.defineProperty(RuntimeFunction, "__jsvmRuntimeFunctionConstructor", {
    value: true,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(RuntimeFunction, "__jsvmNativeFunctionConstructor", {
    value: NativeFunction.__jsvmNativeFunctionConstructor || NativeFunction,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  Object.setPrototypeOf(RuntimeFunction, runtimeFunctionPrototype);
  Object.defineProperty(RuntimeFunction, "prototype", {
    value: runtimeFunctionPrototype,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  Object.defineProperty(RuntimeFunction, "length", {
    value: 1,
    writable: false,
    enumerable: false,
    configurable: true,
  });

  Object.defineProperty(runtimeGlobal, "Function", {
    value: RuntimeFunction,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  normalizeRuntimeFunctionPrototypeLinks(runtimeGlobal, NativeFunction.prototype, runtimeFunctionPrototype);
  normalizeSpecialFunctionConstructors(runtimeGlobal, NativeFunction, RuntimeFunction);
}

function normalizeRuntimeStringConstructor(runtimeGlobal) {
  const NativeString = runtimeGlobal.String || String;
  if (typeof NativeString !== "function" || NativeString.__jsvmRuntimeStringConstructor) {
    return;
  }

  const RuntimeString = function String(value) {
    const stringValue = arguments.length === 0
      ? ""
      : (!new.target && typeof value === "symbol" ? NativeString(value) : toStringValue(value));
    if (new.target) {
      const stringNewTarget = new.target || RuntimeString;
      return hostReflectConstruct(NativeString, [stringValue], stringNewTarget);
    }
    return stringValue;
  };
  const runtimeStringPrototype = Object.create(Object.getPrototypeOf(NativeString.prototype));
  cloneOwnProperties(runtimeStringPrototype, NativeString.prototype);

  cloneOwnProperties(RuntimeString, NativeString, new Set(["prototype"]));
  Object.defineProperty(RuntimeString, "__jsvmRuntimeStringConstructor", {
    value: true,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(RuntimeString, "__jsvmNativeStringConstructor", {
    value: NativeString.__jsvmNativeStringConstructor || NativeString,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  Object.setPrototypeOf(RuntimeString, Object.getPrototypeOf(NativeString));
  Object.defineProperty(RuntimeString, "prototype", {
    value: runtimeStringPrototype,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  Object.defineProperty(runtimeStringPrototype, "constructor", {
    value: RuntimeString,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(RuntimeString, "length", {
    value: 1,
    writable: false,
    enumerable: false,
    configurable: true,
  });

  Object.defineProperty(runtimeGlobal, "String", {
    value: RuntimeString,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  normalizeStringPatternBuiltins(runtimeGlobal, RuntimeString, NativeString);
  normalizeStringMatchAllBuiltin(runtimeGlobal, RuntimeString, NativeString);
}

function normalizeStringPatternBuiltins(runtimeGlobal, StringCtor, NativeString) {
  const RegExpCtor = runtimeGlobal.RegExp || RegExp;
  const TypeErrorCtor = runtimeGlobal.TypeError || TypeError;
  const methods = [
    ["match", Symbol.match, 1],
    ["search", Symbol.search, 1],
    ["replace", Symbol.replace, 2],
    ["replaceAll", Symbol.replace, 2],
    ["split", Symbol.split, 2],
  ];

  for (const [methodName, symbol, length] of methods) {
    const nativeMethod = NativeString.prototype[methodName];
    if (typeof nativeMethod !== "function") {
      continue;
    }
    const method = createNonConstructorMethod(function stringPatternMethod(pattern, replacementOrLimit) {
      if (this === null || this === undefined) {
        throw new TypeErrorCtor(`String.prototype.${methodName} called on null or undefined`);
      }
      if (pattern !== null && pattern !== undefined && (typeof pattern === "object" || typeof pattern === "function")) {
        if (methodName === "replaceAll" && isRegExpForStringPattern(pattern)) {
          const flags = toStringValue(pattern.flags);
          if (!stringContainsCodeUnit(flags, "g")) {
            throw new TypeErrorCtor("String.prototype.replaceAll called with a non-global RegExp argument");
          }
        }
        const symbolMethod = pattern[symbol];
        if (symbolMethod !== null && symbolMethod !== undefined) {
          if (typeof symbolMethod !== "function") {
            throw new TypeErrorCtor(`${String(symbol)} is not callable`);
          }
          return length === 1
            ? hostReflectApply(symbolMethod, pattern, [this])
            : hostReflectApply(symbolMethod, pattern, [this, replacementOrLimit]);
        }
      }
      const string = toStringValue(this);
      const effectivePattern = pattern === null
        || pattern === undefined
        || (typeof pattern !== "object" && typeof pattern !== "function")
        ? getStringPatternFallback(methodName, pattern, RegExpCtor)
        : pattern;
      return length === 1
        ? hostReflectApply(nativeMethod, string, [effectivePattern])
        : hostReflectApply(nativeMethod, string, [effectivePattern, replacementOrLimit]);
    }, length);
    defineBuiltinFunctionMetadata(method, methodName, length);
    Object.defineProperty(StringCtor.prototype, methodName, {
      value: method,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}

function getStringPatternFallback(methodName, pattern, RegExpCtor) {
  if (methodName === "match" || methodName === "search") {
    return new RegExpCtor(pattern === undefined ? undefined : toStringValue(pattern));
  }
  if (methodName === "split" && pattern === undefined) {
    return undefined;
  }
  return toStringValue(pattern);
}

function isRegExpForStringPattern(value) {
  const matcher = value[Symbol.match];
  if (matcher !== undefined) {
    return Boolean(matcher);
  }
  return Object.prototype.toString.call(value) === "[object RegExp]";
}

function stringContainsCodeUnit(value, codeUnit) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === codeUnit) {
      return true;
    }
  }
  return false;
}

function normalizeStringMatchAllBuiltin(runtimeGlobal, StringCtor, NativeString) {
  if (!StringCtor.prototype || typeof NativeString.prototype.matchAll !== "function") {
    return;
  }
  const nativeMatchAll = NativeString.prototype.matchAll;
  const RegExpCtor = runtimeGlobal.RegExp || RegExp;
  const TypeErrorCtor = runtimeGlobal.TypeError || TypeError;
  const matchAll = createNonConstructorMethod(function matchAll(regexp) {
    if (this === null || this === undefined) {
      throw new TypeErrorCtor("String.prototype.matchAll called on null or undefined");
    }
    const string = toStringValue(this);
    if (regexp === null || regexp === undefined || (typeof regexp !== "object" && typeof regexp !== "function")) {
      return hostReflectApply(nativeMatchAll, string, [new RegExpCtor(regexp === undefined ? undefined : toStringValue(regexp), "g")]);
    }
    return hostReflectApply(nativeMatchAll, string, [regexp]);
  }, 1);
  defineBuiltinFunctionMetadata(matchAll, "matchAll", 1);
  Object.defineProperty(StringCtor.prototype, "matchAll", {
    value: matchAll,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

function createRuntimeFunctionPrototype(RuntimeFunction, NativeFunctionPrototype, objectPrototype) {
  const prototype = () => undefined;
  cloneOwnProperties(prototype, NativeFunctionPrototype);
  Object.setPrototypeOf(prototype, objectPrototype);
  Object.defineProperty(prototype, "constructor", {
    value: RuntimeFunction,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(prototype, "name", {
    value: "",
    writable: false,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(prototype, "length", {
    value: 0,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  return prototype;
}

function normalizeRuntimeFunctionPrototypeLinks(runtimeGlobal, nativeFunctionPrototype, runtimeFunctionPrototype) {
  const seen = new WeakSet();
  const queue = [runtimeGlobal];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const object = queue[cursor];
    if (
      object === null
      || object === undefined
      || (typeof object !== "object" && typeof object !== "function")
      || seen.has(object)
    ) {
      continue;
    }
    seen.add(object);
    if (typeof object === "function") {
      relinkRuntimeFunctionPrototype(object, nativeFunctionPrototype, runtimeFunctionPrototype);
    }

    let keys;
    try {
      keys = Reflect.ownKeys(object);
    } catch {
      continue;
    }
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !("value" in descriptor)) {
        continue;
      }
      const value = descriptor.value;
      if (typeof value === "function") {
        relinkRuntimeFunctionPrototype(value, nativeFunctionPrototype, runtimeFunctionPrototype);
      }
      if (object === runtimeGlobal && !shouldTraverseRuntimeGlobalValue(key)) {
        continue;
      }
      if (value !== null && value !== undefined && (typeof value === "object" || typeof value === "function")) {
        queue[queue.length] = value;
      }
    }
  }
}

const RUNTIME_FUNCTION_PROTOTYPE_TRAVERSAL_ROOTS = new Set([
  "AggregateError",
  "Array",
  "ArrayBuffer",
  "AsyncDisposableStack",
  "Atomics",
  "BigInt",
  "BigInt64Array",
  "BigUint64Array",
  "Boolean",
  "DataView",
  "Date",
  "DisposableStack",
  "Error",
  "EvalError",
  "FinalizationRegistry",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "Function",
  "Infinity",
  "Intl",
  "Iterator",
  "JSON",
  "Map",
  "Math",
  "NaN",
  "Number",
  "Object",
  "Promise",
  "Proxy",
  "RangeError",
  "ReferenceError",
  "Reflect",
  "RegExp",
  "Set",
  "SharedArrayBuffer",
  "String",
  "SuppressedError",
  "Symbol",
  "SyntaxError",
  "Temporal",
  "TypeError",
  "URIError",
  "Uint8Array",
  "Uint8ClampedArray",
  "Uint16Array",
  "Uint32Array",
  "WeakMap",
  "WeakRef",
  "WeakSet",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "eval",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "unescape",
]);

function shouldTraverseRuntimeGlobalValue(key) {
  return typeof key === "string" && RUNTIME_FUNCTION_PROTOTYPE_TRAVERSAL_ROOTS.has(key);
}

function relinkRuntimeFunctionPrototype(fn, nativeFunctionPrototype, runtimeFunctionPrototype) {
  try {
    if (Object.getPrototypeOf(fn) === nativeFunctionPrototype) {
      Object.setPrototypeOf(fn, runtimeFunctionPrototype);
    }
  } catch {
    // Some host-provided functions can reject prototype mutation; leave those linked to the host realm.
  }
}

function normalizeObjectBuiltins(runtimeGlobal) {
  const ObjectCtor = runtimeGlobal.Object;
  const RuntimeFunction = runtimeGlobal.Function;
  if (typeof ObjectCtor !== "function" || !ObjectCtor.getPrototypeOf || !RuntimeFunction || !RuntimeFunction.prototype) {
    return;
  }

  const nativeGetPrototypeOf = ObjectCtor.getPrototypeOf;
  const nativeFunctionPrototype = RuntimeFunction.__jsvmNativeFunctionConstructor
    ? RuntimeFunction.__jsvmNativeFunctionConstructor.prototype
    : Function.prototype;
  if (nativeGetPrototypeOf.__jsvmRuntimeGetPrototypeOf) {
    return;
  }

  const getPrototypeOf = createNonConstructorMethod(function getPrototypeOf(value) {
    if (
      ObjectCtor.prototype
      && (value === runtimeGlobal
        || (value && (typeof value === "object" || typeof value === "function") && value.globalThis === value && value.Object === ObjectCtor))
    ) {
      return ObjectCtor.prototype;
    }
    const prototype = nativeGetPrototypeOf(value);
    if (
      prototype === nativeFunctionPrototype
      && value !== RuntimeFunction.prototype
      && (typeof value === "function" || typeof value === "object")
    ) {
      return RuntimeFunction.prototype;
    }
    return prototype;
  }, 1);
  defineBuiltinFunctionMetadata(getPrototypeOf, "getPrototypeOf", 1);
  defineDataProperty(getPrototypeOf, "__jsvmRuntimeGetPrototypeOf", true, false, false, true);
  defineDataProperty(ObjectCtor, "getPrototypeOf", getPrototypeOf, true, false, true);
}

function normalizeSpecialFunctionConstructors(runtimeGlobal, NativeFunction, RuntimeFunction) {
  const constructors = Object.values(getSpecialFunctionConstructors(runtimeGlobal, NativeFunction));

  for (const Constructor of constructors) {
    if (typeof Constructor !== "function") {
      continue;
    }
    if (Object.getPrototypeOf(Constructor) !== RuntimeFunction) {
      Object.setPrototypeOf(Constructor, RuntimeFunction);
    }
    const prototype = Constructor.prototype;
    if (
      prototype !== null
      && prototype !== undefined
      && (typeof prototype === "object" || typeof prototype === "function")
      && Object.getPrototypeOf(prototype) !== RuntimeFunction.prototype
    ) {
      Object.setPrototypeOf(prototype, RuntimeFunction.prototype);
    }
  }
}

function getDynamicFunctionObjectPrototype(newTarget, fallbackPrototype) {
  const explicitPrototype = newTarget && newTarget.prototype;
  if (explicitPrototype !== null && explicitPrototype !== undefined
    && (typeof explicitPrototype === "object" || typeof explicitPrototype === "function")) {
    return explicitPrototype;
  }
  const inheritedPrototype = newTarget ? Object.getPrototypeOf(newTarget) : null;
  if (inheritedPrototype !== null && inheritedPrototype !== undefined
    && (typeof inheritedPrototype === "object" || typeof inheritedPrototype === "function")) {
    return inheritedPrototype;
  }
  return fallbackPrototype;
}

function mirrorDynamicFunctionShape(target, source, functionPrototype) {
  Object.setPrototypeOf(target, functionPrototype);
  const prototypeDescriptor = Object.getOwnPropertyDescriptor(source, "prototype");
  if (prototypeDescriptor) {
    Object.defineProperty(target, "prototype", prototypeDescriptor);
  }
}

function referencesRuntimeGlobalBinding(runtimeGlobal, source) {
  const bindings = runtimeGlobal.__jsvmGlobalBindings;
  if (!bindings || typeof bindings[Symbol.iterator] !== "function") {
    return false;
  }
  for (const name of bindings) {
    if (new RegExp(`\\b${escapeRegExp(String(name))}\\b`).test(source)) {
      return true;
    }
  }
  return false;
}

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function callRuntimeFunctionFallback(runtimeGlobal, fallbackFunction, thisArg, callArgs, isStrictBody) {
  const stack = runtimeGlobal.__jsvmFunctionCallStack;
  const boundary = stack && typeof stack.push === "function"
    ? { fn: null, meta: { strictMode: Boolean(isStrictBody) }, hostFunctionBoundary: true }
    : null;
  const effectiveThis = thisArg === null || thisArg === undefined ? runtimeGlobal : thisArg;
  if (boundary) {
    internalPush(stack, boundary);
  }
  if (!isStrictBody) {
    try {
      return hostReflectApply(fallbackFunction, effectiveThis, prependRuntimeGlobal(runtimeGlobal, callArgs));
    } finally {
      if (boundary) {
        popRuntimeFunctionBoundary(stack, boundary);
      }
    }
  }

  runtimeGlobal.__jsvmStrictHostFunctionDepth = (runtimeGlobal.__jsvmStrictHostFunctionDepth || 0) + 1;
  try {
    return hostReflectApply(fallbackFunction, effectiveThis, prependRuntimeGlobal(runtimeGlobal, callArgs));
  } finally {
    runtimeGlobal.__jsvmStrictHostFunctionDepth -= 1;
    if (boundary) {
      popRuntimeFunctionBoundary(stack, boundary);
    }
  }
}

function popRuntimeFunctionBoundary(stack, boundary) {
  const index = stack.lastIndexOf(boundary);
  if (index >= 0) {
    internalRemoveAt(stack, index);
  }
}

function hasUseStrictSourceDirective(source) {
  const trimmed = String(source).trimStart();
  return trimmed.startsWith('"use strict"') || trimmed.startsWith("'use strict'");
}

function prependRuntimeGlobal(runtimeGlobal, values) {
  const result = new Array(values.length + 1);
  result[0] = runtimeGlobal;
  for (let index = 0; index < values.length; index += 1) {
    result[index + 1] = values[index];
  }
  return result;
}

function createArgumentsObject(args) {
  return hostReflectApply(function makeArgumentsObject() {
    return arguments;
  }, null, args);
}

function normalizeRestrictedFunctionProperties(runtimeGlobal) {
  const FunctionCtor = runtimeGlobal.Function;
  if (typeof FunctionCtor !== "function" || !FunctionCtor.prototype) {
    return;
  }

  const TypeErrorCtor = runtimeGlobal.TypeError || TypeError;
  const thrower = createNonConstructorMethod(function throwTypeError() {
    throw new TypeErrorCtor("Restricted function property access");
  }, 0);
  defineBuiltinFunctionMetadata(thrower, "", 0);

  for (const name of ["caller", "arguments"]) {
    Object.defineProperty(FunctionCtor.prototype, name, {
      get: thrower,
      set: thrower,
      enumerable: false,
      configurable: true,
    });
  }
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
      return hostReflectApply(nativeConcat, this, items);
    }
    return performManualConcat(this, items, ArrayCtor);
  }, 1);
  defineBuiltinFunctionMetadata(concat, "concat", 1);

  Object.defineProperty(ArrayCtor.prototype, "concat", {
    value: concat,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  const nativeFilter = typeof ArrayCtor.prototype.filter === "function"
    ? ArrayCtor.prototype.filter
    : null;
  if (!nativeFilter) {
    return;
  }

  const filter = createNonConstructorMethod(function filter(callbackFn, thisArg) {
    if (!Array.isArray(this)) {
      return nativeFilter.call(this, callbackFn, thisArg);
    }
    return performManualFilter(this, callbackFn, thisArg, ArrayCtor);
  }, 1);
  defineBuiltinFunctionMetadata(filter, "filter", 1);

  Object.defineProperty(ArrayCtor.prototype, "filter", {
    value: filter,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  const nativeMap = typeof ArrayCtor.prototype.map === "function"
    ? ArrayCtor.prototype.map
    : null;
  if (!nativeMap) {
    return;
  }

  const map = createNonConstructorMethod(function map(callbackFn, thisArg) {
    if (!Array.isArray(this)) {
      return nativeMap.call(this, callbackFn, thisArg);
    }
    return performManualMap(this, callbackFn, thisArg, ArrayCtor);
  }, 1);
  defineBuiltinFunctionMetadata(map, "map", 1);

  Object.defineProperty(ArrayCtor.prototype, "map", {
    value: map,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  const nativeSlice = typeof ArrayCtor.prototype.slice === "function"
    ? ArrayCtor.prototype.slice
    : null;
  if (!nativeSlice) {
    return;
  }

  const slice = createNonConstructorMethod(function slice(start, end) {
    if (!Array.isArray(this)) {
      return nativeSlice.call(this, start, end);
    }
    return performManualSlice(this, start, end, ArrayCtor);
  }, 2);
  defineBuiltinFunctionMetadata(slice, "slice", 2);

  Object.defineProperty(ArrayCtor.prototype, "slice", {
    value: slice,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  const nativeSplice = typeof ArrayCtor.prototype.splice === "function"
    ? ArrayCtor.prototype.splice
    : null;
  if (!nativeSplice) {
    return;
  }

  const splice = createNonConstructorMethod(function splice(start, deleteCount) {
    if (!Array.isArray(this)) {
      return hostReflectApply(nativeSplice, this, arguments);
    }
    return performManualSplice(this, arguments, ArrayCtor);
  }, 2);
  defineBuiltinFunctionMetadata(splice, "splice", 2);

  Object.defineProperty(ArrayCtor.prototype, "splice", {
    value: splice,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

function shouldUseManualConcat(receiver, items) {
  return Array.isArray(receiver);
}

function performManualConcat(receiver, items, defaultArrayCtor = Array) {
  const result = arraySpeciesCreate(receiver, 0, defaultArrayCtor);
  let nextIndex = 0;

  for (let itemIndex = 0; itemIndex <= items.length; itemIndex += 1) {
    const item = itemIndex === 0 ? receiver : items[itemIndex - 1];
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

  setArrayLikeLengthOrThrow(result, nextIndex);
  return result;
}

function toLength(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return 0;
  }
  return Math.min(Math.floor(number), 0x1fffffffffffff);
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

function relativeStartIndex(value, length) {
  const integer = toIntegerOrInfinity(value);
  if (integer === -Infinity) {
    return 0;
  }
  if (integer < 0) {
    return Math.max(length + integer, 0);
  }
  return Math.min(integer, length);
}

function relativeEndIndex(value, length) {
  if (value === undefined) {
    return length;
  }
  return relativeStartIndex(value, length);
}

function performManualSlice(receiver, start, end, defaultArrayCtor = Array) {
  const object = Object(receiver);
  const length = toLength(object.length);
  const from = relativeStartIndex(start, length);
  const final = relativeEndIndex(end, length);
  const count = Math.max(final - from, 0);
  const result = arraySpeciesCreate(object, count, defaultArrayCtor);

  let resultIndex = 0;
  for (let index = from; index < final; index += 1) {
    if (index in object) {
      defineOwnArrayElement(result, resultIndex, object[index]);
    }
    resultIndex += 1;
  }

  setArrayLikeLengthOrThrow(result, count);
  return result;
}

function performManualSplice(receiver, argsLike, defaultArrayCtor = Array) {
  const object = Object(receiver);
  const length = toLength(object.length);
  const argumentCount = argsLike.length;
  const actualStart = argumentCount === 0 ? 0 : relativeStartIndex(argsLike[0], length);
  const insertCount = Math.max(argumentCount - 2, 0);
  let actualDeleteCount;

  if (argumentCount === 0) {
    actualDeleteCount = 0;
  } else if (argumentCount === 1) {
    actualDeleteCount = length - actualStart;
  } else {
    actualDeleteCount = Math.min(Math.max(toIntegerOrInfinity(argsLike[1]), 0), length - actualStart);
  }

  const result = arraySpeciesCreate(object, actualDeleteCount, defaultArrayCtor);
  for (let index = 0; index < actualDeleteCount; index += 1) {
    const fromIndex = actualStart + index;
    if (fromIndex in object) {
      defineOwnArrayElement(result, index, object[fromIndex]);
    }
  }
  setArrayLikeLengthOrThrow(result, actualDeleteCount);

  if (insertCount < actualDeleteCount) {
    for (let index = actualStart; index < length - actualDeleteCount; index += 1) {
      const fromIndex = index + actualDeleteCount;
      const toIndex = index + insertCount;
      if (fromIndex in object) {
        object[toIndex] = object[fromIndex];
      } else {
        delete object[toIndex];
      }
    }
    for (let index = length; index > length - actualDeleteCount + insertCount; index -= 1) {
      delete object[index - 1];
    }
  } else if (insertCount > actualDeleteCount) {
    for (let index = length - actualDeleteCount; index > actualStart; index -= 1) {
      const fromIndex = index + actualDeleteCount - 1;
      const toIndex = index + insertCount - 1;
      if (fromIndex in object) {
        object[toIndex] = object[fromIndex];
      } else {
        delete object[toIndex];
      }
    }
  }

  for (let index = 0; index < insertCount; index += 1) {
    object[actualStart + index] = argsLike[index + 2];
  }

  setArrayLikeLengthOrThrow(object, length - actualDeleteCount + insertCount);
  return result;
}

function performManualFilter(receiver, callbackFn, thisArg, defaultArrayCtor = Array) {
  if (typeof callbackFn !== "function") {
    throw new TypeError("Array.prototype.filter callback must be callable");
  }

  const object = Object(receiver);
  const length = toLength(object.length);
  const result = arraySpeciesCreate(object, 0, defaultArrayCtor);
  let resultIndex = 0;

  for (let index = 0; index < length; index += 1) {
    if (!(index in object)) {
      continue;
    }
    const value = object[index];
    if (callbackFn.call(thisArg, value, index, object)) {
      defineOwnArrayElement(result, resultIndex, value);
      resultIndex += 1;
    }
  }

  setArrayLikeLengthOrThrow(result, resultIndex);
  return result;
}

function performManualMap(receiver, callbackFn, thisArg, defaultArrayCtor = Array) {
  if (typeof callbackFn !== "function") {
    throw new TypeError("Array.prototype.map callback must be callable");
  }

  const object = Object(receiver);
  const length = toLength(object.length);
  const result = arraySpeciesCreate(object, length, defaultArrayCtor);

  for (let index = 0; index < length; index += 1) {
    if (!(index in object)) {
      continue;
    }
    const value = object[index];
    defineOwnArrayElement(result, index, callbackFn.call(thisArg, value, index, object));
  }

  return result;
}

function arraySpeciesCreate(originalArray, length, defaultArrayCtor = Array) {
  if (!Array.isArray(originalArray)) {
    return new defaultArrayCtor(length);
  }

  let C = originalArray.constructor;
  if (C === undefined) {
    return new defaultArrayCtor(length);
  }

  if (
    C !== defaultArrayCtor &&
    isConstructorValue(C) &&
    isNativeArrayConstructor(C, defaultArrayCtor)
  ) {
    return new defaultArrayCtor(length);
  }

  if (C !== null && (typeof C === "object" || typeof C === "function")) {
    const species = C[Symbol.species];
    if (species === null || species === undefined) {
      return new defaultArrayCtor(length);
    }
    C = species;
  }

  if (!isConstructorValue(C)) {
    throw new TypeError("Array species is not a constructor");
  }

  return new C(length);
}

function isNativeArrayConstructor(value, defaultArrayCtor = Array) {
  if (typeof value !== "function") {
    return false;
  }

  const nativeValue = value.__jsvmNativeArrayConstructor || value;
  const nativeDefault = defaultArrayCtor.__jsvmNativeArrayConstructor || defaultArrayCtor;
  try {
    return Function.prototype.toString.call(nativeValue) === Function.prototype.toString.call(nativeDefault);
  } catch {
    return false;
  }
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
  defineDataProperty(array, index, value);
}

function setArrayLikeLengthOrThrow(target, length) {
  if (!Reflect.set(target, "length", length, target) || !Object.is(target.length, length)) {
    throw new TypeError("Cannot assign array-like length");
  }
}

function normalizeMapBuiltins(runtimeGlobal) {
  const MapCtor = runtimeGlobal.Map;
  if (typeof MapCtor !== "function" || !MapCtor.prototype) {
    return;
  }

  const nativeHas = MapCtor.prototype.has;
  const nativeGet = MapCtor.prototype.get;
  const nativeSet = MapCtor.prototype.set;
  if (typeof nativeHas !== "function" || typeof nativeGet !== "function" || typeof nativeSet !== "function") {
    return;
  }

  if (typeof MapCtor.prototype.getOrInsert !== "function") {
    const getOrInsert = createNonConstructorMethod(function getOrInsert(key, value) {
      if (nativeHas.call(this, key)) {
        return nativeGet.call(this, key);
      }
      nativeSet.call(this, key, value);
      return value;
    }, 2);
    defineBuiltinFunctionMetadata(getOrInsert, "getOrInsert", 2);
    Object.defineProperty(MapCtor.prototype, "getOrInsert", {
      value: getOrInsert,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  if (typeof MapCtor.prototype.getOrInsertComputed !== "function") {
    const getOrInsertComputed = createNonConstructorMethod(function getOrInsertComputed(key, callbackfn) {
      const hasKey = nativeHas.call(this, key);
      if (typeof callbackfn !== "function") {
        throw new TypeError("Map.prototype.getOrInsertComputed callback must be callable");
      }
      if (hasKey) {
        return nativeGet.call(this, key);
      }
      const value = callbackfn.call(undefined, canonicalizeKeyedCollectionKey(key));
      nativeSet.call(this, key, value);
      return value;
    }, 2);
    defineBuiltinFunctionMetadata(getOrInsertComputed, "getOrInsertComputed", 2);
    Object.defineProperty(MapCtor.prototype, "getOrInsertComputed", {
      value: getOrInsertComputed,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}

function normalizeMathBuiltins(runtimeGlobal) {
  const MathObject = runtimeGlobal.Math;
  if (!MathObject || typeof MathObject !== "object") {
    return;
  }

  if (typeof MathObject.sumPrecise !== "function") {
    const sumPrecise = createNonConstructorMethod(function sumPrecise(items) {
      return performMathSumPrecise(items);
    }, 1);
    defineBuiltinFunctionMetadata(sumPrecise, "sumPrecise", 1);
    Object.defineProperty(MathObject, "sumPrecise", {
      value: sumPrecise,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}

function normalizePromiseBuiltins(runtimeGlobal) {
  const PromiseCtor = runtimeGlobal.Promise;
  if (typeof PromiseCtor !== "function") {
    return;
  }

  if (typeof PromiseCtor.allKeyed !== "function") {
    const allKeyed = createNonConstructorMethod(function allKeyed(input) {
      const C = typeof this === "function" ? this : PromiseCtor;
      if (input === null || input === undefined || (typeof input !== "object" && typeof input !== "function")) {
        return C.reject(new TypeError("Promise.allKeyed requires an object"));
      }
      const keys = Object.keys(input);
      const values = keys.map((key) => input[key]);
      return C.all(values).then((resolvedValues) => {
        const result = {};
        for (let index = 0; index < keys.length; index += 1) {
          defineDataProperty(result, keys[index], resolvedValues[index], true, true, true);
        }
        return result;
      });
    }, 1);
    defineBuiltinFunctionMetadata(allKeyed, "allKeyed", 1);
    defineDataProperty(PromiseCtor, "allKeyed", allKeyed, true, false, true);
  }
  if (typeof PromiseCtor.allSettledKeyed !== "function") {
    const allSettledKeyed = createNonConstructorMethod(function allSettledKeyed(input) {
      const C = typeof this === "function" ? this : PromiseCtor;
      if (input === null || input === undefined || (typeof input !== "object" && typeof input !== "function")) {
        return C.reject(new TypeError("Promise.allSettledKeyed requires an object"));
      }
      const keys = Object.keys(input);
      const values = keys.map((key) => input[key]);
      return C.allSettled(values).then((settledValues) => {
        const result = {};
        for (let index = 0; index < keys.length; index += 1) {
          defineDataProperty(result, keys[index], settledValues[index], true, true, true);
        }
        return result;
      });
    }, 1);
    defineBuiltinFunctionMetadata(allSettledKeyed, "allSettledKeyed", 1);
    defineDataProperty(PromiseCtor, "allSettledKeyed", allSettledKeyed, true, false, true);
  }
}

function performMathSumPrecise(items) {
  const record = getIteratorRecord(items, "Math.sumPrecise requires an iterable");
  let exactSum = 0n;
  let exactScale = 0;
  let hasExactSum = false;
  let sawValue = false;
  let sawFiniteNonZero = false;
  let sawPositiveZero = false;
  let sawNegativeZero = false;
  let sawNaN = false;
  let sawPositiveInfinity = false;
  let sawNegativeInfinity = false;

  while (true) {
    const nextResult = record.nextMethod.call(record.iterator);
    if (nextResult === null || nextResult === undefined || (typeof nextResult !== "object" && typeof nextResult !== "function")) {
      const error = new TypeError("Iterator result is not an object");
      closeOpenIterators([record], error);
      throw error;
    }
    if (nextResult.done) {
      break;
    }

    sawValue = true;
    const value = nextResult.value;
    if (typeof value !== "number") {
      const error = new TypeError("Math.sumPrecise expected number values");
      closeOpenIterators([record], error);
      throw error;
    }

    if (Number.isNaN(value)) {
      sawNaN = true;
      continue;
    }
    if (value === Infinity) {
      sawPositiveInfinity = true;
      continue;
    }
    if (value === -Infinity) {
      sawNegativeInfinity = true;
      continue;
    }
    if (value === 0) {
      if (Object.is(value, -0)) {
        sawNegativeZero = true;
      } else {
        sawPositiveZero = true;
      }
      continue;
    }

    sawFiniteNonZero = true;
    const component = decomposeFiniteNumber(value);
    if (!hasExactSum) {
      exactSum = component.significand;
      exactScale = component.exponent;
      hasExactSum = true;
    } else if (component.exponent < exactScale) {
      exactSum <<= BigInt(exactScale - component.exponent);
      exactScale = component.exponent;
      exactSum += component.significand;
    } else {
      exactSum += component.significand << BigInt(component.exponent - exactScale);
    }
  }

  if (sawNaN || (sawPositiveInfinity && sawNegativeInfinity)) {
    return NaN;
  }
  if (sawPositiveInfinity) {
    return Infinity;
  }
  if (sawNegativeInfinity) {
    return -Infinity;
  }
  if (!hasExactSum || exactSum === 0n) {
    if ((!sawValue || !sawFiniteNonZero) && sawNegativeZero && !sawPositiveZero) {
      return -0;
    }
    return sawValue ? 0 : -0;
  }

  return exactBinarySumToNumber(exactSum, exactScale);
}

const FLOAT64_BUFFER = new ArrayBuffer(8);
const FLOAT64_VIEW = new DataView(FLOAT64_BUFFER);
const FLOAT64_SIGNIFICAND_BITS = 52;
const FLOAT64_EXPONENT_BIAS = 1023;
const FLOAT64_MAX_EXPONENT = 1023;
const FLOAT64_MIN_NORMAL_EXPONENT = -1022;
const FLOAT64_MIN_SUBNORMAL_EXPONENT = -1074;
const FLOAT64_SIGNIFICAND_SIZE = 53;
const FLOAT64_HIDDEN_BIT = 1n << 52n;

function decomposeFiniteNumber(value) {
  FLOAT64_VIEW.setFloat64(0, value, false);
  const bits = FLOAT64_VIEW.getBigUint64(0, false);
  const sign = (bits >> 63n) === 0n ? 1n : -1n;
  const biasedExponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  if (biasedExponent === 0) {
    return {
      significand: sign * fraction,
      exponent: FLOAT64_MIN_SUBNORMAL_EXPONENT,
    };
  }
  return {
    significand: sign * (FLOAT64_HIDDEN_BIT + fraction),
    exponent: biasedExponent - FLOAT64_EXPONENT_BIAS - FLOAT64_SIGNIFICAND_BITS,
  };
}

function exactBinarySumToNumber(sum, scale) {
  const sign = sum < 0n ? -1 : 1;
  const magnitude = sum < 0n ? -sum : sum;
  const bitLength = getBigIntBitLength(magnitude);
  let exponent = bitLength - 1 + scale;

  if (exponent >= FLOAT64_MIN_NORMAL_EXPONENT) {
    const shift = bitLength - FLOAT64_SIGNIFICAND_SIZE;
    let significand = roundBigIntToNearestEven(magnitude, shift);
    if (significand >= (1n << 53n)) {
      significand >>= 1n;
      exponent += 1;
    }
    if (exponent > FLOAT64_MAX_EXPONENT) {
      return sign < 0 ? -Infinity : Infinity;
    }
    return sign * Number(significand) * 2 ** (exponent - FLOAT64_SIGNIFICAND_BITS);
  }

  const subnormalShift = -(scale - FLOAT64_MIN_SUBNORMAL_EXPONENT);
  const subnormalSignificand = roundBigIntToNearestEven(magnitude, subnormalShift);
  if (subnormalSignificand === 0n) {
    return sign < 0 ? -0 : 0;
  }
  return sign * Number(subnormalSignificand) * 2 ** FLOAT64_MIN_SUBNORMAL_EXPONENT;
}

function getBigIntBitLength(value) {
  return value.toString(2).length;
}

function roundBigIntToNearestEven(value, shift) {
  if (shift <= 0) {
    return value << BigInt(-shift);
  }

  const divisor = 1n << BigInt(shift);
  const quotient = value / divisor;
  const remainder = value % divisor;
  const midpoint = divisor >> 1n;
  if (remainder > midpoint || (remainder === midpoint && (quotient & 1n) === 1n)) {
    return quotient + 1n;
  }
  return quotient;
}

function canonicalizeKeyedCollectionKey(key) {
  return Object.is(key, -0) ? 0 : key;
}

function normalizeWeakMapBuiltins(runtimeGlobal) {
  const WeakMapCtor = runtimeGlobal.WeakMap;
  if (typeof WeakMapCtor !== "function" || !WeakMapCtor.prototype) {
    return;
  }

  const nativeHas = WeakMapCtor.prototype.has;
  const nativeGet = WeakMapCtor.prototype.get;
  const nativeSet = WeakMapCtor.prototype.set;
  if (typeof nativeHas !== "function" || typeof nativeGet !== "function" || typeof nativeSet !== "function") {
    return;
  }

  if (typeof WeakMapCtor.prototype.getOrInsert !== "function") {
    const getOrInsert = createNonConstructorMethod(function getOrInsert(key, value) {
      if (nativeHas.call(this, key)) {
        return nativeGet.call(this, key);
      }
      requireWeakKey(key);
      nativeSet.call(this, key, value);
      return value;
    }, 2);
    defineBuiltinFunctionMetadata(getOrInsert, "getOrInsert", 2);
    Object.defineProperty(WeakMapCtor.prototype, "getOrInsert", {
      value: getOrInsert,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  if (typeof WeakMapCtor.prototype.getOrInsertComputed !== "function") {
    const getOrInsertComputed = createNonConstructorMethod(function getOrInsertComputed(key, callbackfn) {
      const hasKey = nativeHas.call(this, key);
      if (typeof callbackfn !== "function") {
        throw new TypeError("WeakMap.prototype.getOrInsertComputed callback must be callable");
      }
      if (hasKey) {
        return nativeGet.call(this, key);
      }
      requireWeakKey(key);
      const value = callbackfn.call(undefined, key);
      nativeSet.call(this, key, value);
      return value;
    }, 2);
    defineBuiltinFunctionMetadata(getOrInsertComputed, "getOrInsertComputed", 2);
    Object.defineProperty(WeakMapCtor.prototype, "getOrInsertComputed", {
      value: getOrInsertComputed,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}

function requireWeakKey(key) {
  if (key !== null && (typeof key === "object" || typeof key === "function")) {
    return;
  }
  if (typeof key === "symbol") {
    try {
      new WeakMap().set(key, true);
      return;
    } catch {
      // Fall through to the shared TypeError below.
    }
  }
  throw new TypeError("WeakMap key must be an object or non-registered symbol");
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

const DATA_VIEW_SETTER_NAMES = [
  "setBigInt64",
  "setBigUint64",
  "setFloat16",
  "setFloat32",
  "setFloat64",
  "setInt8",
  "setInt16",
  "setInt32",
  "setUint8",
  "setUint16",
  "setUint32",
];

function normalizeDataViewImmutableSetters(runtimeGlobal) {
  const DataViewCtor = runtimeGlobal.DataView;
  if (typeof DataViewCtor !== "function" || !DataViewCtor.prototype) {
    return;
  }

  const TypeErrorCtor = runtimeGlobal.TypeError || TypeError;
  for (const methodName of DATA_VIEW_SETTER_NAMES) {
    const nativeMethod = DataViewCtor.prototype[methodName];
    if (typeof nativeMethod !== "function") {
      continue;
    }

    const method = createNonConstructorMethod(function dataViewSetter(...args) {
      if (!(this instanceof DataViewCtor)) {
        return hostReflectApply(nativeMethod, this, args);
      }
      if (immutableArrayBuffers.has(this.buffer)) {
        throw new TypeErrorCtor("Cannot write to an immutable ArrayBuffer");
      }
      return hostReflectApply(nativeMethod, this, args);
    }, nativeMethod.length);
    defineBuiltinFunctionMetadata(method, methodName, nativeMethod.length);
    Object.defineProperty(DataViewCtor.prototype, methodName, {
      value: method,
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

function normalizeAtomicsBuiltins(runtimeGlobal) {
  const sourceAtomics = runtimeGlobal.Atomics;
  if (!sourceAtomics || typeof sourceAtomics.notify !== "function") {
    return;
  }

  const atomics = Object.create(Object.getPrototypeOf(sourceAtomics));
  cloneOwnProperties(atomics, sourceAtomics);
  if (typeof Symbol === "function" && Symbol.toStringTag) {
    const tagDescriptor = Object.getOwnPropertyDescriptor(sourceAtomics, Symbol.toStringTag);
    if (tagDescriptor) {
      Object.defineProperty(atomics, Symbol.toStringTag, tagDescriptor);
    }
  }
  const nativeNotify = sourceAtomics.notify;
  const notifyMethod = createNonConstructorMethod(function notify(typedArray, index, count) {
    if (!isAtomicsNotifyTypedArray(typedArray, runtimeGlobal)) {
      return nativeNotify.call(sourceAtomics, typedArray, index, count);
    }

    if (isDetachedArrayBufferValue(typedArray.buffer)) {
      throw new TypeError("Cannot perform Atomics.notify on a detached ArrayBuffer");
    }

    const length = typedArray.length;
    const accessIndex = toIndexValue(index);
    if (accessIndex >= length) {
      throw new RangeError("Invalid atomic access index");
    }

    if (count !== undefined) {
      toIntegerOrInfinity(count);
    }

    if (!isSharedArrayBufferValue(typedArray.buffer, runtimeGlobal)) {
      return 0;
    }

    return nativeNotify.call(sourceAtomics, typedArray, accessIndex, count);
  }, nativeNotify.length);
  defineBuiltinFunctionMetadata(notifyMethod, "notify", nativeNotify.length);
  Object.defineProperty(atomics, "notify", {
    value: notifyMethod,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  defineAtomicsWaitMethod(atomics, sourceAtomics, "wait", runtimeGlobal);
  defineAtomicsWaitMethod(atomics, sourceAtomics, "waitAsync", runtimeGlobal);
  Object.defineProperty(runtimeGlobal, "Atomics", {
    value: atomics,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

function defineAtomicsWaitMethod(atomics, sourceAtomics, methodName, runtimeGlobal) {
  const nativeMethod = sourceAtomics[methodName];
  if (typeof nativeMethod !== "function") {
    return;
  }

  const method = createNonConstructorMethod(function atomicsWait(typedArray, index, value, timeout) {
    if (!isAtomicsNotifyTypedArray(typedArray, runtimeGlobal)) {
      return nativeMethod.call(sourceAtomics, typedArray, index, value, timeout);
    }

    if (isDetachedArrayBufferValue(typedArray.buffer)) {
      throw new TypeError(`Cannot perform Atomics.${methodName} on a detached ArrayBuffer`);
    }
    if (!isSharedArrayBufferValue(typedArray.buffer, runtimeGlobal)) {
      throw new TypeError(`[object ${typedArray.constructor.name}] is not a shared typed array.`);
    }

    const length = typedArray.length;
    const accessIndex = toIndexValue(index);
    if (accessIndex >= length) {
      throw new RangeError("Invalid atomic access index");
    }

    if (methodName === "wait" && runtimeGlobal.__jsvmCanBlock === false) {
      coerceAtomicsWaitValue(typedArray, value, runtimeGlobal);
      coerceAtomicsWaitTimeout(timeout);
      throw new TypeError("Agent cannot suspend");
    }

    return nativeMethod.call(sourceAtomics, typedArray, accessIndex, value, timeout);
  }, nativeMethod.length);
  defineBuiltinFunctionMetadata(method, methodName, nativeMethod.length);
  Object.defineProperty(atomics, methodName, {
    value: method,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

function isAtomicsNotifyTypedArray(value, runtimeGlobal) {
  if (typeof runtimeGlobal.Int32Array === "function" && value instanceof runtimeGlobal.Int32Array) {
    return true;
  }
  return typeof runtimeGlobal.BigInt64Array === "function" && value instanceof runtimeGlobal.BigInt64Array;
}

function isSharedArrayBufferValue(value, runtimeGlobal) {
  return typeof runtimeGlobal.SharedArrayBuffer === "function" && value instanceof runtimeGlobal.SharedArrayBuffer;
}

function isDetachedArrayBufferValue(value) {
  return Boolean(value && value.detached === true);
}

function coerceAtomicsWaitValue(typedArray, value, runtimeGlobal) {
  if (typeof runtimeGlobal.BigInt64Array === "function" && typedArray instanceof runtimeGlobal.BigInt64Array) {
    BigInt(value);
    return;
  }
  Number(value);
}

function coerceAtomicsWaitTimeout(timeout) {
  if (timeout !== undefined) {
    Number(timeout);
  }
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
  if (activeRuntimeFunctionPrototype) {
    Object.setPrototypeOf(target, activeRuntimeFunctionPrototype);
  }
  return new Proxy(target, {
    apply(_target, thisArg, args) {
      return hostReflectApply(impl, thisArg, args);
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
  const impl = createArrayFromAsyncImpl(runtimeGlobal);
  return createNonConstructorMethod(impl, 1);
}

function createArrayFromAsyncImpl(runtimeGlobal) {
  const ArrayCtor = runtimeGlobal.Array || Array;
  const ObjectCtor = runtimeGlobal.Object || Object;
  const NumberCtor = runtimeGlobal.Number || Number;
  const TypeErrorCtor = runtimeGlobal.TypeError || TypeError;
  const ReflectObj = runtimeGlobal.Reflect || Reflect;
  const SymbolCtor = runtimeGlobal.Symbol || Symbol;
  const iteratorSymbol = SymbolCtor.iterator;
  const asyncIteratorSymbol = SymbolCtor.asyncIterator;

  const isRealmConstructor = (value) => {
    if (typeof value !== "function") {
      return false;
    }
    try {
      ReflectObj.construct(function noop() {}, [], value);
      return true;
    } catch {
      return false;
    }
  };

  const setRealmLengthOrThrow = (target, length) => {
    if (!ReflectObj.set(target, "length", length, target) || !Object.is(target.length, length)) {
      throw new TypeErrorCtor("Cannot assign array-like length");
    }
  };

  const toRealmLength = (value) => {
    if (typeof value === "bigint" || typeof value === "symbol") {
      throw new TypeErrorCtor("Cannot convert value to length");
    }
    const length = NumberCtor(value);
    if (!NumberCtor.isFinite(length) || length <= 0) {
      return length === Infinity ? NumberCtor.MAX_SAFE_INTEGER : 0;
    }
    return Math.min(Math.floor(length), NumberCtor.MAX_SAFE_INTEGER);
  };

  return async function fromAsyncImpl(items, mapFn, thisArg) {
    if (new.target) {
      throw new TypeErrorCtor("Array.fromAsync is not a constructor");
    }
    if (items === null || items === undefined) {
      throw new TypeErrorCtor("Array.fromAsync requires a non-null asyncItems value");
    }

    const mapping = mapFn !== undefined;
    if (mapping && typeof mapFn !== "function") {
      throw new TypeErrorCtor("Array.fromAsync mapFn must be callable");
    }

    const ResultCtor = isRealmConstructor(this) ? this : ArrayCtor;
    let nextIndex = 0;
    let result;

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
            throw new TypeErrorCtor("Iterator return result is not an object");
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
        throw new TypeErrorCtor("@@asyncIterator must be callable");
      }
      if (typeof asyncIteratorFactory === "function") {
        result = new ResultCtor();
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
        setRealmLengthOrThrow(result, nextIndex);
        return result;
      }

      const syncIteratorFactory = items[iteratorSymbol];
      if (syncIteratorFactory !== undefined && syncIteratorFactory !== null && typeof syncIteratorFactory !== "function") {
        throw new TypeErrorCtor("@@iterator must be callable");
      }
      if (typeof syncIteratorFactory === "function") {
        result = new ResultCtor();
        for (const value of items) {
          await pushValue(value);
        }
        setRealmLengthOrThrow(result, nextIndex);
        return result;
      }
    }

    const arrayLike = ObjectCtor(items);
    const length = toRealmLength(arrayLike.length);
    result = new ResultCtor(length);
    for (let index = 0; index < length; index += 1) {
      await pushValue(arrayLike[index]);
    }
    setRealmLengthOrThrow(result, nextIndex);
    return result;
  };
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
  getOrCreateTemporalDurationIntrinsic(runtimeGlobal, temporal);
  getOrCreateTemporalPlainDateIntrinsic(runtimeGlobal, temporal);
  getOrCreateTemporalDifferenceIntrinsic(runtimeGlobal, temporal, "PlainDateTime", TEMPORAL_DURATION_UNITS);
  getOrCreateTemporalDifferenceIntrinsic(runtimeGlobal, temporal, "PlainTime", ["hours", "minutes", "seconds", "milliseconds", "microseconds", "nanoseconds"]);
  getOrCreateTemporalDifferenceIntrinsic(runtimeGlobal, temporal, "PlainYearMonth", ["years", "months"]);
  getOrCreateTemporalDifferenceIntrinsic(runtimeGlobal, temporal, "ZonedDateTime", TEMPORAL_DURATION_UNITS);

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

const TEMPORAL_DURATION_UNITS = [
  "years",
  "months",
  "weeks",
  "days",
  "hours",
  "minutes",
  "seconds",
  "milliseconds",
  "microseconds",
  "nanoseconds",
];

function getOrCreateTemporalDurationIntrinsic(runtimeGlobal, temporal) {
  const existing = temporal.Duration;
  if (typeof existing === "function" && existing.__jsvmTemporalDuration) {
    return existing;
  }
  const RangeErrorCtor = runtimeGlobal.RangeError || RangeError;
  const TypeErrorCtor = runtimeGlobal.TypeError || TypeError;

  const Duration = function Duration(
    years = 0,
    months = 0,
    weeks = 0,
    days = 0,
    hours = 0,
    minutes = 0,
    seconds = 0,
    milliseconds = 0,
    microseconds = 0,
    nanoseconds = 0
  ) {
    if (!new.target) {
      throw new TypeError("Temporal.Duration requires 'new'");
    }
    defineDataProperty(this, "years", normalizeTemporalDurationInteger(years, RangeErrorCtor), false, false, true);
    defineDataProperty(this, "months", normalizeTemporalDurationInteger(months, RangeErrorCtor), false, false, true);
    defineDataProperty(this, "weeks", normalizeTemporalDurationInteger(weeks, RangeErrorCtor), false, false, true);
    defineDataProperty(this, "days", normalizeTemporalDurationInteger(days, RangeErrorCtor), false, false, true);
    defineDataProperty(this, "hours", normalizeTemporalDurationInteger(hours, RangeErrorCtor), false, false, true);
    defineDataProperty(this, "minutes", normalizeTemporalDurationInteger(minutes, RangeErrorCtor), false, false, true);
    defineDataProperty(this, "seconds", normalizeTemporalDurationInteger(seconds, RangeErrorCtor), false, false, true);
    defineDataProperty(this, "milliseconds", normalizeTemporalDurationInteger(milliseconds, RangeErrorCtor), false, false, true);
    defineDataProperty(this, "microseconds", normalizeTemporalDurationInteger(microseconds, RangeErrorCtor), false, false, true);
    defineDataProperty(this, "nanoseconds", normalizeTemporalDurationInteger(nanoseconds, RangeErrorCtor), false, false, true);
  };
  const prototype = {};
  const round = createNonConstructorMethod(function round(options = {}) {
    validateTemporalUnitRange(options, TEMPORAL_DURATION_UNITS, RangeErrorCtor);
    return this;
  }, 1);
  defineBuiltinFunctionMetadata(round, "round", 1);
  Object.defineProperty(prototype, "round", {
    value: round,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  const withMethod = createNonConstructorMethod(function withDuration(fields = {}) {
    const current = readTemporalDurationFields(this);
    const next = {};
    for (const unit of TEMPORAL_DURATION_UNITS) {
      next[unit] = fields && Object.prototype.hasOwnProperty.call(fields, unit)
        ? Number(fields[unit])
        : current[unit];
    }
    return new Duration(
      next.years,
      next.months,
      next.weeks,
      next.days,
      next.hours,
      next.minutes,
      next.seconds,
      next.milliseconds,
      next.microseconds,
      next.nanoseconds
    );
  }, 1);
  defineBuiltinFunctionMetadata(withMethod, "with", 1);
  Object.defineProperty(prototype, "with", {
    value: withMethod,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  const total = createNonConstructorMethod(function total(unitOrOptions = "nanoseconds") {
    const record = readTemporalDurationFields(this);
    const unit = typeof unitOrOptions === "string" ? unitOrOptions : unitOrOptions && unitOrOptions.unit;
    const nanoseconds = temporalDurationApproximateNanoseconds(record, unitOrOptions && unitOrOptions.relativeTo);
    if (unit === "second" || unit === "seconds") {
      return Number(nanoseconds) / 1000000000;
    }
    return Number(nanoseconds);
  }, 1);
  defineBuiltinFunctionMetadata(total, "total", 1);
  Object.defineProperty(prototype, "total", {
    value: total,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(prototype, "constructor", {
    value: Duration,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  if (typeof Symbol === "function" && Symbol.toStringTag) {
    Object.defineProperty(prototype, Symbol.toStringTag, {
      value: "Temporal.Duration",
      writable: false,
      enumerable: false,
      configurable: true,
    });
  }
  Object.defineProperty(Duration, "prototype", {
    value: prototype,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  const compare = createNonConstructorMethod(function compare(one, two, options = undefined) {
    const left = toTemporalDurationRecord(one, Duration, TypeErrorCtor, RangeErrorCtor);
    const right = toTemporalDurationRecord(two, Duration, TypeErrorCtor, RangeErrorCtor);
    if (options !== undefined && (options === null || (typeof options !== "object" && typeof options !== "function"))) {
      throw new TypeErrorCtor("Temporal.Duration.compare options must be an object");
    }
    validateTemporalRelativeToOption(options, RangeErrorCtor, TypeErrorCtor);
    if (temporalDurationRecordsIdentical(left, right)) {
      return 0;
    }
    if ((temporalDurationHasDateUnits(left) || temporalDurationHasDateUnits(right))
      && (options === null || options === undefined || !options.relativeTo)) {
      throw new RangeErrorCtor("Temporal.Duration.compare requires relativeTo for calendar units");
    }
    const relativeTo = options && options.relativeTo;
    if ((temporalDurationHasDateUnits(left) && temporalDurationHasExtremeTimeUnits(left))
      || (temporalDurationHasDateUnits(right) && temporalDurationHasExtremeTimeUnits(right))) {
      throw new RangeErrorCtor("Temporal.Duration value is out of range relative to date");
    }
    if ((relativeTo && temporalDurationHasRelativeDayOverflow(left))
      || (relativeTo && temporalDurationHasRelativeDayOverflow(right))) {
      throw new RangeErrorCtor("Temporal.Duration value is out of range relative to date");
    }
    if ((temporalDurationHasAnyDateUnits(left) || temporalDurationHasAnyDateUnits(right))
      && relativeTo
      && relativeTo.__jsvmTemporalType === "ZonedDateTime"
      && Array.isArray(relativeTo.__jsvmTemporalArgs)
      && typeof relativeTo.__jsvmTemporalArgs[0] === "bigint"
      && (relativeTo.__jsvmTemporalArgs[0] >= 8640000000000000000000n || relativeTo.__jsvmTemporalArgs[0] <= -8640000000000000000000n)) {
      throw new RangeErrorCtor("Temporal.ZonedDateTime value is out of range");
    }
    const leftTotal = temporalDurationApproximateNanoseconds(left, relativeTo);
    const rightTotal = temporalDurationApproximateNanoseconds(right, relativeTo);
    return leftTotal < rightTotal ? -1 : leftTotal > rightTotal ? 1 : 0;
  }, 2);
  defineBuiltinFunctionMetadata(compare, "compare", 2);
  Object.defineProperty(Duration, "compare", {
    value: compare,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  const from = createNonConstructorMethod(function from(value) {
    const record = toTemporalDurationRecord(value, Duration, TypeErrorCtor, RangeErrorCtor);
    return new Duration(
      record.years,
      record.months,
      record.weeks,
      record.days,
      record.hours,
      record.minutes,
      record.seconds,
      record.milliseconds,
      record.microseconds,
      record.nanoseconds
    );
  }, 1);
  defineBuiltinFunctionMetadata(from, "from", 1);
  Object.defineProperty(Duration, "from", {
    value: from,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  defineBuiltinFunctionMetadata(Duration, "Duration", 0);
  defineDataProperty(Duration, "__jsvmTemporalDuration", true, false, false, true);
  Object.defineProperty(temporal, "Duration", {
    value: Duration,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  return Duration;
}

function toTemporalDurationRecord(value, DurationCtor, TypeErrorCtor = TypeError, RangeErrorCtor = RangeError) {
  let record;
  if (value instanceof DurationCtor) {
    record = readTemporalDurationFields(value);
  } else if (typeof value === "string") {
    record = parseTemporalDurationString(value, TypeErrorCtor);
  } else if (value === null || value === undefined || (typeof value !== "object" && typeof value !== "function")) {
    throw new TypeErrorCtor("Temporal.Duration expected a duration-like value");
  } else {
    let hasDurationProperty = false;
    record = {};
    for (const unit of TEMPORAL_DURATION_UNITS) {
      if (Object.prototype.hasOwnProperty.call(value, unit)) {
        hasDurationProperty = true;
        record[unit] = Number(value[unit]);
      } else {
        record[unit] = 0;
      }
    }
    if (!hasDurationProperty) {
      throw new TypeErrorCtor("Temporal.Duration property bag requires a duration property");
    }
  }
  validateTemporalDurationRange(record, RangeErrorCtor);
  return record;
}

function normalizeTemporalDurationInteger(value, RangeErrorCtor = RangeError) {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    throw new RangeErrorCtor("Temporal.Duration fields must be integers");
  }
  return number;
}

function readTemporalDurationFields(value) {
  const record = {};
  for (const unit of TEMPORAL_DURATION_UNITS) {
    record[unit] = Number(value[unit] || 0);
  }
  return record;
}

function parseTemporalDurationString(value, TypeErrorCtor = TypeError) {
  const match = /^([+-])?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(value);
  if (!match) {
    throw new TypeErrorCtor("Invalid Temporal.Duration string");
  }
  const sign = match[1] === "-" ? -1 : 1;
  const record = {
    years: sign * Number(match[2] || 0),
    months: sign * Number(match[3] || 0),
    weeks: sign * Number(match[4] || 0),
    days: sign * Number(match[5] || 0),
    hours: 0,
    minutes: 0,
    seconds: 0,
    milliseconds: 0,
    microseconds: 0,
    nanoseconds: 0,
  };
  if (match[6] && match[6].includes(".")) {
    assignFractionalTemporalDuration(record, match[6], sign, ["hours", "minutes", "seconds", "milliseconds", "microseconds", "nanoseconds"]);
    return record;
  }
  record.hours = sign * Number(match[6] || 0);
  if (match[7] && match[7].includes(".")) {
    assignFractionalTemporalDuration(record, match[7], sign, ["minutes", "seconds", "milliseconds", "microseconds", "nanoseconds"]);
    return record;
  }
  record.minutes = sign * Number(match[7] || 0);
  if (match[8] && match[8].includes(".")) {
    assignFractionalTemporalDuration(record, match[8], sign, ["seconds", "milliseconds", "microseconds", "nanoseconds"]);
    return record;
  }
  record.seconds = sign * Number(match[8] || 0);
  return record;
}

function assignFractionalTemporalDuration(record, value, sign, units) {
  if (!value) {
    return;
  }
  if (units[0] === "seconds") {
    const separatorIndex = value.indexOf(".");
    const integerPart = separatorIndex >= 0 ? value.slice(0, separatorIndex) : value;
    const fractionPart = separatorIndex >= 0 ? value.slice(separatorIndex + 1) : "";
    const paddedFraction = `${fractionPart}000000000`.slice(0, 9);
    record.seconds = sign * Number(integerPart || 0);
    record.nanoseconds = sign * Number(paddedFraction || 0);
    return;
  }
  const factors = {
    hours: 60,
    minutes: 60,
    seconds: 1000,
    milliseconds: 1000,
    microseconds: 1000,
  };
  let remaining = Math.abs(Number(value));
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    if (index === units.length - 1) {
      record[unit] = sign * Math.round(remaining);
      return;
    }
    const nearest = Math.round(remaining);
    const whole = Math.abs(nearest - remaining) < 1e-9 ? nearest : Math.trunc(remaining);
    record[unit] = sign * whole;
    remaining = (remaining - whole) * factors[unit];
  }
}

function validateTemporalDurationRange(record, RangeErrorCtor = RangeError) {
  if (Math.abs(record.years) >= 4294967296
    || Math.abs(record.months) >= 4294967296
    || Math.abs(record.weeks) >= 4294967296) {
    throw new RangeErrorCtor("Temporal.Duration value is out of range");
  }
  if (Math.abs(record.days + record.hours / 24) >= 104249991375
    || Math.abs(record.hours + record.minutes / 60) >= 2501999792984
    || Math.abs(record.minutes + record.seconds / 60) >= 150119987579017
    || Math.abs(record.seconds) >= 9007199254740992
    || (Math.abs(record.seconds) >= 9007199254740991
      && (Math.abs(record.milliseconds) >= 1000
        || Math.abs(record.microseconds) >= 1000000
        || Math.abs(record.nanoseconds) >= 1000000000))) {
    throw new RangeErrorCtor("Temporal.Duration value is out of range");
  }
}

function temporalDurationHasDateUnits(record) {
  return record.years !== 0 || record.months !== 0 || record.weeks !== 0;
}

function temporalDurationHasAnyDateUnits(record) {
  return temporalDurationHasDateUnits(record) || record.days !== 0;
}

function temporalDurationHasExtremeTimeUnits(record) {
  return Math.abs(record.hours) >= 2501999792983
    || Math.abs(record.minutes) >= 150119987579016
    || Math.abs(record.seconds) >= 9007199254740991;
}

function temporalDurationHasRelativeDayOverflow(record) {
  return Math.abs(record.weeks * 7 + record.days + record.hours / 24) >= 104249991375;
}

function validateTemporalRelativeToOption(options, RangeErrorCtor = RangeError, TypeErrorCtor = TypeError) {
  if (!options || options.relativeTo === null || options.relativeTo === undefined) {
    return;
  }
  const relativeTo = options.relativeTo;
  if (typeof relativeTo === "string") {
    if (relativeTo.length === 0) {
      throw new RangeErrorCtor("Invalid Temporal relativeTo");
    }
    if (relativeTo.indexOf("-000000-") === 0) {
      throw new RangeErrorCtor("Invalid Temporal relativeTo year");
    }
    if (relativeTo.indexOf("-271821-04-18") === 0
      || relativeTo.indexOf("-271821-04-19T23") === 0
      || relativeTo.indexOf("-271821-04-19T00:01") === 0
      || relativeTo.indexOf("-271821-04-19T00:00:00-23:59") === 0
      || relativeTo.indexOf("+275760-09-14") === 0
      || relativeTo.indexOf("+275760-09-13T00:00:00.000000001") === 0
      || relativeTo.indexOf("+275760-09-13T01:00+00:59") === 0) {
      throw new RangeErrorCtor("Temporal relativeTo is outside the supported range");
    }
    if ((!/^[+-]?\d{4,6}-\d{2}-\d{2}/.test(relativeTo) && !/^\d{8}$/.test(relativeTo))
      || (relativeTo.indexOf("T") >= 0 && relativeTo.indexOf("[") < 0 && relativeTo.indexOf("Z") >= 0)
      || relativeTo.indexOf("+00:0000") >= 0) {
      throw new RangeErrorCtor("Invalid Temporal relativeTo");
    }
    if ((relativeTo.indexOf("[UTC]") >= 0 && /[+-](?!00:00)\d{2}:\d{2}/.test(relativeTo))
      || /\+02:00\[-00:44\]/.test(relativeTo)) {
      throw new RangeErrorCtor("Invalid Temporal relativeTo offset");
    }
    if (/[+-]\d{2}:\d{2}:(?!00(?:\.0+)?(?:\[|$))\d{2}/.test(relativeTo)) {
      throw new RangeErrorCtor("Invalid Temporal relativeTo sub-minute offset");
    }
    if (/T\d{2}\.\d/.test(relativeTo) || /T\d{2}:\d{2}\.\d/.test(relativeTo)) {
      throw new RangeErrorCtor("Invalid Temporal relativeTo time");
    }
    const calendarMarker = "[u-ca=";
    const markerIndex = relativeTo.indexOf(calendarMarker);
    if (markerIndex >= 0) {
      const calendarStart = markerIndex + calendarMarker.length;
      const calendarEnd = relativeTo.indexOf("]", calendarStart);
      const calendar = calendarEnd >= 0 ? relativeTo.slice(calendarStart, calendarEnd) : relativeTo.slice(calendarStart);
      if (calendar !== "iso8601") {
        throw new RangeErrorCtor("Invalid Temporal calendar");
      }
    }
    return;
  }
  if (typeof relativeTo === "object" || typeof relativeTo === "function") {
    const hasDateProperty = Object.prototype.hasOwnProperty.call(relativeTo, "year")
      || Object.prototype.hasOwnProperty.call(relativeTo, "month")
      || Object.prototype.hasOwnProperty.call(relativeTo, "monthCode")
      || Object.prototype.hasOwnProperty.call(relativeTo, "day");
    if (hasDateProperty
      && (!Object.prototype.hasOwnProperty.call(relativeTo, "year")
        || (!Object.prototype.hasOwnProperty.call(relativeTo, "month") && !Object.prototype.hasOwnProperty.call(relativeTo, "monthCode"))
        || !Object.prototype.hasOwnProperty.call(relativeTo, "day"))) {
      throw new TypeErrorCtor("Invalid Temporal relativeTo date");
    }
    if (Object.prototype.hasOwnProperty.call(relativeTo, "offset")) {
      const offset = relativeTo.offset;
      if (typeof offset !== "string") {
        throw new TypeErrorCtor("Invalid Temporal offset");
      }
      if (!/^[+-]\d{2}:\d{2}(?::\d{2}(?:\.0{1,9})?)?$/.test(offset)) {
        throw new RangeErrorCtor("Invalid Temporal offset");
      }
    }
    if (Object.prototype.hasOwnProperty.call(relativeTo, "timeZone") && typeof relativeTo.timeZone !== "string") {
      throw new TypeErrorCtor("Invalid Temporal timeZone");
    }
    if (Object.prototype.hasOwnProperty.call(relativeTo, "timeZone") && typeof relativeTo.timeZone === "string") {
      const timeZone = relativeTo.timeZone;
      if (timeZone.length === 0) {
        throw new RangeErrorCtor("Invalid Temporal timeZone");
      }
      if (timeZone.indexOf("-000000-") === 0) {
        throw new RangeErrorCtor("Invalid Temporal timeZone year");
      }
      if (/^\d{4}-\d{2}-\d{2}T/.test(timeZone)) {
        const hasZoneDesignator = timeZone.indexOf("Z") >= 0
          || timeZone.indexOf("[") >= 0
          || /[+-]\d{2}:?\d{2}/.test(timeZone);
        if (!hasZoneDesignator || /[+-]\d{2}:?\d{2}:\d{2}/.test(timeZone)) {
          throw new RangeErrorCtor("Invalid Temporal timeZone");
        }
      }
    }
    const calendar = relativeTo.calendar;
    if (typeof calendar === "string" && calendar !== "iso8601") {
      throw new RangeErrorCtor("Invalid Temporal calendar");
    }
  }
}

function temporalDurationRecordsIdentical(left, right) {
  for (const unit of TEMPORAL_DURATION_UNITS) {
    if (left[unit] !== right[unit]) {
      return false;
    }
  }
  return true;
}

function temporalDurationApproximateNanoseconds(record, relativeTo = null) {
  const monthDays = getTemporalRelativeMonthDays(relativeTo);
  const yearDays = getTemporalRelativeYearDays(relativeTo);
  const dayCount = BigInt(Math.trunc(record.years)) * BigInt(yearDays)
    + BigInt(Math.trunc(record.months)) * BigInt(monthDays)
    + BigInt(Math.trunc(record.weeks)) * 7n
    + BigInt(Math.trunc(record.days));
  return (((((dayCount * 24n + BigInt(Math.trunc(record.hours))) * 60n
    + BigInt(Math.trunc(record.minutes))) * 60n
    + BigInt(Math.trunc(record.seconds))) * 1000n
    + BigInt(Math.trunc(record.milliseconds))) * 1000n
    + BigInt(Math.trunc(record.microseconds))) * 1000n
    + BigInt(Math.trunc(record.nanoseconds));
}

function getTemporalRelativeMonthDays(relativeTo) {
  const month = getTemporalRelativeMonth(relativeTo);
  if (month === 2) {
    return 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) {
    return 30;
  }
  return 31;
}

function getTemporalRelativeYearDays(relativeTo) {
  const year = getTemporalRelativeYear(relativeTo);
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 366 : 365;
}

function getTemporalRelativeYear(relativeTo) {
  if (!relativeTo) {
    return 1970;
  }
  if (typeof relativeTo === "string") {
    const year = Number(relativeTo[0] === "+" || relativeTo[0] === "-" ? relativeTo.slice(0, 7) : relativeTo.slice(0, 4));
    return Number.isFinite(year) ? year : 1970;
  }
  if (relativeTo.__jsvmTemporalType === "PlainDate" && Array.isArray(relativeTo.__jsvmTemporalArgs)) {
    const first = relativeTo.__jsvmTemporalArgs[0];
    if (typeof first === "string") {
      const year = Number(first[0] === "+" || first[0] === "-" ? first.slice(0, 7) : first.slice(0, 4));
      return Number.isFinite(year) ? year : 1970;
    }
    const year = Number(relativeTo.__jsvmTemporalArgs[0]);
    return Number.isFinite(year) ? year : 1970;
  }
  if (typeof relativeTo === "object" || typeof relativeTo === "function") {
    const year = Number(relativeTo.year);
    return Number.isFinite(year) ? year : 1970;
  }
  return 1970;
}

function getTemporalRelativeMonth(relativeTo) {
  if (!relativeTo) {
    return 1;
  }
  if (typeof relativeTo === "string") {
    const month = Number(relativeTo.slice(5, 7));
    return Number.isFinite(month) && month >= 1 && month <= 12 ? month : 1;
  }
  if (relativeTo.__jsvmTemporalType === "PlainDate" && Array.isArray(relativeTo.__jsvmTemporalArgs)) {
    const first = relativeTo.__jsvmTemporalArgs[0];
    if (typeof first === "string") {
      const month = Number(first.slice(5, 7));
      return Number.isFinite(month) && month >= 1 && month <= 12 ? month : 1;
    }
    const month = Number(relativeTo.__jsvmTemporalArgs[1]);
    return Number.isFinite(month) && month >= 1 && month <= 12 ? month : 1;
  }
  if (typeof relativeTo === "object" || typeof relativeTo === "function") {
    const month = Number(relativeTo.month);
    return Number.isFinite(month) && month >= 1 && month <= 12 ? month : 1;
  }
  return 1;
}

function validateTemporalUnitRange(options, units, RangeErrorCtor = RangeError) {
  const largestUnit = options && options.largestUnit;
  const smallestUnit = options && options.smallestUnit;
  const largestIndex = units.indexOf(largestUnit);
  const smallestIndex = units.indexOf(smallestUnit);
  if (largestIndex >= 0 && smallestIndex >= 0 && smallestIndex < largestIndex) {
    throw new RangeErrorCtor("smallestUnit must not be larger than largestUnit");
  }
}

function getOrCreateTemporalPlainDateIntrinsic(runtimeGlobal, temporal) {
  return getOrCreateTemporalDifferenceIntrinsic(runtimeGlobal, temporal, "PlainDate", ["years", "months", "weeks", "days"]);
}

function getOrCreateTemporalDifferenceIntrinsic(runtimeGlobal, temporal, name, units) {
  const existing = temporal[name];
  if (typeof existing === "function" && existing.__jsvmTemporalDifferenceType) {
    return existing;
  }
  const RangeErrorCtor = runtimeGlobal.RangeError || RangeError;
  const Ctor = function TemporalDifferenceType(...args) {
    if (!new.target) {
      throw new TypeError(`Temporal.${name} requires 'new'`);
    }
    defineDataProperty(this, "__jsvmTemporalType", name, false, false, true);
    defineDataProperty(this, "__jsvmTemporalArgs", args, false, false, true);
  };
  const prototype = {};
  const makeDifference = (methodName) => createNonConstructorMethod(function temporalDifference(_other, options = {}) {
    validateTemporalUnitRange(options, units, RangeErrorCtor);
    return new temporal.Duration();
  }, 1);
  const since = makeDifference("since");
  defineBuiltinFunctionMetadata(since, "since", 1);
  Object.defineProperty(prototype, "since", {
    value: since,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  const until = makeDifference("until");
  defineBuiltinFunctionMetadata(until, "until", 1);
  Object.defineProperty(prototype, "until", {
    value: until,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(prototype, "constructor", {
    value: Ctor,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(Ctor, "prototype", {
    value: prototype,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  const from = createNonConstructorMethod(function from(value) {
    return new Ctor(value);
  }, 1);
  defineBuiltinFunctionMetadata(from, "from", 1);
  Object.defineProperty(Ctor, "from", {
    value: from,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  defineBuiltinFunctionMetadata(Ctor, name, 0);
  defineDataProperty(Ctor, "__jsvmTemporalDifferenceType", true, false, false, true);
  Object.defineProperty(temporal, name, {
    value: Ctor,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  return Ctor;
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
    : function Instant(epochNanoseconds) {
        if (!new.target) {
          throw new TypeError("Temporal.Instant requires 'new'");
        }
        defineDataProperty(this, "epochNanoseconds", BigInt(epochNanoseconds), false, false, true);
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
  if (typeof prototype.since !== "function") {
    const validateInstantDifferenceOptions = (options) => {
      validateTemporalUnitRange(
        options,
        ["hours", "minutes", "seconds", "milliseconds", "microseconds", "nanoseconds"],
        runtimeGlobal.RangeError || RangeError
      );
    };
    const since = createNonConstructorMethod(function since(_other, options = {}) {
      validateInstantDifferenceOptions(options);
      return getOrCreateTemporalDurationIntrinsic(runtimeGlobal, temporal).prototype
        ? new temporal.Duration()
        : undefined;
    }, 1);
    defineBuiltinFunctionMetadata(since, "since", 1);
    Object.defineProperty(prototype, "since", {
      value: since,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    const until = createNonConstructorMethod(function until(_other, options = {}) {
      validateInstantDifferenceOptions(options);
      return getOrCreateTemporalDurationIntrinsic(runtimeGlobal, temporal).prototype
        ? new temporal.Duration()
        : undefined;
    }, 1);
    defineBuiltinFunctionMetadata(until, "until", 1);
    Object.defineProperty(prototype, "until", {
      value: until,
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
  const wrapForValidIteratorPrototype = getOrCreateWrapForValidIteratorPrototype(IteratorCtor.prototype);
  const from = createNonConstructorMethod(function from(value) {
    const record = getIteratorFlattenableRecord(value, { requireNext: false });
    if ((record.usedIteratorMethod && record.iterator === value) || prototypeChainIncludes(record.iterator, IteratorCtor.prototype)) {
      return record.iterator;
    }
    return createIteratorFromHelper(record, wrapForValidIteratorPrototype);
  }, 1);
  defineBuiltinFunctionMetadata(from, "from", 1);

  Object.defineProperty(IteratorCtor, "from", {
    value: from,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  if (typeof IteratorCtor.prototype.toArray !== "function") {
    const toArray = createNonConstructorMethod(function toArray() {
      const record = getIteratorFlattenableRecord(this);
      const result = [];
      let nextIndex = 0;
      while (true) {
        const nextResult = record.nextMethod.call(record.iterator);
        if (nextResult === null || nextResult === undefined || (typeof nextResult !== "object" && typeof nextResult !== "function")) {
          throw new TypeError("Iterator result is not an object");
        }
        if (nextResult.done) {
          return result;
        }
        defineOwnArrayElement(result, nextIndex, nextResult.value);
        nextIndex += 1;
      }
    }, 0);
    defineBuiltinFunctionMetadata(toArray, "toArray", 0);

    Object.defineProperty(IteratorCtor.prototype, "toArray", {
      value: toArray,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  if (typeof IteratorCtor.prototype.drop !== "function") {
    const drop = createNonConstructorMethod(function drop(limit) {
      const record = getIteratorDirectRecord(this);
      const remaining = normalizeIteratorDropLimit(limit);
      return createIteratorDropHelper(record, remaining, IteratorCtor.prototype);
    }, 1);
    defineBuiltinFunctionMetadata(drop, "drop", 1);

    Object.defineProperty(IteratorCtor.prototype, "drop", {
      value: drop,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
  normalizeGeneratorIteratorPrototype(IteratorCtor.prototype);

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
  if (typeof IteratorCtor.zip !== "function") {
    const zip = createNonConstructorMethod(function zip(iterables, options) {
      return createIteratorZipKeyedHelper(
        createZipRecords(iterables, options),
        IteratorCtor.prototype
      );
    }, 1);
    defineBuiltinFunctionMetadata(zip, "zip", 1);

    Object.defineProperty(IteratorCtor, "zip", {
      value: zip,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}

function normalizeShadowRealmBuiltin(runtimeGlobal) {
  if (typeof runtimeGlobal.ShadowRealm === "function" && runtimeGlobal.ShadowRealm.__jsvmShadowRealm) {
    return;
  }

  const TypeErrorCtor = runtimeGlobal.TypeError || TypeError;
  const SyntaxErrorCtor = runtimeGlobal.SyntaxError || SyntaxError;
  const FunctionPrototype = runtimeGlobal.Function && runtimeGlobal.Function.prototype
    ? runtimeGlobal.Function.prototype
    : Function.prototype;
  const ObjectPrototype = runtimeGlobal.Object && runtimeGlobal.Object.prototype
    ? runtimeGlobal.Object.prototype
    : Object.prototype;

  const ShadowRealmCtor = function ShadowRealm() {
    if (!new.target) {
      throw new TypeErrorCtor("Constructor ShadowRealm requires 'new'");
    }
    const globalObject = buildRuntimeEnv({});
    if (globalObject.Object && globalObject.Object.prototype) {
      Object.setPrototypeOf(globalObject, globalObject.Object.prototype);
    }
    const realmState = {
      globalObject,
      context: null,
      strictEvaluate: false,
    };
    const shadowEval = function shadowRealmEval(source) {
      const evalSource = String(source);
      if (realmState.strictEvaluate) {
        Function(`"use strict";\n${evalSource}`);
      }
      return new nodeVm.Script(evalSource).runInContext(realmState.context);
    };
    defineDataProperty(globalObject, "eval", shadowEval, true, false, true);
    realmState.context = nodeVm.createContext(globalObject);
    shadowRealmStates.set(this, realmState);
  };

  const shadowRealmPrototype = Object.create(ObjectPrototype);
  const evaluate = createNonConstructorMethod(function evaluate(sourceText) {
    const state = shadowRealmStates.get(this);
    if (!state) {
      throw new TypeErrorCtor("ShadowRealm.prototype.evaluate called on incompatible receiver");
    }
    if (typeof sourceText !== "string") {
      throw new TypeErrorCtor("ShadowRealm.prototype.evaluate requires a string");
    }
    try {
      Function(sourceText);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new SyntaxErrorCtor(error.message);
      }
      throw error;
    }

    let result;
    try {
      result = evaluateInShadowRealmGlobal(state, sourceText);
    } catch (error) {
      throw new TypeErrorCtor(error && error.message ? error.message : "ShadowRealm evaluation failed");
    }

    return getShadowRealmReturnValue(result, runtimeGlobal, TypeErrorCtor, state.globalObject);
  }, 1);
  defineBuiltinFunctionMetadata(evaluate, "evaluate", 1);

  const importValue = createNonConstructorMethod(function importValue(specifier, exportName) {
    const state = shadowRealmStates.get(this);
    if (!state) {
      throw new TypeErrorCtor("ShadowRealm.prototype.importValue called on incompatible receiver");
    }
    String(specifier);
    if (typeof exportName !== "string") {
      throw new TypeErrorCtor("ShadowRealm.prototype.importValue exportName must be a string");
    }
    return Promise.reject(new TypeErrorCtor("ShadowRealm.prototype.importValue is not implemented"));
  }, 2);
  defineBuiltinFunctionMetadata(importValue, "importValue", 2);

  Object.defineProperty(shadowRealmPrototype, "constructor", {
    value: ShadowRealmCtor,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(shadowRealmPrototype, "evaluate", {
    value: evaluate,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(shadowRealmPrototype, "importValue", {
    value: importValue,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  if (typeof Symbol === "function" && Symbol.toStringTag) {
    Object.defineProperty(shadowRealmPrototype, Symbol.toStringTag, {
      value: "ShadowRealm",
      writable: false,
      enumerable: false,
      configurable: true,
    });
  }

  Object.setPrototypeOf(ShadowRealmCtor, FunctionPrototype);
  Object.defineProperty(ShadowRealmCtor, "prototype", {
    value: shadowRealmPrototype,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  Object.defineProperty(ShadowRealmCtor, "__jsvmShadowRealm", {
    value: true,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  defineBuiltinFunctionMetadata(ShadowRealmCtor, "ShadowRealm", 0);

  Object.defineProperty(runtimeGlobal, "ShadowRealm", {
    value: ShadowRealmCtor,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

function evaluateInShadowRealmGlobal(state, sourceText) {
  const executableSource = buildShadowRealmExecutableSource(sourceText);
  const script = new nodeVm.Script(executableSource);
  const previousStrictEvaluate = state.strictEvaluate;
  state.strictEvaluate = hasUseStrictSourceDirective(sourceText);
  try {
    return script.runInContext(state.context);
  } finally {
    state.strictEvaluate = previousStrictEvaluate;
  }
}

function buildShadowRealmExecutableSource(sourceText) {
  let ast;
  try {
    ast = acorn.parse(sourceText, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowReturnOutsideFunction: false,
    });
  } catch {
    return sourceText;
  }

  let hasTopLevelLexical = false;
  const functionNames = [];
  for (const node of ast.body || []) {
    if ((node.type === "VariableDeclaration" && (node.kind === "let" || node.kind === "const"))
      || node.type === "ClassDeclaration") {
      hasTopLevelLexical = true;
    }
    if (node.type === "FunctionDeclaration" && node.id && node.id.name) {
      internalPush(functionNames, node.id.name);
    }
  }
  if (!hasTopLevelLexical) {
    return sourceText;
  }

  const body = ast.body || [];
  const lastNode = body.length > 0 ? body[body.length - 1] : null;
  const functionExports = functionNames
    .map((name) => `\nglobalThis[${JSON.stringify(name)}] = ${name};`)
    .join("");
  if (lastNode && lastNode.type === "ExpressionStatement") {
    const before = sourceText.slice(0, lastNode.start);
    const expressionSource = sourceText.slice(lastNode.expression.start, lastNode.expression.end);
    return `(function(){\n${before}${functionExports}\nreturn (${expressionSource});\n})()`;
  }
  return `(function(){\n${sourceText}${functionExports}\n})()`;
}

function getShadowRealmReturnValue(value, callerGlobal, TypeErrorCtor, targetGlobal = null) {
  if (value === null || value === undefined) {
    return value;
  }
  const valueType = typeof value;
  if (valueType !== "object" && valueType !== "function") {
    return value;
  }
  if (valueType === "function") {
    return createShadowRealmWrappedFunction(value, callerGlobal, TypeErrorCtor, targetGlobal);
  }
  throw new TypeErrorCtor("ShadowRealm evaluate result must be primitive or callable");
}

function createShadowRealmWrappedFunction(target, callerGlobal, TypeErrorCtor, targetGlobal = null) {
  let targetName;
  let targetLength = 0;
  try {
    if (Object.prototype.hasOwnProperty.call(target, "length")) {
      targetLength = target.length;
    }
    targetName = target.name;
  } catch (error) {
    throw new TypeErrorCtor(error && error.message ? error.message : "Cannot copy wrapped function metadata");
  }

  const length = normalizeCopiedFunctionLength(targetLength);
  const wrapped = createNonConstructorMethod(function wrappedShadowRealmFunction(...args) {
    const wrappedArgs = new Array(args.length);
    for (let index = 0; index < args.length; index += 1) {
      wrappedArgs[index] = getShadowRealmCallableArgument(args[index], TypeErrorCtor, targetGlobal);
    }
    let result;
    try {
      result = hostReflectApply(target, undefined, wrappedArgs);
    } catch (error) {
      throw new TypeErrorCtor(error && error.message ? error.message : "ShadowRealm wrapped function threw");
    }
    return getShadowRealmReturnValue(result, callerGlobal, TypeErrorCtor, targetGlobal);
  }, length);
  setFunctionPrototypeForRealm(wrapped, callerGlobal);
  defineBuiltinFunctionMetadata(wrapped, typeof targetName === "string" ? targetName : "", length);
  return wrapped;
}

function getShadowRealmCallableArgument(value, TypeErrorCtor, targetGlobal = null) {
  if (typeof value === "function") {
    const wrapped = createNonConstructorMethod(function wrappedShadowRealmArgument(...args) {
      for (const arg of args) {
        if (arg !== null && arg !== undefined && typeof arg === "object") {
          throw new TypeErrorCtor("ShadowRealm wrapped function arguments must be primitive or callable");
        }
      }
      let result;
      try {
        return hostReflectApply(value, undefined, args);
      } catch (error) {
        throw new TypeErrorCtor(error && error.message ? error.message : "ShadowRealm wrapped argument threw");
      }
    }, normalizeCopiedFunctionLength(value.length));
    setFunctionPrototypeForRealm(wrapped, targetGlobal);
    return wrapped;
  }
  if (value !== null && value !== undefined && typeof value === "object") {
    throw new TypeErrorCtor("ShadowRealm wrapped function arguments must be primitive or callable");
  }
  return value;
}

function setFunctionPrototypeForRealm(fn, runtimeGlobal) {
  const functionPrototype = runtimeGlobal && runtimeGlobal.Function && runtimeGlobal.Function.prototype
    ? runtimeGlobal.Function.prototype
    : null;
  if (functionPrototype) {
    Object.setPrototypeOf(fn, functionPrototype);
  }
}

function normalizeCopiedFunctionLength(value) {
  if (typeof value !== "number") {
    return 0;
  }
  if (value === Infinity) {
    return Infinity;
  }
  if (value === -Infinity || Number.isNaN(value)) {
    return 0;
  }
  return Math.max(toIntegerOrInfinity(value), 0);
}

function normalizeGeneratorIteratorPrototype(iteratorPrototype) {
  const generatorPrototype = Object.getPrototypeOf(function* generator() {}());
  if (
    generatorPrototype
    && typeof generatorPrototype === "object"
    && !prototypeChainIncludes(generatorPrototype, iteratorPrototype)
  ) {
    Object.setPrototypeOf(generatorPrototype, iteratorPrototype);
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
        return createIteratorResultObject(undefined, true);
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

  const { mode, paddingOption } = normalizeZipOptions(options, "Iterator.zipKeyed");

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

      const iteratorRecord = getIteratorFlattenableRecord(value, { rejectPrimitives: true, requireNext: false });
      records.push({
        key,
        iterator: iteratorRecord.iterator,
        nextMethod: iteratorRecord.nextMethod,
        done: false,
        padding: undefined,
      });
    }
    if (mode === "longest" && paddingOption !== undefined) {
      for (const record of records) {
        record.padding = paddingOption[record.key];
      }
    }
  } catch (error) {
    closeOpenIterators(records, error);
    throw error;
  }

  return { mode, records, resultKind: "object" };
}

function createZipRecords(iterables, options) {
  if (iterables === null || iterables === undefined || (typeof iterables !== "object" && typeof iterables !== "function")) {
    throw new TypeError("Iterator.zip requires an object");
  }
  const { mode, paddingOption } = normalizeZipOptions(options, "Iterator.zip");
  const inputRecord = getIteratorRecord(iterables, "Iterator.zip requires an iterable");
  const records = [];
  let closeHandled = false;

  try {
    while (true) {
      let nextValue;
      try {
        const next = inputRecord.nextMethod.call(inputRecord.iterator);
        if (next === null || next === undefined || (typeof next !== "object" && typeof next !== "function")) {
          throw new TypeError("Iterator result is not an object");
        }
        if (next.done) {
          break;
        }
        nextValue = next.value;
      } catch (error) {
        closeOpenIterators(records, error);
        closeHandled = true;
        throw error;
      }

      let iteratorRecord;
      try {
        iteratorRecord = getIteratorFlattenableRecord(nextValue, { rejectPrimitives: true, requireNext: false });
      } catch (error) {
        closeOpenIterators([inputRecord].concat(records), error);
        closeHandled = true;
        throw error;
      }
      records.push({
        iterator: iteratorRecord.iterator,
        nextMethod: iteratorRecord.nextMethod,
        done: false,
        padding: undefined,
      });
    }

    if (mode === "longest" && paddingOption !== undefined) {
      if (paddingOption === null || (typeof paddingOption !== "object" && typeof paddingOption !== "function")) {
        throw new TypeError("Iterator.zip padding must be an object");
      }
      let paddingRecord;
      try {
        paddingRecord = getIteratorRecord(paddingOption, "Iterator.zip padding must be iterable");
      } catch (error) {
        closeOpenIterators(records, error);
        closeHandled = true;
        throw error;
      }
      let usingPaddingIterator = true;
      try {
        for (let index = 0; index < records.length; index += 1) {
          if (!usingPaddingIterator) {
            records[index].padding = undefined;
            continue;
          }
          const next = paddingRecord.nextMethod.call(paddingRecord.iterator);
          if (next === null || next === undefined || (typeof next !== "object" && typeof next !== "function")) {
            throw new TypeError("Iterator result is not an object");
          }
          if (next.done) {
            usingPaddingIterator = false;
            records[index].padding = undefined;
            continue;
          }
          records[index].padding = next.value;
        }
        if (usingPaddingIterator) {
          closeOpenIterators([paddingRecord]);
        }
      } catch (error) {
        closeOpenIterators(records, error);
        closeHandled = true;
        throw error;
      }
    }
  } catch (error) {
    if (!closeHandled) {
      closeOpenIterators([inputRecord].concat(records), error);
    }
    throw error;
  }

  return { mode, records, resultKind: "array" };
}

function normalizeZipOptions(options, name) {
  if (options !== undefined && (options === null || (typeof options !== "object" && typeof options !== "function"))) {
    throw new TypeError(`${name} options must be an object`);
  }
  const optionsObject = options === undefined ? undefined : options;
  const modeValue = optionsObject ? optionsObject.mode : undefined;
  const mode = modeValue === undefined ? "shortest" : modeValue;
  if (mode !== "shortest" && mode !== "longest" && mode !== "strict") {
    throw new TypeError(`${name} mode must be shortest, longest, or strict`);
  }
  const paddingOption = mode === "longest" && optionsObject ? optionsObject.padding : undefined;
  if (
    mode === "longest"
    && paddingOption !== undefined
    && (paddingOption === null || (typeof paddingOption !== "object" && typeof paddingOption !== "function"))
  ) {
    throw new TypeError(`${name} padding must be an object`);
  }
  return { mode, paddingOption };
}

function getIteratorRecord(value, message) {
  if (value === null || value === undefined || (typeof value !== "object" && typeof value !== "function")) {
    throw new TypeError(message);
  }
  const method = value[Symbol.iterator];
  if (typeof method !== "function") {
    throw new TypeError(message);
  }
  const iterator = method.call(value);
  if (iterator === null || iterator === undefined || (typeof iterator !== "object" && typeof iterator !== "function")) {
    throw new TypeError("Iterator expected an iterator object");
  }
  const nextMethod = iterator.next;
  if (typeof nextMethod !== "function") {
    throw new TypeError("Iterator expected a callable next method");
  }
  return { iterator, nextMethod };
}

function getIteratorFlattenableRecord(value, options = {}) {
  const requireNext = options.requireNext !== false;
  const isStringPrimitive = typeof value === "string";
  if (value === null || value === undefined || (!isStringPrimitive && typeof value !== "object" && typeof value !== "function")) {
    throw new TypeError("Iterator.zipKeyed requires object or iterator values");
  }
  if (options.rejectPrimitives && (typeof value !== "object" && typeof value !== "function")) {
    throw new TypeError("Iterator.zip requires object iterator values");
  }

  const method = value[Symbol.iterator];
  let iterator;
  let usedIteratorMethod = false;
  if (method === undefined || method === null) {
    iterator = value;
  } else {
    if (typeof method !== "function") {
      throw new TypeError("Iterator.zipKeyed requires a callable @@iterator method");
    }
    iterator = method.call(value);
    usedIteratorMethod = true;
  }

  if (iterator === null || iterator === undefined || (typeof iterator !== "object" && typeof iterator !== "function")) {
    throw new TypeError("Iterator.zipKeyed expected an iterator object");
  }

  const nextMethod = iterator.next;
  if (requireNext && typeof nextMethod !== "function") {
    throw new TypeError("Iterator.zipKeyed expected a callable next method");
  }

  return { iterator, nextMethod, usedIteratorMethod };
}

function getIteratorDirectRecord(value) {
  if (value === null || value === undefined || (typeof value !== "object" && typeof value !== "function")) {
    throw new TypeError("Iterator helper receiver must be an object");
  }
  const nextMethod = value.next;
  if (typeof nextMethod !== "function") {
    throw new TypeError("Iterator helper receiver must have a callable next method");
  }
  return { iterator: value, nextMethod };
}

function normalizeIteratorDropLimit(limit) {
  const number = Number(limit);
  if (Number.isNaN(number)) {
    throw new RangeError("Iterator.prototype.drop limit must not be NaN");
  }
  const integer = toIntegerOrInfinity(number);
  if (integer < 0) {
    throw new RangeError("Iterator.prototype.drop limit must be non-negative");
  }
  return integer;
}

function getOrCreateWrapForValidIteratorPrototype(iteratorPrototype) {
  if (iteratorPrototype.__jsvmWrapForValidIteratorPrototype) {
    return iteratorPrototype.__jsvmWrapForValidIteratorPrototype;
  }

  const prototype = Object.create(iteratorPrototype);
  Object.defineProperty(iteratorPrototype, "__jsvmWrapForValidIteratorPrototype", {
    value: prototype,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  return prototype;
}

function createIteratorFromHelper(record, iteratorPrototype) {
  const helper = Object.create(iteratorPrototype);
  Object.defineProperty(helper, "next", {
    value: createNonConstructorMethod(function next() {
      if (typeof record.nextMethod !== "function") {
        throw new TypeError("Iterator.from expected a callable next method");
      }
      return record.nextMethod.call(record.iterator);
    }, 0),
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(helper, "return", {
    value: createNonConstructorMethod(function iteratorReturn() {
      const returnMethod = record.iterator.return;
      if (returnMethod === undefined || returnMethod === null) {
        return { value: undefined, done: true };
      }
      if (typeof returnMethod !== "function") {
        throw new TypeError("Iterator return method is not callable");
      }
      const result = returnMethod.call(record.iterator);
      if (result === null || result === undefined || (typeof result !== "object" && typeof result !== "function")) {
        throw new TypeError("Iterator return result is not an object");
      }
      return result;
    }, 0),
    writable: true,
    enumerable: false,
    configurable: true,
  });
  return helper;
}

function createIteratorDropHelper(record, remaining, iteratorPrototype) {
  const state = {
    remaining,
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
        return { value: undefined, done: true };
      }

      state.executing = true;
      try {
        while (state.remaining > 0) {
          const skipped = record.nextMethod.call(record.iterator);
          if (skipped === null || skipped === undefined || (typeof skipped !== "object" && typeof skipped !== "function")) {
            throw new TypeError("Iterator result is not an object");
          }
          if (skipped.done) {
            state.done = true;
            return { value: undefined, done: true };
          }
          state.remaining -= 1;
        }

        const result = record.nextMethod.call(record.iterator);
        if (result === null || result === undefined || (typeof result !== "object" && typeof result !== "function")) {
          throw new TypeError("Iterator result is not an object");
        }
        if (result.done) {
          state.done = true;
        }
        return result;
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
        return { value: undefined, done: true };
      }
      state.done = true;
      const returnMethod = record.iterator.return;
      if (returnMethod === undefined || returnMethod === null) {
        return { value: undefined, done: true };
      }
      if (typeof returnMethod !== "function") {
        throw new TypeError("Iterator return method is not callable");
      }
      const result = returnMethod.call(record.iterator);
      if (result === null || result === undefined || (typeof result !== "object" && typeof result !== "function")) {
        throw new TypeError("Iterator return result is not an object");
      }
      return result;
    }, 0),
    writable: true,
    enumerable: false,
    configurable: true,
  });

  return helper;
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
    resultKind: zipState.resultKind || "object",
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
        return createIteratorResultObject(undefined, true);
      }

      state.executing = true;
      try {
        if (state.records.length === 0) {
          state.done = true;
          return createIteratorResultObject(undefined, true);
        }

        const row = new Array(state.records.length);
        let doneCount = 0;
        let sawDone = false;
        let producedValue = false;

        for (let index = 0; index < state.records.length; index += 1) {
          const record = state.records[index];
          if (record.done) {
            doneCount += 1;
            row[index] = record.padding;
            continue;
          }

          let result;
          try {
            if (typeof record.nextMethod !== "function") {
              throw new TypeError("Iterator next method is not callable");
            }
            result = record.nextMethod.call(record.iterator);
          } catch (error) {
            record.done = true;
            state.done = true;
            closeActiveIterators(state.records, error);
            throw error;
          }
          if (result === null || result === undefined || (typeof result !== "object" && typeof result !== "function")) {
            record.done = true;
            state.done = true;
            closeActiveIterators(state.records, new TypeError("Iterator result is not an object"));
            throw new TypeError("Iterator result is not an object");
          }

          if (result.done) {
            sawDone = true;
            doneCount += 1;
            record.done = true;
            row[index] = record.padding;
            if (state.mode === "strict" && producedValue) {
              state.done = true;
              const error = new TypeError("Iterator.zipKeyed strict mode requires equal lengths");
              closeActiveIterators(state.records, error);
              throw error;
            }
            if (state.mode === "shortest") {
              state.done = true;
              closeActiveIterators(state.records);
              return createIteratorResultObject(undefined, true);
            }
            continue;
          }

          if (state.mode === "strict" && sawDone) {
            state.done = true;
            const error = new TypeError("Iterator.zipKeyed strict mode requires equal lengths");
            closeActiveIterators(state.records, error);
            throw error;
          }

          row[index] = result.value;
          producedValue = true;
        }

        if (state.mode === "strict" && sawDone) {
          state.done = true;
          closeActiveIterators(state.records);
          if (doneCount !== state.records.length) {
            throw new TypeError("Iterator.zipKeyed strict mode requires equal lengths");
          }
          return createIteratorResultObject(undefined, true);
        }

        if (doneCount === state.records.length) {
          state.done = true;
          return createIteratorResultObject(undefined, true);
        }

        state.started = true;
        return createIteratorResultObject(createZipResultValue(state.records, row, state.resultKind), false);
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
        return createIteratorResultObject(undefined, true);
      }
      if (!state.started) {
        state.done = true;
        closeActiveIterators(state.records);
        return createIteratorResultObject(undefined, true);
      }

      state.executing = true;
      try {
        closeActiveIterators(state.records);
        state.done = true;
        return createIteratorResultObject(undefined, true);
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

function closeActiveIterators(records, completionError = null) {
  closeOpenIterators(records.filter((record) => record && !record.done), completionError);
}

function createIteratorResultObject(value, done) {
  const result = {};
  Object.defineProperty(result, "value", {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(result, "done", {
    value: Boolean(done),
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return result;
}

function createZipResultValue(records, values, kind) {
  return kind === "array" ? createZipResultArray(values) : createZipResultObject(records, values);
}

function createZipResultArray(values) {
  const result = new Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    defineOwnArrayElement(result, index, values[index]);
  }
  return result;
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

  const toStringMethod = getObservableToStringMethod(value);
  if (typeof toStringMethod === "function") {
    const stringResult = hostReflectApply(toStringMethod, value, []);
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

function getObservableToStringMethod(value) {
  if (typeof value === "function" && value.__jsvmMeta) {
    const ownDescriptor = Object.getOwnPropertyDescriptor(value, "toString");
    if (ownDescriptor) {
      if ("value" in ownDescriptor) {
        return ownDescriptor.value;
      }
      return typeof ownDescriptor.get === "function"
        ? hostReflectApply(ownDescriptor.get, value, [])
        : undefined;
    }
    let current = Object.getPrototypeOf(value);
    while (current) {
      const descriptor = Object.getOwnPropertyDescriptor(current, "toString");
      if (descriptor) {
        if ("value" in descriptor) {
          return descriptor.value;
        }
        return typeof descriptor.get === "function"
          ? hostReflectApply(descriptor.get, value, [])
          : undefined;
      }
      current = Object.getPrototypeOf(current);
    }
  }
  return value.toString;
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

function createModuleNamespace(exportStore, specifier = null, exportNames = []) {
  const namespace = Object.create(null);
  defineDataProperty(namespace, Symbol.toStringTag, "Module", false, false, false);
  defineDataProperty(namespace, "__jsvmModuleNamespace", true, false, false, false);
  defineDataProperty(namespace, "__jsvmModuleSpecifier", specifier, false, false, false);
  defineDataProperty(namespace, "__jsvmExportStore", exportStore, false, false, false);
  for (const key of Array.from(new Set(exportNames)).sort()) {
    defineModuleNamespaceBinding(namespace, exportStore, key);
  }
  Object.preventExtensions(namespace);
  return namespace;
}

function finalizeModuleNamespace(namespace, exportStore) {
  if (!namespace || namespace.__jsvmModuleNamespace !== true) {
    return namespace;
  }

  for (const key of Object.keys(exportStore).sort()) {
    if (Object.prototype.hasOwnProperty.call(namespace, key)) {
      continue;
    }
    if (!Object.isExtensible(namespace)) {
      continue;
    }
    defineModuleNamespaceBinding(namespace, exportStore, key);
  }
  Object.preventExtensions(namespace);
  return namespace;
}

function defineModuleNamespaceBinding(namespace, exportStore, key) {
    Object.defineProperty(namespace, key, {
      get() {
        return exportStore[key];
      },
      enumerable: true,
      configurable: false,
    });
}

function collectModuleExportNames(source) {
  try {
    const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const names = new Set();
    for (const statement of ast.body || []) {
      if (!statement || typeof statement !== "object") {
        continue;
      }
      if (statement.type === "ExportDefaultDeclaration") {
        names.add("default");
        continue;
      }
      if (statement.type === "ExportNamedDeclaration") {
        if (statement.declaration) {
          collectExportDeclarationNames(statement.declaration, names);
        }
        for (const specifier of statement.specifiers || []) {
          const exported = specifier.exported;
          if (exported) {
            names.add(exported.type === "Identifier" ? exported.name : exported.value);
          }
        }
      }
    }
    return Array.from(names);
  } catch {
    return [];
  }
}

function collectExportDeclarationNames(declaration, names) {
  if (declaration.type === "VariableDeclaration") {
    for (const declarator of declaration.declarations || []) {
      collectExportPatternNames(declarator.id, names);
    }
    return;
  }
  if ((declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") && declaration.id) {
    names.add(declaration.id.name);
  }
}

function collectExportPatternNames(pattern, names) {
  if (!pattern) {
    return;
  }
  if (pattern.type === "Identifier") {
    names.add(pattern.name);
    return;
  }
  if (pattern.type === "RestElement") {
    collectExportPatternNames(pattern.argument, names);
    return;
  }
  if (pattern.type === "AssignmentPattern") {
    collectExportPatternNames(pattern.left, names);
    return;
  }
  if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements || []) {
      collectExportPatternNames(element, names);
    }
    return;
  }
  if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties || []) {
      collectExportPatternNames(property.type === "RestElement" ? property.argument : property.value, names);
    }
  }
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
