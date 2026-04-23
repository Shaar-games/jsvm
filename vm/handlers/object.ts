// @ts-nocheck
const { OpCode } = require("../../bytecode/opcodes");
const { defineDataProperty } = require("../descriptors");

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
    && object === RuntimeArray.prototype) {
    return RuntimeArray;
  }
  const RuntimeString = vm && vm.globalObject ? vm.globalObject.String : null;
  if (typeof object === "string" && property === "length") {
    return object.length;
  }
  if (RuntimeString
    && RuntimeString.__jsvmRuntimeStringConstructor
    && typeof object === "string"
    && RuntimeString.prototype
    && property in RuntimeString.prototype) {
    return RuntimeString.prototype[property];
  }
  if (object !== null
    && object !== undefined
    && (typeof object === "object" || typeof object === "function")
    && Object.prototype.hasOwnProperty.call(object, property)) {
    return object[property];
  }
  if (property === "constructor"
    && RuntimeArray
    && RuntimeArray.__jsvmRuntimeArrayConstructor
    && Array.isArray(object)) {
    return RuntimeArray;
  }
  return object[property];
}

function copyObjectSpreadProperties(target, source) {
  if (source === null || source === undefined) {
    return;
  }

  const from = Object(source);
  for (const key of Reflect.ownKeys(from)) {
    const descriptor = Object.getOwnPropertyDescriptor(from, key);
    if (!descriptor || !descriptor.enumerable) {
      continue;
    }
    defineDataProperty(target, key, from[key]);
  }
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
      defineDataProperty(object, property, state.resolveValue(valueRegister));
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
    case OpCode.OBJECTSPREAD: {
      const objectRegister = instruction[1];
      const sourceRegister = instruction[2];
      const object = state.resolveValue(objectRegister);
      if (object === null || object === undefined) {
        throw new TypeError(`Cannot spread into ${object}`);
      }
      copyObjectSpreadProperties(object, state.resolveValue(sourceRegister));
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
      defineDataProperty(array, index, state.resolveValue(valueRegister));
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
