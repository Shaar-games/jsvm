// @ts-nocheck
const nodeVm = require("vm");

class Test262Error extends Error {
  constructor(message) {
    super(message);
    this.name = "Test262Error";
  }
}

function isSameValue(left, right) {
  if (left === right) {
    return left !== 0 || 1 / left === 1 / right;
  }

  return left !== left && right !== right;
}

function formatValue(value) {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (typeof value === "number" && Object.is(value, -0)) {
    return "-0";
  }
  try {
    return String(value);
  } catch (error) {
    if (error && error.name === "TypeError") {
      return Object.prototype.toString.call(value);
    }
    throw error;
  }
}

function compareArray(actual, expected) {
  if (!actual || !expected || actual.length !== expected.length) {
    return false;
  }

  for (let index = 0; index < actual.length; index += 1) {
    if (!isSameValue(actual[index], expected[index])) {
      return false;
    }
  }

  return true;
}

function assert(mustBeTrue, message) {
  if (mustBeTrue === true) {
    return;
  }

  throw new Test262Error(message || `Expected true but got ${formatValue(mustBeTrue)}`);
}

assert._isSameValue = isSameValue;
assert._toString = formatValue;

assert.sameValue = function sameValue(actual, expected, message) {
  if (isSameValue(actual, expected)) {
    return;
  }

  throw new Test262Error(
    message || `Expected SameValue(${formatValue(actual)}, ${formatValue(expected)}) to be true`
  );
};

assert.notSameValue = function notSameValue(actual, unexpected, message) {
  if (!isSameValue(actual, unexpected)) {
    return;
  }

  throw new Test262Error(
    message || `Expected SameValue(${formatValue(actual)}, ${formatValue(unexpected)}) to be false`
  );
};

assert.throws = function throwsAssert(expectedErrorConstructor, callback, message) {
  if (typeof callback !== "function") {
    throw new Test262Error("assert.throws requires an error constructor and a callback");
  }

  try {
    callback();
  } catch (error) {
    if (!error || typeof error !== "object") {
      throw new Test262Error(message || "Thrown value was not an object");
    }

    if (error.constructor !== expectedErrorConstructor) {
      throw new Test262Error(
        message ||
          `Expected ${expectedErrorConstructor && expectedErrorConstructor.name}, got ${error.constructor && error.constructor.name}`
      );
    }

    return;
  }

  throw new Test262Error(
    message || `Expected ${expectedErrorConstructor && expectedErrorConstructor.name} to be thrown`
  );
};

assert.compareArray = function compareArrayAssert(actual, expected, message) {
  if (compareArray(actual, expected)) {
    return;
  }

  throw new Test262Error(
    message || "Expected arrays to have the same contents"
  );
};

function createTest262Harness() {
  function verifyProperty(obj, name, desc, options = {}) {
    const actual = Object.getOwnPropertyDescriptor(obj, name);
    if (!actual) {
      throw new Test262Error(`Property ${String(name)} not found`);
    }

    if ("value" in desc && !isSameValue(actual.value, desc.value)) {
      throw new Test262Error(`Expected descriptor value for ${String(name)} to match`);
    }
    if ("enumerable" in desc && actual.enumerable !== desc.enumerable) {
      throw new Test262Error(`Expected descriptor.enumerable for ${String(name)} to match`);
    }
    if ("writable" in desc && actual.writable !== desc.writable) {
      throw new Test262Error(`Expected descriptor.writable for ${String(name)} to match`);
    }
    if ("configurable" in desc && actual.configurable !== desc.configurable) {
      throw new Test262Error(`Expected descriptor.configurable for ${String(name)} to match`);
    }
    if ("get" in desc && actual.get !== desc.get) {
      throw new Test262Error(`Expected descriptor.get for ${String(name)} to match`);
    }
    if ("set" in desc && actual.set !== desc.set) {
      throw new Test262Error(`Expected descriptor.set for ${String(name)} to match`);
    }

    if (options.restore) {
      Object.defineProperty(obj, name, actual);
    }
  }

  function verifyWritable(obj, name, verifyProp, value) {
    const oldValue = obj[name];
    const testValue = arguments.length > 3 ? value : "unlikelyValue";
    let writeSucceeded = true;
    try {
      obj[name] = testValue;
    } catch {
      writeSucceeded = false;
    }
    if (!writeSucceeded || !isSameValue(obj[name], testValue)) {
      throw new Test262Error(`Expected ${String(name)} to be writable`);
    }
    if (verifyProp) {
      assert.sameValue(verifyProp.value, testValue);
    }
    obj[name] = oldValue;
  }

  function verifyNotWritable(obj, name, verifyProp, value) {
    const oldValue = obj[name];
    const testValue = arguments.length > 3 ? value : "unlikelyValue";
    try {
      obj[name] = testValue;
    } catch {}
    if (!isSameValue(obj[name], oldValue)) {
      throw new Test262Error(`Expected ${String(name)} to be non-writable`);
    }
    if (verifyProp) {
      assert.sameValue(verifyProp.value, oldValue);
    }
  }

  function verifyEnumerable(obj, name) {
    if (!Object.prototype.propertyIsEnumerable.call(obj, name)) {
      throw new Test262Error(`Expected ${String(name)} to be enumerable`);
    }
  }

  function verifyNotEnumerable(obj, name) {
    if (Object.prototype.propertyIsEnumerable.call(obj, name)) {
      throw new Test262Error(`Expected ${String(name)} to be non-enumerable`);
    }
  }

  function verifyConfigurable(obj, name) {
    const desc = Object.getOwnPropertyDescriptor(obj, name);
    if (!desc || !desc.configurable) {
      throw new Test262Error(`Expected ${String(name)} to be configurable`);
    }
  }

  function verifyNotConfigurable(obj, name) {
    const desc = Object.getOwnPropertyDescriptor(obj, name);
    if (!desc || desc.configurable) {
      throw new Test262Error(`Expected ${String(name)} to be non-configurable`);
    }
  }

  function isConstructor(value) {
    if (typeof value !== "function") {
      return false;
    }
    try {
      Reflect.construct(function noop() {}, [], value);
      return true;
    } catch {
      return false;
    }
  }

  function createRealm() {
    const sandbox = {};
    const context = nodeVm.createContext(sandbox);
    const global = nodeVm.runInContext("this", context);
    return {
      global,
      evalScript(source) {
        return nodeVm.runInContext(source, context);
      },
    };
  }

  const $262 = {
    global: globalThis,
    createRealm,
    evalScript(source) {
      return nodeVm.runInThisContext(source);
    },
    gc() {},
  };

  return {
    $262,
    Test262Error,
    assert,
    compareArray,
    verifyProperty,
    verifyWritable,
    verifyNotWritable,
    verifyEnumerable,
    verifyNotEnumerable,
    verifyConfigurable,
    verifyNotConfigurable,
    isConstructor,
    print: () => {},
  };
}

module.exports = {
  Test262Error,
  compareArray,
  createTest262Harness,
};

export {};
