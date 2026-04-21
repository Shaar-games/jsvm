// @ts-nocheck
const { OpCode } = require("../../bytecode/opcodes");

const binaryExecutors = {
  [OpCode.ADD]: (left, right) => left + right,
  [OpCode.SUB]: (left, right) => left - right,
  [OpCode.MUL]: (left, right) => left * right,
  [OpCode.DIV]: (left, right) => left / right,
  [OpCode.POW]: (left, right) => left ** right,
  [OpCode.BAND]: (left, right) => left & right,
  [OpCode.BOR]: (left, right) => left | right,
  [OpCode.BXOR]: (left, right) => left ^ right,
  [OpCode.LSH]: (left, right) => left << right,
  [OpCode.ULSH]: (left, right) => left << right,
  [OpCode.RSH]: (left, right) => left >> right,
  [OpCode.URSH]: (left, right) => left >>> right,
  [OpCode.XOR]: (left, right) => left ^ right,
  [OpCode.MOD]: (left, right) => left % right,
  [OpCode.ISEQ]: (left, right) => left === right,
  [OpCode.ISLT]: (left, right) => left < right,
  [OpCode.ISGE]: (left, right) => left >= right,
  [OpCode.ISLE]: (left, right) => left <= right,
  [OpCode.ISGT]: (left, right) => left > right,
  [OpCode.ISNE]: (left, right) => left !== right,
  [OpCode.ISIN]: (left, right) => left in right,
  [OpCode.ISINSTANCE]: (left, right) => left instanceof right,
};

function handleBinary(_vm, state, instruction) {
  const executor = binaryExecutors[instruction[0]];
  if (!executor) {
    return undefined;
  }

  const dest = instruction[1];
  const left = instruction[2];
  const right = instruction[3];
  state.setRegister(dest, executor(state.resolveValue(left), state.resolveValue(right)));
  return null;
}

module.exports = {
  handleBinary,
};

export {};
