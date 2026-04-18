// @ts-nocheck
async function withAnnexBBlockFunctionContext(context, callback) {
  if (context.options.sourceType !== "script") {
    return callback();
  }

  const previous = context.annexBBlockFunctionContext;
  context.annexBBlockFunctionContext = true;
  try {
    return await callback();
  } finally {
    context.annexBBlockFunctionContext = previous;
  }
}

module.exports = {
  withAnnexBBlockFunctionContext,
};

export {};
