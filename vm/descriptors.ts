// @ts-nocheck

function createDataDescriptor(value, writable = true, enumerable = true, configurable = true) {
  const descriptor = Object.create(null);
  descriptor.value = value;
  descriptor.writable = writable;
  descriptor.enumerable = enumerable;
  descriptor.configurable = configurable;
  return descriptor;
}

function defineDataProperty(target, property, value, writable = true, enumerable = true, configurable = true) {
  Object.defineProperty(target, property, createDataDescriptor(value, writable, enumerable, configurable));
}

function createAccessorDescriptor(get, set, enumerable = false, configurable = true) {
  const descriptor = Object.create(null);
  if (get !== undefined) {
    descriptor.get = get;
  }
  if (set !== undefined) {
    descriptor.set = set;
  }
  descriptor.enumerable = enumerable;
  descriptor.configurable = configurable;
  return descriptor;
}

function defineAccessorProperty(target, property, get, set, enumerable = false, configurable = true) {
  Object.defineProperty(target, property, createAccessorDescriptor(get, set, enumerable, configurable));
}

module.exports = {
  createAccessorDescriptor,
  createDataDescriptor,
  defineAccessorProperty,
  defineDataProperty,
};

export {};
