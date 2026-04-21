// @ts-nocheck
const acorn = require("acorn");
const babelParser = require("@babel/parser");

function shouldUseBabelScriptFallback(sourceType, error) {
  if (sourceType !== "script" || !error) {
    return false;
  }

  const message = String(error && error.message ? error.message : error);
  return (
    message.includes("Assigning to rvalue")
    || message.includes("Assigning to rvalue")
    || message.includes("Invalid left-hand side")
    || message.includes("Binding invalid left-hand side")
  );
}

function parseSource(code, options = {}) {
  const { sourceType = "module" } = options;

  try {
    return acorn.parse(code, {
      ecmaVersion: 2022,
      sourceType,
      locations: true,
    });
  } catch (error) {
    if (!shouldUseBabelScriptFallback(sourceType, error)) {
      throw error;
    }

    const ast = babelParser.parse(code, {
      sourceType,
      errorRecovery: true,
      plugins: ["estree"],
    });

    return ast.program;
  }
}

module.exports = {
  parseSource,
};

export {};
