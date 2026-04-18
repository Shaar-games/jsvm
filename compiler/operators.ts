// @ts-nocheck
const binaryOperatorMap = {
  "+": "ADD",
  "-": "SUB",
  "*": "MUL",
  "/": "DIV",
  "**": "POW",
  "&": "BAND",
  "|": "BOR",
  "^": "BXOR",
  "<<": "LSH",
  ">>": "RSH",
  "<<<": "ULSH",
  ">>>": "URSH",
  "%": "MOD",
  "===": "ISEQ",
  "==": "ISEQ",
  "!==": "ISNE",
  "!=": "ISNE",
  "<": "ISLT",
  ">": "ISGT",
  "<=": "ISLE",
  ">=": "ISGE",
  "in": "ISIN",
  "instanceof": "ISINSTANCE",
};

function getBinaryOpcodeName(operator) {
  return binaryOperatorMap[operator] || null;
}

function getAssignmentBinaryOpcodeName(operator) {
  if (operator === "=") {
    return null;
  }

  const binaryOperator = operator.slice(0, -1);
  return getBinaryOpcodeName(binaryOperator);
}

module.exports = {
  getAssignmentBinaryOpcodeName,
  getBinaryOpcodeName,
};

export {};
