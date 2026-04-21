// @ts-nocheck
const { handleBinary } = require("./binary");
const { handleControl } = require("./control");
const { handleData } = require("./data");
const { handleEnv } = require("./env");
const { handleFunction, handleFunctionSync } = require("./function");
const { handleObject } = require("./object");

const handlers = [
  handleData,
  handleObject,
  handleBinary,
  handleControl,
  handleEnv,
  handleFunction,
];

async function executeInstruction(vm, state, instruction) {
  for (let index = 0; index < handlers.length; index += 1) {
    const handler = handlers[index];
    const result = await handler(vm, state, instruction);
    if (result !== undefined) {
      return result;
    }
  }

  throw new Error(`Unsupported VM opcode: ${instruction[0]}`);
}

function executeInstructionSync(vm, state, instruction) {
  for (let index = 0; index < handlers.length; index += 1) {
    const handler = handlers[index];
    if (handler === handleFunction) {
      const result = handleFunctionSync(vm, state, instruction);
      if (result !== undefined) {
        return result;
      }
      continue;
    }

    const result = handler(vm, state, instruction);
    if (result && typeof result.then === "function") {
      throw new Error(`Async opcode used in sync VM path: ${instruction[0]}`);
    }
    if (result !== undefined) {
      return result;
    }
  }

  throw new Error(`Unsupported VM opcode: ${instruction[0]}`);
}

module.exports = {
  executeInstruction,
  executeInstructionSync,
};

export {};
