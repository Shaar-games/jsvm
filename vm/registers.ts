// @ts-nocheck
const { defineDataProperty } = require("./descriptors");

function registerIndex(registerName) {
  if (typeof registerName !== "string" || registerName.length < 2 || registerName[0] !== "R") {
    return null;
  }
  let index = 0;
  for (let offset = 1; offset < registerName.length; offset += 1) {
    const digit = registerName[offset];
    if (digit < "0" || digit > "9") {
      return null;
    }
    index = (index * 10) + (digit - "0");
  }
  return index;
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
  defineDataProperty(registers, index, value);
  return value;
}

module.exports = {
  createRegisters,
  getRegister,
  registerIndex,
  setRegister,
};

export {};
