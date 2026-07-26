#!/usr/bin/env node

const {
  convertReferenceSet,
  createConvertedReferenceSetId,
} = require("../src/modules/reference_image_conversion");

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    referenceSetId: null,
    outputReferenceSetId: null,
    format: "png",
    overwrite: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--reference-set-id" && argv[index + 1]) {
      args.referenceSetId = argv[++index];
    } else if (arg.startsWith("--reference-set-id=")) {
      args.referenceSetId = arg.slice("--reference-set-id=".length);
    } else if (arg === "--output-reference-set-id" && argv[index + 1]) {
      args.outputReferenceSetId = argv[++index];
    } else if (arg.startsWith("--output-reference-set-id=")) {
      args.outputReferenceSetId = arg.slice("--output-reference-set-id=".length);
    } else if (arg === "--format" && argv[index + 1]) {
      args.format = argv[++index];
    } else if (arg.startsWith("--format=")) {
      args.format = arg.slice("--format=".length);
    } else if (arg === "--overwrite") {
      args.overwrite = true;
    }
  }

  if (!args.referenceSetId) {
    throw new Error("Missing required argument: --reference-set-id");
  }

  if (!args.outputReferenceSetId) {
    args.outputReferenceSetId = createConvertedReferenceSetId(args.referenceSetId);
  }

  return args;
}

async function main() {
  try {
    const args = parseArgs();
    const result = convertReferenceSet(args);
    console.log(
      JSON.stringify(
        {
          success: true,
          ...result,
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          success: false,
          error: error.message,
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
};
