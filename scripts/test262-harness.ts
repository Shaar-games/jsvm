// @ts-nocheck
const nodeVm = require("vm");
const { normalizeLegacyBuiltins } = require("../vm/runtime");

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

function createTest262Harness(options = {}) {
  const abstractModuleSource = createAbstractModuleSourceIntrinsic();

  function descriptorOf(obj, name) {
    return Object.getOwnPropertyDescriptor(obj, name);
  }

  function isWritable(obj, name, verifyProp, value) {
    const hadValue = Object.prototype.hasOwnProperty.call(obj, name);
    const oldValue = obj[name];
    let newValue = arguments.length > 3 ? value : "unlikelyValue";
    if (Object.is(newValue, oldValue)) {
      newValue = `${String(newValue)}2`;
    }

    try {
      obj[name] = newValue;
    } catch (error) {
      if (!(error instanceof TypeError)) {
        throw error;
      }
    }

    const observedKey = verifyProp || name;
    const writeSucceeded = assert._isSameValue(obj[observedKey], newValue);

    if (writeSucceeded) {
      if (hadValue) {
        obj[name] = oldValue;
      } else {
        delete obj[name];
      }
    }

    return writeSucceeded;
  }

  function isConfigurable(obj, name) {
    try {
      delete obj[name];
    } catch (error) {
      if (!(error instanceof TypeError)) {
        throw error;
      }
    }
    return !Object.prototype.hasOwnProperty.call(obj, name);
  }

  function verifyProperty(obj, name, desc, options = {}) {
    const actual = Object.getOwnPropertyDescriptor(obj, name);
    if (desc === undefined) {
      if (actual) {
        throw new Test262Error(`Property ${String(name)} should be absent`);
      }
      return;
    }

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
    if (!verifyProp) {
      const desc = descriptorOf(obj, name);
      assert(desc && desc.writable, `Expected ${String(name)} to have writable:true.`);
    }
    if (!isWritable(obj, name, verifyProp, value)) {
      throw new Test262Error(`Expected ${String(name)} to be writable`);
    }
  }

  function verifyNotWritable(obj, name, verifyProp, value) {
    if (!verifyProp) {
      const desc = descriptorOf(obj, name);
      assert(desc && !desc.writable, `Expected ${String(name)} to have writable:false.`);
    }
    if (isWritable(obj, name, verifyProp, value)) {
      throw new Test262Error(`Expected ${String(name)} NOT to be writable`);
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
    const desc = descriptorOf(obj, name);
    assert(desc && desc.configurable, `Expected ${String(name)} to have configurable:true.`);
    if (!isConfigurable(obj, name)) {
      throw new Test262Error(`Expected ${String(name)} to be configurable`);
    }
  }

  function verifyNotConfigurable(obj, name) {
    const desc = descriptorOf(obj, name);
    assert(desc && !desc.configurable, `Expected ${String(name)} to have configurable:false.`);
    if (isConfigurable(obj, name)) {
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
    if (typeof options.createRealm === "function") {
      return options.createRealm();
    }
    const sandbox = {};
    const context = nodeVm.createContext(sandbox);
    const global = nodeVm.runInContext("this", context);
    normalizeLegacyBuiltins(global);
    return {
      global,
      evalScript(source) {
        return nodeVm.runInContext(source, context);
      },
    };
  }

  const $262 = {
    global: options.global || globalThis,
    createRealm,
    evalScript(source) {
      if (typeof options.evalScript === "function") {
        return options.evalScript(source);
      }
      return nodeVm.runInThisContext(source);
    },
    AbstractModuleSource: abstractModuleSource,
    IsHTMLDDA: options.IsHTMLDDA,
    gc() {},
  };

  return {
    $262,
    Test262Error,
    assert,
    compareArray,
    verifyProperty,
    verifyPrimordialProperty: verifyProperty,
    verifyWritable,
    verifyNotWritable,
    verifyEnumerable,
    verifyNotEnumerable,
    verifyConfigurable,
    verifyNotConfigurable,
    isConstructor,
    verifyPrimordialCallableProperty: verifyCallableProperty,
    print: () => {},
  };
}

function verifyCallableProperty(obj, name, desc, options = {}) {
  verifyProperty(obj, name, desc, options);
  if (typeof obj[name] !== "function") {
    throw new Test262Error(`Expected ${String(name)} to be callable`);
  }
}

function createAbstractModuleSourceIntrinsic() {
  function AbstractModuleSource() {
    throw new TypeError("AbstractModuleSource cannot be constructed");
  }
  const prototype = {};

  Object.defineProperty(prototype, Symbol.toStringTag, {
    get() {
      if (this === null || this === undefined || (typeof this !== "object" && typeof this !== "function")) {
        return undefined;
      }
      return this.__moduleSourceClassName;
    },
    set: undefined,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(prototype, "constructor", {
    value: AbstractModuleSource,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  Object.defineProperty(AbstractModuleSource, "prototype", {
    value: prototype,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  Object.defineProperty(AbstractModuleSource, "length", {
    value: 0,
    writable: false,
    enumerable: false,
    configurable: true,
  });

  return AbstractModuleSource;
}

module.exports = {
  Test262Error,
  compareArray,
  createTest262Harness,
};

export {};
