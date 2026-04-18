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
]);
const UNSUPPORTED_VM_FLAGS = new Set(["async"]);
const UNSUPPORTED_VM_FEATURES = new Set(["IsHTMLDDA"]);

function getVmExecutionPlan(code, metadata) {
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
    if (UNSUPPORTED_VM_FEATURES.has(feature)) {
      return {
        eligible: false,
        classification: "unsupported-feature",
        reason: `Feature ${feature} is not supported by the VM runner.`,
      };
    }
  }

  if (code.includes("$262") && !metadata.features.includes("cross-realm")) {
    return {
      eligible: false,
      classification: "unsupported-harness",
      reason: "$262 harness helpers are not supported by the VM runner for this test.",
    };
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

function buildVmSource(code, metadata) {
  if (metadata.sourceType === "script" && metadata.flags.includes("onlyStrict")) {
    return `"use strict";\n${code}`;
  }

  return code;
}

module.exports = {
  buildVmSource,
  getVmExecutionPlan,
  parseTest262Metadata,
};

export {};
