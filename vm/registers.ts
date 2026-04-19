// @ts-nocheck
function registerIndex(registerName) {
  if (typeof registerName !== "string" || !/^R\d+$/.test(registerName)) {
    return null;
  }
  return Number(registerName.slice(1));
}

function createRegisters() {
  return [];
}

function getRegister(registers, registerName) {
  const index = registerIndex(registerName);
  return index === null ? undefined : registers[index];
}

function setRegister(registers, registerName, value) {
  const index = registerIndex(registerName);
  if (index === null) {
    throw new Error(`Invalid register name: ${registerName}`);
  }
  Object.defineProperty(registers, index, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return value;
}

module.exports = {
  createRegisters,
  getRegister,
  registerIndex,
  setRegister,
};

export {};
