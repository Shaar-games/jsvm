// @ts-nocheck
function extractFrontmatter(code) {
  const frontmatterMatch = code.match(/\/\*---([\s\S]*?)---\*\//);
  return frontmatterMatch ? frontmatterMatch[1] : "";
}

function parseListField(frontmatter, fieldName) {
  const match = frontmatter.match(new RegExp(`${fieldName}:\\s*\\[([^\\]]*)\\]`));
  if (!match) {
    return [];
  }

  return match[1]
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.replace(/^['"]|['"]$/g, ""));
}

function parseNegative(frontmatter) {
  const negativeBlock = frontmatter.match(/negative:\s*([\s\S]*?)(?:\n[a-zA-Z][^:\n]*:|\n---|$)/);
  if (!negativeBlock) {
    return {
      phase: null,
      type: null,
    };
  }

  const phaseMatch = negativeBlock[1].match(/phase:\s*([^\n]+)/);
  const typeMatch = negativeBlock[1].match(/type:\s*([^\n]+)/);
  return {
    phase: phaseMatch ? phaseMatch[1].trim() : null,
    type: typeMatch ? typeMatch[1].trim() : null,
  };
}

function parseTest262Metadata(code) {
  const frontmatter = extractFrontmatter(code);
  const flags = parseListField(frontmatter, "flags");
  const includes = parseListField(frontmatter, "includes");
  const features = parseListField(frontmatter, "features");
  const negative = parseNegative(frontmatter);

  return {
    flags,
    includes,
    features,
    negativePhase: negative.phase,
    negativeType: negative.type,
    sourceType: flags.includes("module") ? "module" : "script",
    expectCompileFailure: negative.phase === "parse",
  };
}

const SUPPORTED_VM_INCLUDES = new Set([
  "assert.js",
  "compareArray.js",
  "propertyHelper.js",
  "isConstructor.js",
  "fnGlobalObject.js",
  "testTypedArray.js",
  "iteratorZipUtils.js",
  "proxyTrapsHelper.js",
  "asyncHelpers.js",
  "promiseHelper.js",
  "detachArrayBuffer.js",
  "resizableArrayBufferUtils.js",
]);
const SOURCE_PRELOADED_VM_INCLUDES = new Set([
  "testTypedArray.js",
  "iteratorZipUtils.js",
  "proxyTrapsHelper.js",
  "asyncHelpers.js",
  "promiseHelper.js",
  "detachArrayBuffer.js",
  "resizableArrayBufferUtils.js",
]);
const UNSUPPORTED_VM_FLAGS = new Set([]);
const UNSUPPORTED_VM_FEATURES_BY_HOST = {
  node: new Set(["IsHTMLDDA"]),
};

function getUnsupportedVmFeatures(hostRuntime = "node") {
  return UNSUPPORTED_VM_FEATURES_BY_HOST[hostRuntime] || new Set();
}

function getVmExecutionPlan(code, metadata, options = {}) {
  const hostRuntime = options.hostRuntime || "node";
  const unsupportedVmFeatures = getUnsupportedVmFeatures(hostRuntime);

  if (metadata.expectCompileFailure) {
    return {
      eligible: false,
      classification: "unsupported-negative-phase",
      reason: "Parse-negative tests are compile-only and are not executed in the VM.",
    };
  }

  if (metadata.negativePhase && !["runtime", "resolution"].includes(metadata.negativePhase)) {
    return {
      eligible: false,
      classification: "unsupported-negative-phase",
      reason: `Negative phase ${metadata.negativePhase} is not supported by the VM runner.`,
    };
  }

  for (const flag of metadata.flags) {
    if (UNSUPPORTED_VM_FLAGS.has(flag)) {
      return {
        eligible: false,
        classification: "unsupported-flag",
        reason: `Flag ${flag} is not supported by the VM runner.`,
      };
    }
  }

  for (const include of metadata.includes) {
    if (!SUPPORTED_VM_INCLUDES.has(include)) {
      return {
        eligible: false,
        classification: "unsupported-harness",
        reason: `Harness include ${include} is not supported by the VM runner.`,
      };
    }
  }

  for (const feature of metadata.features) {
    if (unsupportedVmFeatures.has(feature)) {
      return {
        eligible: false,
        classification: "unsupported-feature",
        reason: `Feature ${feature} is not supported by the VM runner on ${hostRuntime}.`,
      };
    }
  }

  if (code.includes("$DONE")) {
    return {
      eligible: false,
      classification: "unsupported-harness",
      reason: "$DONE async harness is not supported by the VM runner.",
    };
  }

  return {
    eligible: true,
    classification: null,
    reason: null,
  };
}

function canExecuteInVmHost(code, metadata, hostRuntime = "node") {
  return getVmExecutionPlan(code, metadata, { hostRuntime }).eligible;
}

function buildVmSource(code, metadata, harnessRoot = null) {
  const sourceChunks = [];

  if (metadata.sourceType === "script" && metadata.flags.includes("onlyStrict")) {
    sourceChunks.push(`"use strict";`);
  }

  if (harnessRoot) {
    for (const include of metadata.includes) {
      if (!SOURCE_PRELOADED_VM_INCLUDES.has(include)) {
        continue;
      }

      const includePath = path.join(harnessRoot, include);
      sourceChunks.push(fs.readFileSync(includePath, "utf8"));
    }
  }

  sourceChunks.push(code);
  return sourceChunks.join("\n");
}

module.exports = {
  buildVmSource,
  canExecuteInVmHost,
  getVmExecutionPlan,
  parseTest262Metadata,
};

export {};
const fs = require("fs");
const path = require("path");
