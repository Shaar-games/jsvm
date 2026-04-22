// @ts-nocheck
const { OpCode } = require("../../bytecode/opcodes");

function getRuntimeProperty(vm, object, property) {
  const RuntimeFunction = vm && vm.globalObject ? vm.globalObject.Function : null;
  if (property === "constructor"
    && RuntimeFunction
    && RuntimeFunction.__jsvmRuntimeFunctionConstructor
    && object === RuntimeFunction.prototype) {
    return RuntimeFunction;
  }
  const RuntimeArray = vm && vm.globalObject ? vm.globalObject.Array : null;
  if (property === "constructor"
    && RuntimeArray
    && RuntimeArray.__jsvmRuntimeArrayConstructor
    && (object === RuntimeArray.prototype
      || (Array.isArray(object) && Object.getPrototypeOf(object) === RuntimeArray.prototype))) {
    return RuntimeArray;
  }
  return object[property];
}

function handleObject(vm, state, instruction) {
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
    case OpCode.DEFINEFIELD: {
      const objectRegister = instruction[1];
      const propertyRegister = instruction[2];
      const valueRegister = instruction[3];
      const object = state.resolveValue(objectRegister);
      const property = state.resolveValue(propertyRegister);
      if (object === null || object === undefined) {
        throw new TypeError(`Cannot define property ${String(property)} of ${object}`);
      }
      Object.defineProperty(object, property, {
        value: state.resolveValue(valueRegister),
        writable: true,
        enumerable: true,
        configurable: true,
      });
      return null;
    }
    case OpCode.DELETEFIELD: {
      const destRegister = instruction[1];
      const objectRegister = instruction[2];
      const propertyRegister = instruction[3];
      const object = state.resolveValue(objectRegister);
      const property = state.resolveValue(propertyRegister);
      if (object === null || object === undefined) {
        throw new TypeError(`Cannot delete property ${String(property)} of ${object}`);
      }
      state.setRegister(destRegister, delete object[property]);
      return null;
    }
    case OpCode.GETFIELD: {
      const destRegister = instruction[1];
      const objectRegister = instruction[2];
      const propertyRegister = instruction[3];
      const object = state.resolveValue(objectRegister);
      const property = state.resolveValue(propertyRegister);
      state.setRegister(destRegister, object === null || object === undefined ? undefined : getRuntimeProperty(vm, object, property));
      return null;
    }
    case OpCode.ARRAYPUSH: {
      const arrayRegister = instruction[1];
      const valueRegister = instruction[2];
      const array = state.resolveValue(arrayRegister);
      const index = array.length;
      Object.defineProperty(array, index, {
        value: state.resolveValue(valueRegister),
        writable: true,
        enumerable: true,
        configurable: true,
      });
      array.length = index + 1;
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
