// @ts-nocheck
const { OpCode } = require("../../bytecode/opcodes");
const { createEnvironment } = require("../environment");
const { createRegisters } = require("../registers");

function prependInternalFrame(headValue, tailValues) {
  const result = new Array((tailValues ? tailValues.length : 0) + 1);
  Object.defineProperty(result, 0, {
    value: headValue,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  for (let index = 0; index < (tailValues ? tailValues.length : 0); index += 1) {
    Object.defineProperty(result, index + 1, {
      value: tailValues[index],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return result;
}

function copyArgumentsObject(argsLike) {
  const result = new Array(argsLike.length);
  for (let index = 0; index < argsLike.length; index += 1) {
    Object.defineProperty(result, index, {
      value: argsLike[index],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return result;
}

function createClosureState(functionMeta, capturedEnvs, capturedBindingNames, lexicalThis, thisArg, globalObject = globalThis, newTarget = undefined) {
  return {
    envStack: prependInternalFrame(createEnvironment(), capturedEnvs),
    bindingNameStack: prependInternalFrame(functionMeta.scopeBindings || {}, capturedBindingNames),
    registers: createRegisters(),
    thisValue: functionMeta.thisMode === "lexical" ? lexicalThis : normalizeThisArg(functionMeta, thisArg, globalObject),
    newTarget,
    tryStack: [],
    exports: {},
    pendingError: undefined,
  };
}

function normalizeThisArg(functionMeta, thisArg, globalObject) {
  if (functionMeta.strictMode) {
    return thisArg;
  }
  if (thisArg === null || thisArg === undefined) {
    return globalObject;
  }
  return (typeof thisArg === "object" || typeof thisArg === "function") ? thisArg : Object(thisArg);
}

function isObjectLike(value) {
  return value !== null && value !== undefined && (typeof value === "object" || typeof value === "function");
}

function defineClassElement(Klass, key, fn, kind, isStatic) {
  const target = isStatic ? Klass : Klass.prototype;
  if (kind === "constructor") {
    Klass.prototype.constructorBody = fn;
    return;
  }

  if (kind === "get" || kind === "set") {
    const current = Object.getOwnPropertyDescriptor(target, key) || {
      enumerable: false,
      configurable: true,
    };
    Object.defineProperty(target, key, {
      get: kind === "get" ? fn : current.get,
      set: kind === "set" ? fn : current.set,
      enumerable: false,
      configurable: true,
    });
    return;
  }

  target[key] = fn;
}

function installCompiledFunctionLegacyAccessors(vm, closure, functionMeta) {
  if (functionMeta.strictMode || functionMeta.thisMode === "lexical") {
    return;
  }

  Object.defineProperty(closure, "caller", {
    get() {
      return vm.getLegacyFunctionCaller(closure);
    },
    set() {},
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(closure, "arguments", {
    get() {
      return null;
    },
    set() {},
    enumerable: false,
    configurable: true,
  });
}

function installCompiledFunctionMetadata(closure, functionMeta) {
  Object.defineProperty(closure, "length", {
    value: Number.isInteger(functionMeta.length) ? functionMeta.length : 0,
    writable: false,
    enumerable: false,
    configurable: true,
  });
}

function createAsyncClosureState(functionMeta, capturedEnvs, capturedBindingNames, lexicalThis, thisArg, globalObject = globalThis, newTarget = undefined) {
  return {
    ...createClosureState(functionMeta, capturedEnvs, capturedBindingNames, lexicalThis, thisArg, globalObject, newTarget),
    withStack: [],
  };
}

function invokeCallableSync(vm, state, fn, thisArg, argsValues, callMode, instruction = null) {
  if (fn === undefined) {
    throw new TypeError(`VM CALL target resolved to undefined${instruction ? ` for ${JSON.stringify(instruction)}` : ""}`);
  }
  if (fn && fn.__jsvmRequire) {
    throw new Error("Require is not supported in sync VM path");
  }

  if (fn && fn.__jsvmDirectEval) {
    throw new Error("Eval is not supported in sync VM path");
  }

  if (fn && typeof fn.__jsvmInvokeSync === "function") {
    return fn.__jsvmInvokeSync(thisArg, argsValues);
  }

  if (typeof fn !== "function") {
    throw new TypeError(`${fn} is not a function`);
  }

  return fn.apply(thisArg, argsValues);
}

function invokeCallable(vm, state, fn, thisArg, argsValues, callMode, instruction = null) {
  if (fn === undefined) {
    throw new TypeError(`VM CALL target resolved to undefined${instruction ? ` for ${JSON.stringify(instruction)}` : ""}`);
  }
  if (fn && fn.__jsvmRequire) {
    return {
      awaitResult: true,
      value: vm.requireModule(argsValues[0], vm.filename, state),
    };
  }

  if (fn && fn.__jsvmDirectEval) {
    return {
      awaitResult: true,
      value: vm.evaluateSource(argsValues[0], state, {
        indirect: callMode !== "direct-eval",
      }),
    };
  }

  if (fn && typeof fn.__jsvmInvoke === "function") {
    const functionMeta = fn.__jsvmMeta || null;
    return {
      awaitResult: !functionMeta || !functionMeta.isAsync,
      value: fn.__jsvmInvoke(thisArg, argsValues),
    };
  }

  if (typeof fn !== "function") {
    throw new TypeError(`${fn} is not a function`);
  }

  return {
    awaitResult: false,
    value: fn.apply(thisArg, argsValues),
  };
}

function createGeneratorIterator(vm, functionMeta, capturedEnvs, capturedBindingNames, lexicalThis, thisArg, callArgs, newTarget = undefined) {
  const execState = vm.createExecutionState(
    null,
    createClosureState(functionMeta, capturedEnvs, capturedBindingNames, lexicalThis, thisArg, vm.globalObject, newTarget)
  );
  const frame = vm.createGeneratorFrame(functionMeta.bytecode, functionMeta, callArgs, execState);

  const iterator = {
    next(value) {
      return vm.resumeGeneratorFrame(frame, "next", value);
    },
    return(value) {
      return vm.resumeGeneratorFrame(frame, "return", value);
    },
    throw(error) {
      return vm.resumeGeneratorFrame(frame, "throw", error);
    },
    [Symbol.iterator]() {
      return this;
    },
  };
  const generatorPrototype = Object.getPrototypeOf(function* generator() {}());
  if (generatorPrototype && typeof generatorPrototype === "object") {
    Object.setPrototypeOf(iterator, generatorPrototype);
  }

  return iterator;
}

function createAsyncGeneratorIterator(vm, functionMeta, capturedEnvs, capturedBindingNames, lexicalThis, thisArg, callArgs, newTarget = undefined) {
  const execState = vm.createExecutionState(
    null,
    createAsyncClosureState(functionMeta, capturedEnvs, capturedBindingNames, lexicalThis, thisArg, vm.globalObject, newTarget)
  );
  const frame = vm.createGeneratorFrame(functionMeta.bytecode, functionMeta, callArgs, execState);

  const iterator = {
    async next(value) {
      return vm.resumeAsyncGeneratorFrame(frame, "next", value);
    },
    async return(value) {
      return vm.resumeAsyncGeneratorFrame(frame, "return", value);
    },
    async throw(error) {
      return vm.resumeAsyncGeneratorFrame(frame, "throw", error);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  return iterator;
}

async function handleFunction(vm, state, instruction) {
  switch (instruction[0]) {
    case OpCode.CALL: {
      const functionRegister = instruction[1];
      const argCount = instruction[2];
      const returnRegister = instruction[3];
      const thisRegister = instruction[4];
      const callMode = instruction[5];
      const argRegisters = instruction.slice(6);
      const fn = state.resolveValue(functionRegister);
      const thisArg = thisRegister === "null" ? null : state.resolveValue(thisRegister);
      const argsValues = argRegisters
        .slice(0, argCount)
        .map((registerName) => state.resolveValue(registerName));
      const invocation = invokeCallable(vm, state, fn, thisArg, argsValues, callMode, instruction);
      const result = invocation.awaitResult ? await invocation.value : invocation.value;
      state.setRegister(returnRegister, result);
      return null;
    }
    case OpCode.CALLSPREAD: {
      const functionRegister = instruction[1];
      const argsArrayRegister = instruction[2];
      const returnRegister = instruction[3];
      const thisRegister = instruction[4];
      const callMode = instruction[5];
      const fn = state.resolveValue(functionRegister);
      const thisArg = thisRegister === "null" ? null : state.resolveValue(thisRegister);
      const argsValues = state.resolveValue(argsArrayRegister);
      const invocation = invokeCallable(vm, state, fn, thisArg, argsValues, callMode, instruction);
      const result = invocation.awaitResult ? await invocation.value : invocation.value;
      state.setRegister(returnRegister, result);
      return null;
    }
    case OpCode.CLOSURE: {
      const destRegister = instruction[1];
      const functionId = instruction[2];
      const functionMeta = vm.functionTable.get(functionId);
      const capturedEnvs = state.envStack.slice();
      const capturedBindingNames = state.bindingNameStack ? state.bindingNameStack.slice() : [];
      const lexicalThis = state.thisValue;
      const runClosure = (thisArg, callArgs, newTarget = undefined) => {
        return vm.enterFunctionCall(closure, functionMeta, () => {
          const nextState = createClosureState(functionMeta, capturedEnvs, capturedBindingNames, lexicalThis, thisArg, vm.globalObject, newTarget);
          nextState.currentFunction = closure;
          nextState.currentFunctionMeta = functionMeta;
          return vm.executeChunk(functionMeta.bytecode, functionMeta, callArgs, nextState);
        });
      };
      const runClosureSync = (thisArg, callArgs, newTarget = undefined) => {
        return vm.enterFunctionCall(closure, functionMeta, () => {
          const nextState = createClosureState(functionMeta, capturedEnvs, capturedBindingNames, lexicalThis, thisArg, vm.globalObject, newTarget);
          nextState.currentFunction = closure;
          nextState.currentFunctionMeta = functionMeta;
          return vm.executeChunkSync(functionMeta.bytecode, functionMeta, callArgs, nextState);
        });
      };
      let closure;
      if (functionMeta.isGenerator) {
        closure = function generatorClosureInvoker() {
          const callArgs = copyArgumentsObject(arguments);
          return functionMeta.isAsync
            ? createAsyncGeneratorIterator(
                vm,
                functionMeta,
                capturedEnvs,
                capturedBindingNames,
                lexicalThis,
                this,
                callArgs,
                new.target ? closure : undefined
              )
            : createGeneratorIterator(
                vm,
                functionMeta,
                capturedEnvs,
                capturedBindingNames,
                lexicalThis,
                this,
                callArgs,
                new.target ? closure : undefined
              );
        };
      } else {
        closure = function closureInvoker() {
          const callArgs = copyArgumentsObject(arguments);
          if (!functionMeta.isAsync) {
            return runClosureSync(this, callArgs, new.target ? closure : undefined);
          }
          return runClosure(this, callArgs, new.target ? closure : undefined);
        };
      }
      if (!functionMeta.isGenerator) {
        closure.__jsvmInvoke = runClosure;
        closure.__jsvmConstruct = (thisArg, callArgs) => runClosure(thisArg, callArgs, closure);
        if (!functionMeta.isAsync) {
          closure.__jsvmInvokeSync = runClosureSync;
          closure.__jsvmConstructSync = (thisArg, callArgs) => runClosureSync(thisArg, callArgs, closure);
        }
      }
      closure.__jsvmMeta = functionMeta;
      installCompiledFunctionMetadata(closure, functionMeta);
      installCompiledFunctionLegacyAccessors(vm, closure, functionMeta);
      state.setRegister(destRegister, closure);
      return null;
    }
    case OpCode.AWAIT:
      state.setRegister(instruction[1], await state.resolveValue(instruction[2]));
      return null;
    case OpCode.IMPORT: {
      const destRegister = instruction[1];
      const sourceRegister = instruction[2];
      const mode = instruction[3];
      const specifier = state.resolveValue(sourceRegister);
      const namespace = await vm.importModule(specifier);
      state.setRegister(destRegister, mode === "dynamic" ? Promise.resolve(namespace) : namespace);
      return null;
    }
    case OpCode.NEW: {
      const destRegister = instruction[1];
      const ctorRegister = instruction[2];
      const argCount = instruction[3];
      const argRegisters = instruction.slice(4);
      const Ctor = state.resolveValue(ctorRegister);
      const argsValues = argRegisters
        .slice(0, argCount)
        .map((registerName) => state.resolveValue(registerName));
      if (Ctor && Ctor.__jsvmClass) {
        const instance = Object.create(Ctor.prototype || Object.prototype);
        const result = typeof Ctor.__jsvmConstruct === "function"
          ? await Ctor.__jsvmConstruct(instance, argsValues)
          : undefined;
        state.setRegister(
          destRegister,
          result && (typeof result === "object" || typeof result === "function") ? result : instance
        );
        return null;
      }
      if (Ctor && typeof Ctor.__jsvmInvoke === "function") {
        const instance = Object.create(Ctor.prototype || Object.prototype);
        const result = typeof Ctor.__jsvmConstruct === "function"
          ? await Ctor.__jsvmConstruct(instance, argsValues)
          : await Ctor.__jsvmInvoke(instance, argsValues);
        state.setRegister(
          destRegister,
          result && (typeof result === "object" || typeof result === "function") ? result : instance
        );
        return null;
      }
      state.setRegister(destRegister, Reflect.construct(Ctor, argsValues));
      return null;
    }
    case OpCode.NEWSPREAD: {
      const destRegister = instruction[1];
      const ctorRegister = instruction[2];
      const argsArrayRegister = instruction[3];
      const Ctor = state.resolveValue(ctorRegister);
      const argsValues = state.resolveValue(argsArrayRegister);
      if (Ctor && Ctor.__jsvmClass) {
        const instance = Object.create(Ctor.prototype || Object.prototype);
        const result = typeof Ctor.__jsvmConstruct === "function"
          ? await Ctor.__jsvmConstruct(instance, argsValues)
          : undefined;
        state.setRegister(
          destRegister,
          result && (typeof result === "object" || typeof result === "function") ? result : instance
        );
        return null;
      }
      if (Ctor && typeof Ctor.__jsvmInvoke === "function") {
        const instance = Object.create(Ctor.prototype || Object.prototype);
        const result = typeof Ctor.__jsvmConstruct === "function"
          ? await Ctor.__jsvmConstruct(instance, argsValues)
          : await Ctor.__jsvmInvoke(instance, argsValues);
        state.setRegister(
          destRegister,
          result && (typeof result === "object" || typeof result === "function") ? result : instance
        );
        return null;
      }
      state.setRegister(destRegister, Reflect.construct(Ctor, argsValues));
      return null;
    }
    case OpCode.GETITER: {
      const destRegister = instruction[1];
      const iterableRegister = instruction[2];
      const iterable = state.resolveValue(iterableRegister);
      const iterator = vm.getIteratorFromValue(iterable);
      state.setRegister(destRegister, iterator);
      return null;
    }
    case OpCode.ITERNEXT: {
      const doneRegister = instruction[1];
      const valueRegister = instruction[2];
      const iteratorRegister = instruction[3];
      const iterator = state.resolveValue(iteratorRegister);
      const result = iterator.next();
      if (!isObjectLike(result)) {
        throw new TypeError("Iterator result is not an object");
      }
      state.setRegister(doneRegister, Boolean(result.done));
      state.setRegister(valueRegister, result.value);
      return null;
    }
    case OpCode.GETASYNCITER: {
      const destRegister = instruction[1];
      const iterableRegister = instruction[2];
      const iterable = state.resolveValue(iterableRegister);
      const iterator = vm.getAsyncIteratorFromValue(iterable);
      state.setRegister(destRegister, iterator);
      return null;
    }
    case OpCode.ASYNCITERNEXT: {
      const doneRegister = instruction[1];
      const valueRegister = instruction[2];
      const iteratorRegister = instruction[3];
      const iterator = state.resolveValue(iteratorRegister);
      const result = await iterator.next();
      if (!isObjectLike(result)) {
        throw new TypeError("Async iterator result is not an object");
      }
      state.setRegister(doneRegister, Boolean(result.done));
      state.setRegister(valueRegister, result.value);
      return null;
    }
    case OpCode.CLASS: {
      const destRegister = instruction[1];
      const nameRegister = instruction[2];
      const superRegister = instruction[3];
      const className = nameRegister === "null" ? "" : state.resolveValue(nameRegister);
      const superClass = superRegister === "null" ? null : state.resolveValue(superRegister);
      const Klass = function classFactory() {};
      Object.defineProperty(Klass, "name", { value: className || "AnonymousClass" });
      if (superClass) {
        Klass.prototype = Object.create(superClass.prototype);
        Object.setPrototypeOf(Klass, superClass);
      }
      Klass.prototype.constructor = Klass;
      Klass.__jsvmClass = true;
      Klass.__jsvmConstructSync = (instance, ctorArgs) => {
        let thisValue = instance;
        if (superClass) {
          thisValue = Reflect.construct(superClass, ctorArgs, Klass);
        }
        if (typeof thisValue.constructorBody === "function") {
          const result = thisValue.constructorBody(...ctorArgs);
          return result && (typeof result === "object" || typeof result === "function") ? result : thisValue;
        }
        return superClass ? thisValue : undefined;
      };
      Klass.__jsvmConstruct = async (instance, ctorArgs) => Klass.__jsvmConstructSync(instance, ctorArgs);
      state.setRegister(destRegister, Klass);
      return null;
    }
    case OpCode.SETMETHOD: {
      const classRegister = instruction[1];
      const keyRegister = instruction[2];
      const functionRegister = instruction[3];
      const kind = instruction[4];
      const isStatic = instruction[5];
      const Klass = state.resolveValue(classRegister);
      const key = state.resolveValue(keyRegister);
      const fn = state.resolveValue(functionRegister);
      defineClassElement(Klass, key, fn, kind, isStatic);
      return null;
    }
    default:
      return undefined;
  }
}

module.exports = {
  handleFunction,
  handleFunctionSync(vm, state, instruction) {
    switch (instruction[0]) {
      case OpCode.CALL: {
        const functionRegister = instruction[1];
        const argCount = instruction[2];
        const returnRegister = instruction[3];
        const thisRegister = instruction[4];
        const callMode = instruction[5];
        const argRegisters = instruction.slice(6);
        const fn = state.resolveValue(functionRegister);
        const thisArg = thisRegister === "null" ? null : state.resolveValue(thisRegister);
        const argsValues = argRegisters
          .slice(0, argCount)
          .map((registerName) => state.resolveValue(registerName));
        const result = invokeCallableSync(vm, state, fn, thisArg, argsValues, callMode, instruction);
        state.setRegister(returnRegister, result);
        return null;
      }
      case OpCode.CALLSPREAD: {
        const functionRegister = instruction[1];
        const argsArrayRegister = instruction[2];
        const returnRegister = instruction[3];
        const thisRegister = instruction[4];
        const callMode = instruction[5];
        const fn = state.resolveValue(functionRegister);
        const thisArg = thisRegister === "null" ? null : state.resolveValue(thisRegister);
        const argsValues = state.resolveValue(argsArrayRegister);
        const result = invokeCallableSync(vm, state, fn, thisArg, argsValues, callMode, instruction);
        state.setRegister(returnRegister, result);
        return null;
      }
      case OpCode.CLOSURE: {
        const destRegister = instruction[1];
        const functionId = instruction[2];
        const functionMeta = vm.functionTable.get(functionId);
        const capturedEnvs = state.envStack.slice();
        const capturedBindingNames = state.bindingNameStack ? state.bindingNameStack.slice() : [];
        const lexicalThis = state.thisValue;
        const runClosure = (thisArg, callArgs, newTarget = undefined) => {
          return vm.enterFunctionCall(closure, functionMeta, () => {
            const nextState = createClosureState(functionMeta, capturedEnvs, capturedBindingNames, lexicalThis, thisArg, vm.globalObject, newTarget);
            nextState.currentFunction = closure;
            nextState.currentFunctionMeta = functionMeta;
            return vm.executeChunk(functionMeta.bytecode, functionMeta, callArgs, nextState);
          });
        };
        const runClosureSync = (thisArg, callArgs, newTarget = undefined) => {
          return vm.enterFunctionCall(closure, functionMeta, () => {
            const nextState = createClosureState(functionMeta, capturedEnvs, capturedBindingNames, lexicalThis, thisArg, vm.globalObject, newTarget);
            nextState.currentFunction = closure;
            nextState.currentFunctionMeta = functionMeta;
            return vm.executeChunkSync(functionMeta.bytecode, functionMeta, callArgs, nextState);
          });
        };
        let closure;
        if (functionMeta.isGenerator) {
          closure = function generatorClosureInvoker() {
            const callArgs = copyArgumentsObject(arguments);
            return functionMeta.isAsync
              ? createAsyncGeneratorIterator(
                  vm,
                  functionMeta,
                  capturedEnvs,
                  capturedBindingNames,
                  lexicalThis,
                  this,
                  callArgs,
                  new.target ? closure : undefined
                )
              : createGeneratorIterator(
                  vm,
                  functionMeta,
                  capturedEnvs,
                  capturedBindingNames,
                  lexicalThis,
                  this,
                  callArgs,
                  new.target ? closure : undefined
                );
          };
        } else {
          closure = function closureInvoker() {
            const callArgs = copyArgumentsObject(arguments);
            if (!functionMeta.isAsync) {
              return runClosureSync(this, callArgs, new.target ? closure : undefined);
            }
            return runClosure(this, callArgs, new.target ? closure : undefined);
          };
        }
        if (!functionMeta.isGenerator) {
          closure.__jsvmInvoke = runClosure;
          closure.__jsvmConstruct = (thisArg, callArgs) => runClosure(thisArg, callArgs, closure);
          if (!functionMeta.isAsync) {
            closure.__jsvmInvokeSync = runClosureSync;
            closure.__jsvmConstructSync = (thisArg, callArgs) => runClosureSync(thisArg, callArgs, closure);
          }
        }
        closure.__jsvmMeta = functionMeta;
        installCompiledFunctionMetadata(closure, functionMeta);
        installCompiledFunctionLegacyAccessors(vm, closure, functionMeta);
        state.setRegister(destRegister, closure);
        return null;
      }
      case OpCode.NEW: {
        const destRegister = instruction[1];
        const ctorRegister = instruction[2];
        const argCount = instruction[3];
        const argRegisters = instruction.slice(4);
        const Ctor = state.resolveValue(ctorRegister);
        const argsValues = argRegisters
          .slice(0, argCount)
          .map((registerName) => state.resolveValue(registerName));
        if (Ctor && Ctor.__jsvmClass) {
          const instance = Object.create(Ctor.prototype || Object.prototype);
          const result = typeof Ctor.__jsvmConstructSync === "function"
            ? Ctor.__jsvmConstructSync(instance, argsValues)
            : (typeof Ctor.__jsvmConstruct === "function" ? Ctor.__jsvmConstruct(instance, argsValues) : undefined);
          if (result && typeof result.then === "function") {
            throw new Error("Async constructor used in sync VM path");
          }
          state.setRegister(
            destRegister,
            result && (typeof result === "object" || typeof result === "function") ? result : instance
          );
          return null;
        }
        if (Ctor && typeof Ctor.__jsvmInvokeSync === "function") {
          const instance = Object.create(Ctor.prototype || Object.prototype);
          const result = typeof Ctor.__jsvmConstructSync === "function"
            ? Ctor.__jsvmConstructSync(instance, argsValues)
            : Ctor.__jsvmInvokeSync(instance, argsValues);
          state.setRegister(
            destRegister,
            result && (typeof result === "object" || typeof result === "function") ? result : instance
          );
          return null;
        }
        state.setRegister(destRegister, Reflect.construct(Ctor, argsValues));
        return null;
      }
      case OpCode.NEWSPREAD: {
        const destRegister = instruction[1];
        const ctorRegister = instruction[2];
        const argsArrayRegister = instruction[3];
        const Ctor = state.resolveValue(ctorRegister);
        const argsValues = state.resolveValue(argsArrayRegister);
        if (Ctor && Ctor.__jsvmClass) {
          const instance = Object.create(Ctor.prototype || Object.prototype);
          const result = typeof Ctor.__jsvmConstructSync === "function"
            ? Ctor.__jsvmConstructSync(instance, argsValues)
            : (typeof Ctor.__jsvmConstruct === "function" ? Ctor.__jsvmConstruct(instance, argsValues) : undefined);
          if (result && typeof result.then === "function") {
            throw new Error("Async constructor used in sync VM path");
          }
          state.setRegister(
            destRegister,
            result && (typeof result === "object" || typeof result === "function") ? result : instance
          );
          return null;
        }
        if (Ctor && typeof Ctor.__jsvmInvokeSync === "function") {
          const instance = Object.create(Ctor.prototype || Object.prototype);
          const result = typeof Ctor.__jsvmConstructSync === "function"
            ? Ctor.__jsvmConstructSync(instance, argsValues)
            : Ctor.__jsvmInvokeSync(instance, argsValues);
          state.setRegister(
            destRegister,
            result && (typeof result === "object" || typeof result === "function") ? result : instance
          );
          return null;
        }
        state.setRegister(destRegister, Reflect.construct(Ctor, argsValues));
        return null;
      }
      case OpCode.GETITER: {
        const destRegister = instruction[1];
        const iterableRegister = instruction[2];
        const iterable = state.resolveValue(iterableRegister);
        const iterator = vm.getIteratorFromValue(iterable);
        state.setRegister(destRegister, iterator);
        return null;
      }
      case OpCode.ITERNEXT: {
        const doneRegister = instruction[1];
        const valueRegister = instruction[2];
        const iteratorRegister = instruction[3];
        const iterator = state.resolveValue(iteratorRegister);
        const result = iterator.next();
        if (!isObjectLike(result)) {
          throw new TypeError("Iterator result is not an object");
        }
        state.setRegister(doneRegister, Boolean(result.done));
        state.setRegister(valueRegister, result.value);
        return null;
      }
      case OpCode.CLASS: {
        const destRegister = instruction[1];
        const nameRegister = instruction[2];
        const superRegister = instruction[3];
        const className = nameRegister === "null" ? "" : state.resolveValue(nameRegister);
        const superClass = superRegister === "null" ? null : state.resolveValue(superRegister);
        const Klass = function classFactory() {};
        Object.defineProperty(Klass, "name", { value: className || "AnonymousClass" });
        if (superClass) {
          Klass.prototype = Object.create(superClass.prototype);
          Object.setPrototypeOf(Klass, superClass);
        }
        Klass.prototype.constructor = Klass;
        Klass.__jsvmClass = true;
        Klass.__jsvmConstructSync = (instance, ctorArgs) => {
          let thisValue = instance;
          if (superClass) {
            thisValue = Reflect.construct(superClass, ctorArgs, Klass);
          }
          if (typeof thisValue.constructorBody === "function") {
            const result = thisValue.constructorBody(...ctorArgs);
            return result && (typeof result === "object" || typeof result === "function") ? result : thisValue;
          }
          return superClass ? thisValue : undefined;
        };
        Klass.__jsvmConstruct = async (instance, ctorArgs) => Klass.__jsvmConstructSync(instance, ctorArgs);
        state.setRegister(destRegister, Klass);
        return null;
      }
      case OpCode.SETMETHOD: {
        const classRegister = instruction[1];
        const keyRegister = instruction[2];
        const functionRegister = instruction[3];
        const kind = instruction[4];
        const isStatic = instruction[5];
        const Klass = state.resolveValue(classRegister);
        const key = state.resolveValue(keyRegister);
        const fn = state.resolveValue(functionRegister);
        defineClassElement(Klass, key, fn, kind, isStatic);
        return null;
      }
      case OpCode.AWAIT:
      case OpCode.IMPORT:
        throw new Error(`Async opcode used in sync VM path: ${instruction[0]}`);
      default:
        return undefined;
    }
  },
};

export {};
