// @ts-nocheck
const { OpCode } = require("../../bytecode/opcodes");

function handleObject(_vm, state, instruction) {
  switch (instruction[0]) {
    case OpCode.SETFIELD: {
      const objectRegister = instruction[1];
      const propertyRegister = instruction[2];
      const valueRegister = instruction[3];
      const object = state.resolveValue(objectRegister);
      const property = state.resolveValue(propertyRegister);
      if (object === null || object === undefined) {
        throw new TypeError(`Cannot set property ${String(property)} of ${object}`);
      }
      object[property] = state.resolveValue(valueRegister);
      return null;
    }
    case OpCode.GETFIELD: {
      const destRegister = instruction[1];
      const objectRegister = instruction[2];
      const propertyRegister = instruction[3];
      const object = state.resolveValue(objectRegister);
      const property = state.resolveValue(propertyRegister);
      state.setRegister(destRegister, object === null || object === undefined ? undefined : object[property]);
      return null;
    }
    case OpCode.ARRAYPUSH: {
      const arrayRegister = instruction[1];
      const valueRegister = instruction[2];
      const array = state.resolveValue(arrayRegister);
      array.push(state.resolveValue(valueRegister));
      return null;
    }
    default:
      return undefined;
  }
}

module.exports = {
  handleObject,
};

export {};
