// @ts-nocheck
const { OpCode } = require("../../bytecode/opcodes");
const { createEnvironment } = require("../environment");
const { createRegisters } = require("../registers");

function invokeCallableSync(vm, state, fn, thisArg, argsValues, callMode) {
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

async function invokeCallableAsync(vm, state, fn, thisArg, argsValues, callMode) {
  if (fn && fn.__jsvmRequire) {
    return vm.requireModule(argsValues[0], vm.filename, state);
  }

  if (fn && fn.__jsvmDirectEval) {
    return vm.evaluateSource(argsValues[0], state, {
      indirect: callMode !== "direct-eval",
    });
  }

  if (fn && typeof fn.__jsvmInvoke === "function") {
    return fn.__jsvmInvoke(thisArg, argsValues);
  }

  if (typeof fn !== "function") {
    throw new TypeError(`${fn} is not a function`);
  }

  return fn.apply(thisArg, argsValues);
}

async function handleFunction(vm, state, instruction) {
  switch (instruction[0]) {
    case OpCode.CALL: {
      const [, functionRegister, argCount, returnRegister, thisRegister, callMode, ...argRegisters] = instruction;
      const fn = state.resolveValue(functionRegister);
      const thisArg = thisRegister === "null" ? null : state.resolveValue(thisRegister);
      const argsValues = argRegisters
        .slice(0, argCount)
        .map((registerName) => state.resolveValue(registerName));
      const result = await invokeCallableAsync(vm, state, fn, thisArg, argsValues, callMode);
      state.setRegister(returnRegister, result);
      return null;
    }
    case OpCode.CALLSPREAD: {
      const [, functionRegister, argsArrayRegister, returnRegister, thisRegister, callMode] = instruction;
      const fn = state.resolveValue(functionRegister);
      const thisArg = thisRegister === "null" ? null : state.resolveValue(thisRegister);
      const argsValues = state.resolveValue(argsArrayRegister);
      const result = await invokeCallableAsync(vm, state, fn, thisArg, argsValues, callMode);
      state.setRegister(returnRegister, result);
      return null;
    }
    case OpCode.CLOSURE: {
      const [, destRegister, functionId] = instruction;
      const functionMeta = vm.functionTable.get(functionId);
      const capturedEnvs = state.envStack.slice();
      const capturedBindingNames = state.bindingNameStack ? state.bindingNameStack.slice() : [];
      const lexicalThis = state.thisValue;
      const runClosure = (thisArg, callArgs) => {
        const nextState = {
          envStack: [createEnvironment(), ...capturedEnvs],
          bindingNameStack: [functionMeta.scopeBindings || {}, ...capturedBindingNames],
          registers: createRegisters(),
          thisValue: functionMeta.thisMode === "lexical" ? lexicalThis : thisArg,
          tryStack: [],
          exports: {},
          pendingError: undefined,
        };
        return vm.executeChunk(functionMeta.bytecode, functionMeta, callArgs, nextState);
      };
      const runClosureSync = (thisArg, callArgs) => {
        const nextState = {
          envStack: [createEnvironment(), ...capturedEnvs],
          bindingNameStack: [functionMeta.scopeBindings || {}, ...capturedBindingNames],
          registers: createRegisters(),
          thisValue: functionMeta.thisMode === "lexical" ? lexicalThis : thisArg,
          tryStack: [],
          exports: {},
          pendingError: undefined,
        };
        return vm.executeChunkSync(functionMeta.bytecode, functionMeta, callArgs, nextState);
      };
      const closure = function closureInvoker(...callArgs) {
        if (!functionMeta.isAsync) {
          return runClosureSync(this, callArgs);
        }
        return runClosure(this, callArgs);
      };
      closure.__jsvmInvoke = runClosure;
      if (!functionMeta.isAsync) {
        closure.__jsvmInvokeSync = runClosureSync;
      }
      closure.__jsvmMeta = functionMeta;
      state.setRegister(destRegister, closure);
      return null;
    }
    case OpCode.AWAIT:
      state.setRegister(instruction[1], await state.resolveValue(instruction[2]));
      return null;
    case OpCode.IMPORT: {
      const [, destRegister, sourceRegister, mode] = instruction;
      const specifier = state.resolveValue(sourceRegister);
      const namespace = await vm.importModule(specifier);
      state.setRegister(destRegister, mode === "dynamic" ? Promise.resolve(namespace) : namespace);
      return null;
    }
    case OpCode.NEW: {
      const [, destRegister, ctorRegister, argCount, ...argRegisters] = instruction;
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
        const result = await Ctor.__jsvmInvoke(instance, argsValues);
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
      const [, destRegister, ctorRegister, argsArrayRegister] = instruction;
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
        const result = await Ctor.__jsvmInvoke(instance, argsValues);
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
      const [, destRegister, iterableRegister] = instruction;
      const iterable = state.resolveValue(iterableRegister);
      const iterator = iterable[Symbol.iterator]();
      state.setRegister(destRegister, iterator);
      return null;
    }
    case OpCode.ITERNEXT: {
      const [, doneRegister, valueRegister, iteratorRegister] = instruction;
      const iterator = state.resolveValue(iteratorRegister);
      const result = iterator.next();
      state.setRegister(doneRegister, Boolean(result.done));
      state.setRegister(valueRegister, result.value);
      return null;
    }
    case OpCode.CLASS: {
      const [, destRegister, nameRegister, superRegister] = instruction;
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
        if (superClass) {
          Reflect.apply(superClass, instance, ctorArgs);
        }
        if (typeof instance.constructorBody === "function") {
          return instance.constructorBody(...ctorArgs);
        }
        return undefined;
      };
      Klass.__jsvmConstruct = async (instance, ctorArgs) => Klass.__jsvmConstructSync(instance, ctorArgs);
      state.setRegister(destRegister, Klass);
      return null;
    }
    case OpCode.SETMETHOD: {
      const [, classRegister, keyRegister, functionRegister, kind, isStatic] = instruction;
      const Klass = state.resolveValue(classRegister);
      const key = state.resolveValue(keyRegister);
      const fn = state.resolveValue(functionRegister);
      if (kind === "constructor") {
        Klass.prototype.constructorBody = fn;
      } else if (isStatic) {
        Klass[key] = fn;
      } else {
        Klass.prototype[key] = fn;
      }
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
        const [, functionRegister, argCount, returnRegister, thisRegister, callMode, ...argRegisters] = instruction;
        const fn = state.resolveValue(functionRegister);
        const thisArg = thisRegister === "null" ? null : state.resolveValue(thisRegister);
        const argsValues = argRegisters
          .slice(0, argCount)
          .map((registerName) => state.resolveValue(registerName));
        const result = invokeCallableSync(vm, state, fn, thisArg, argsValues, callMode);
        state.setRegister(returnRegister, result);
        return null;
      }
      case OpCode.CALLSPREAD: {
        const [, functionRegister, argsArrayRegister, returnRegister, thisRegister, callMode] = instruction;
        const fn = state.resolveValue(functionRegister);
        const thisArg = thisRegister === "null" ? null : state.resolveValue(thisRegister);
        const argsValues = state.resolveValue(argsArrayRegister);
        const result = invokeCallableSync(vm, state, fn, thisArg, argsValues, callMode);
        state.setRegister(returnRegister, result);
        return null;
      }
      case OpCode.CLOSURE: {
        const [, destRegister, functionId] = instruction;
        const functionMeta = vm.functionTable.get(functionId);
        const capturedEnvs = state.envStack.slice();
        const capturedBindingNames = state.bindingNameStack ? state.bindingNameStack.slice() : [];
        const lexicalThis = state.thisValue;
        const runClosure = (thisArg, callArgs) => {
          const nextState = {
            envStack: [createEnvironment(), ...capturedEnvs],
            bindingNameStack: [functionMeta.scopeBindings || {}, ...capturedBindingNames],
            registers: createRegisters(),
            thisValue: functionMeta.thisMode === "lexical" ? lexicalThis : thisArg,
            tryStack: [],
            exports: {},
            pendingError: undefined,
          };
          return vm.executeChunk(functionMeta.bytecode, functionMeta, callArgs, nextState);
        };
        const runClosureSync = (thisArg, callArgs) => {
          const nextState = {
            envStack: [createEnvironment(), ...capturedEnvs],
            bindingNameStack: [functionMeta.scopeBindings || {}, ...capturedBindingNames],
            registers: createRegisters(),
            thisValue: functionMeta.thisMode === "lexical" ? lexicalThis : thisArg,
            tryStack: [],
            exports: {},
            pendingError: undefined,
          };
          return vm.executeChunkSync(functionMeta.bytecode, functionMeta, callArgs, nextState);
        };
        const closure = function closureInvoker(...callArgs) {
          if (!functionMeta.isAsync) {
            return runClosureSync(this, callArgs);
          }
          return runClosure(this, callArgs);
        };
        closure.__jsvmInvoke = runClosure;
        if (!functionMeta.isAsync) {
          closure.__jsvmInvokeSync = runClosureSync;
        }
        closure.__jsvmMeta = functionMeta;
        state.setRegister(destRegister, closure);
        return null;
      }
      case OpCode.NEW: {
        const [, destRegister, ctorRegister, argCount, ...argRegisters] = instruction;
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
          const result = Ctor.__jsvmInvokeSync(instance, argsValues);
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
        const [, destRegister, ctorRegister, argsArrayRegister] = instruction;
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
          const result = Ctor.__jsvmInvokeSync(instance, argsValues);
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
        const [, destRegister, iterableRegister] = instruction;
        const iterable = state.resolveValue(iterableRegister);
        const iterator = iterable[Symbol.iterator]();
        state.setRegister(destRegister, iterator);
        return null;
      }
      case OpCode.ITERNEXT: {
        const [, doneRegister, valueRegister, iteratorRegister] = instruction;
        const iterator = state.resolveValue(iteratorRegister);
        const result = iterator.next();
        state.setRegister(doneRegister, Boolean(result.done));
        state.setRegister(valueRegister, result.value);
        return null;
      }
      case OpCode.CLASS: {
        const [, destRegister, nameRegister, superRegister] = instruction;
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
          if (superClass) {
            Reflect.apply(superClass, instance, ctorArgs);
          }
          if (typeof instance.constructorBody === "function") {
            return instance.constructorBody(...ctorArgs);
          }
          return undefined;
        };
        Klass.__jsvmConstruct = async (instance, ctorArgs) => Klass.__jsvmConstructSync(instance, ctorArgs);
        state.setRegister(destRegister, Klass);
        return null;
      }
      case OpCode.SETMETHOD: {
        const [, classRegister, keyRegister, functionRegister, kind, isStatic] = instruction;
        const Klass = state.resolveValue(classRegister);
        const key = state.resolveValue(keyRegister);
        const fn = state.resolveValue(functionRegister);
        if (kind === "constructor") {
          Klass.prototype.constructorBody = fn;
        } else if (isStatic) {
          Klass[key] = fn;
        } else {
          Klass.prototype[key] = fn;
        }
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
