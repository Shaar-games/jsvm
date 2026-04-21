// @ts-nocheck
function hasUseStrictDirective(node) {
  const body = node && Array.isArray(node.body) ? node.body : [];
  for (const statement of body) {
    if (statement.type !== "ExpressionStatement") {
      return false;
    }
    if (statement.directive === "use strict") {
      return true;
    }
    if (!statement.directive) {
      return false;
    }
  }
  return false;
}

module.exports = {
  hasUseStrictDirective,
};

export {};
