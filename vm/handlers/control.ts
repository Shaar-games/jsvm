// @ts-nocheck
const { OpCode } = require("../../bytecode/opcodes");

function handleControl(_vm, state, instruction) {
  switch (instruction[0]) {
    case OpCode.RETURN:
      return {
        type: "return",
        value: instruction[1] === "null" ? undefined : state.resolveValue(instruction[1]),
      };
    case OpCode.YIELD:
      return {
        type: "yield",
        resumeRegister: instruction[1],
        value: state.resolveValue(instruction[2]),
      };
    case OpCode.YIELDSTAR:
      return {
        type: "yield-star",
        resumeRegister: instruction[1],
        iterable: state.resolveValue(instruction[2]),
      };
    case OpCode.EXIT:
      return { type: "return", value: undefined };
    case OpCode.JUMP:
      return { type: "jump", ip: state.jump(instruction[1]) };
    case OpCode.JUMPF:
      if (!state.resolveValue(instruction[1])) {
        return { type: "jump", ip: state.jump(instruction[2]) };
      }
      return null;
    case OpCode.JUMPT:
      if (state.resolveValue(instruction[1])) {
        return { type: "jump", ip: state.jump(instruction[2]) };
      }
      return null;
    case OpCode.THROW:
      throw state.resolveValue(instruction[1]);
    case OpCode.SETUP_TRY:
      state.tryStack.push({
        catchLabel: instruction[1],
        envDepth: state.envStack.length,
      });
      return null;
    case OpCode.END_TRY:
      state.tryStack.pop();
      return null;
    default:
      return undefined;
  }
}

module.exports = {
  handleControl,
};

export {};
