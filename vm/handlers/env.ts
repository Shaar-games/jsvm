// @ts-nocheck
const { OpCode } = require("../../bytecode/opcodes");

function handleEnv(vm, state, instruction) {
  switch (instruction[0]) {
    case OpCode.GETENV: {
      const [, destRegister, staticIndex] = instruction;
      const name = vm.staticValues[staticIndex];
      if (!(name in vm.env)) {
        throw new ReferenceError(`${name} is not defined`);
      }
      state.setRegister(destRegister, vm.env[name]);
      return null;
    }
    case OpCode.SETENV: {
      const [, staticIndex, valueRegister] = instruction;
      vm.env[vm.staticValues[staticIndex]] = state.resolveValue(valueRegister);
      return null;
    }
    case OpCode.LOADVAR: {
      const [, destRegister, depth, slot] = instruction;
      state.setRegister(destRegister, state.getBinding(depth, slot));
      return null;
    }
    case OpCode.INITVAR: {
      const [, depth, slot, valueRegister] = instruction;
      state.initBinding(depth, slot, state.resolveValue(valueRegister));
      return null;
    }
    case OpCode.STOREVAR: {
      const [, depth, slot, valueRegister] = instruction;
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
      const [, staticIndex, valueRegister] = instruction;
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
    default:
      return undefined;
  }
}

module.exports = {
  handleEnv,
};

export {};
