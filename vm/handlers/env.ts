// @ts-nocheck
const { OpCode } = require("../../bytecode/opcodes");

function handleEnv(vm, state, instruction) {
  switch (instruction[0]) {
    case OpCode.PUSH_WITH:
      state.withStack.unshift(Object(state.resolveValue(instruction[1])));
      return null;
    case OpCode.POP_WITH:
      state.withStack.shift();
      return null;
    case OpCode.GETENV: {
      const destRegister = instruction[1];
      const staticIndex = instruction[2];
      const name = vm.staticValues[staticIndex];
      if (!(name in vm.env)) {
        throw new ReferenceError(`${name} is not defined`);
      }
      state.setRegister(destRegister, vm.env[name]);
      return null;
    }
    case OpCode.SETENV: {
      const staticIndex = instruction[1];
      const valueRegister = instruction[2];
      const name = vm.staticValues[staticIndex];
      vm.env[name] = state.resolveValue(valueRegister);
      if (vm.env.__jsvmGlobalBindings && typeof vm.env.__jsvmGlobalBindings.add === "function") {
        vm.env.__jsvmGlobalBindings.add(name);
      }
      return null;
    }
    case OpCode.GETNAME: {
      const destRegister = instruction[1];
      const staticIndex = instruction[2];
      const name = vm.staticValues[staticIndex];
      for (let index = 0; index < state.withStack.length; index += 1) {
        const withObject = state.withStack[index];
        if (withObject && name in withObject) {
          state.setRegister(destRegister, withObject[name]);
          return null;
        }
      }
      for (let depth = 0; depth < state.bindingNameStack.length; depth += 1) {
        const scopeBindings = state.bindingNameStack[depth] || {};
        if (Object.prototype.hasOwnProperty.call(scopeBindings, name)) {
          state.setRegister(destRegister, state.getBinding(depth, scopeBindings[name].slot));
          return null;
        }
      }
      if (!(name in vm.env)) {
        throw new ReferenceError(`${name} is not defined`);
      }
      state.setRegister(destRegister, vm.env[name]);
      return null;
    }
    case OpCode.SETNAME: {
      const staticIndex = instruction[1];
      const valueRegister = instruction[2];
      const name = vm.staticValues[staticIndex];
      const value = state.resolveValue(valueRegister);
      for (let index = 0; index < state.withStack.length; index += 1) {
        const withObject = state.withStack[index];
        if (withObject && name in withObject) {
          withObject[name] = value;
          return null;
        }
      }
      for (let depth = 0; depth < state.bindingNameStack.length; depth += 1) {
        const scopeBindings = state.bindingNameStack[depth] || {};
        if (Object.prototype.hasOwnProperty.call(scopeBindings, name)) {
          state.storeBinding(depth, scopeBindings[name].slot, value);
          return null;
        }
      }
      vm.env[name] = value;
      if (vm.env.__jsvmGlobalBindings && typeof vm.env.__jsvmGlobalBindings.add === "function") {
        vm.env.__jsvmGlobalBindings.add(name);
      }
      return null;
    }
    case OpCode.LOADVAR: {
      const destRegister = instruction[1];
      const depth = instruction[2];
      const slot = instruction[3];
      state.setRegister(destRegister, state.getBinding(depth, slot));
      return null;
    }
    case OpCode.INITVAR: {
      const depth = instruction[1];
      const slot = instruction[2];
      const valueRegister = instruction[3];
      state.initBinding(depth, slot, state.resolveValue(valueRegister));
      return null;
    }
    case OpCode.STOREVAR: {
      const depth = instruction[1];
      const slot = instruction[2];
      const valueRegister = instruction[3];
      state.storeBinding(depth, slot, state.resolveValue(valueRegister));
      return null;
    }
    case OpCode.LOAD_THIS:
      state.setRegister(instruction[1], state.thisValue);
      return null;
    case OpCode.GETERR:
      state.setRegister(instruction[1], state.pendingError);
      state.pendingError = undefined;
      return null;
    case OpCode.EXPORT: {
      const staticIndex = instruction[1];
      const valueRegister = instruction[2];
      state.exports[vm.staticValues[staticIndex]] = state.resolveValue(valueRegister);
      return null;
    }
    case OpCode.NOT:
      state.setRegister(instruction[1], !state.resolveValue(instruction[2]));
      return null;
    case OpCode.UNM:
      state.setRegister(instruction[1], -state.resolveValue(instruction[2]));
      return null;
    case OpCode.TYPEOF:
      state.setRegister(instruction[1], typeof state.resolveValue(instruction[2]));
      return null;
    case OpCode.TYPEOFNAME: {
      const destRegister = instruction[1];
      const staticIndex = instruction[2];
      const name = vm.staticValues[staticIndex];
      for (let index = 0; index < state.withStack.length; index += 1) {
        const withObject = state.withStack[index];
        if (withObject && name in withObject) {
          state.setRegister(destRegister, typeof withObject[name]);
          return null;
        }
      }
      for (let depth = 0; depth < state.bindingNameStack.length; depth += 1) {
        const scopeBindings = state.bindingNameStack[depth] || {};
        if (Object.prototype.hasOwnProperty.call(scopeBindings, name)) {
          state.setRegister(destRegister, typeof state.getBinding(depth, scopeBindings[name].slot));
          return null;
        }
      }
      state.setRegister(destRegister, name in vm.env ? typeof vm.env[name] : "undefined");
      return null;
    }
    default:
      return undefined;
  }
}

module.exports = {
  handleEnv,
};

export {};
