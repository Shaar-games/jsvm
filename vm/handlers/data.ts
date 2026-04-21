// @ts-nocheck
const { OpCode } = require("../../bytecode/opcodes");

function handleData(vm, state, instruction) {
  switch (instruction[0]) {
    case OpCode.LOADK: {
      const dest = instruction[1];
      const staticIndex = instruction[2];
      state.setRegister(dest, vm.staticValues[staticIndex]);
      return null;
    }
    case OpCode.GETSTATIC: {
      const dest = instruction[1];
      const staticIndex = instruction[2];
      state.setRegister(dest, vm.staticValues[staticIndex]);
      return null;
    }
    case OpCode.MOVE: {
      const dest = instruction[1];
      const source = instruction[2];
      state.setRegister(dest, state.resolveValue(source));
      return null;
    }
    case OpCode.ARRAY:
      state.setRegister(instruction[1], []);
      return null;
    case OpCode.OBJECT:
      state.setRegister(instruction[1], {});
      return null;
    case OpCode.NULL:
      state.setRegister(instruction[1], null);
      return null;
    case OpCode.UNDEF:
      state.setRegister(instruction[1], undefined);
      return null;
    case OpCode.BOOL:
      state.setRegister(instruction[1], Boolean(instruction[2]));
      return null;
    case OpCode.PUSH_ENV:
      state.pushEnv();
      return null;
    case OpCode.POP_ENV:
      state.popEnv();
      return null;
    default:
      return undefined;
  }
}

module.exports = {
  handleData,
};

export {};
