const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const legacyOneClick = require("../../../.opencode/skills/manga-translate-zhtw/scripts/one_click_translate.js");

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function buildBootstrapPipelineSteps(engines) {
  const steps = [
    engines.detect,
    engines.fontDetect,
    engines.segment,
    engines.bubbleSegment,
    engines.ocr,
  ].filter(Boolean);

  if (!steps.includes(engines.detect) || !steps.includes(engines.ocr)) {
    throw new Error("Post-edit rebuild requires detect and ocr engines.");
  }

  return steps;
}

function buildExportPipelineSteps(engines) {
  const steps = [engines.clean, engines.render].filter(Boolean);
  if (!steps.includes(engines.clean) || !steps.includes(engines.render)) {
    throw new Error("Post-edit export requires clean and render engines.");
  }
  return steps;
}

function normalizeSceneTextNode(pageName, pageId, nodeId, node = {}) {
  const textKind = node?.kind?.text || {};
  const transform = node?.transform || {};
  const x = Number.isFinite(transform.x) ? transform.x : 0;
  const y = Number.isFinite(transform.y) ? transform.y : 0;
  const width = Number.isFinite(transform.width) ? transform.width : 0;
  const height = Number.isFinite(transform.height) ? transform.height : 0;

  return {
    pageName,
    pageId,
    nodeId,
    originalText: textKind.text || "",
    anchor: {
      pageName,
      x,
      y,
      width,
      height,
      centerX: x + width / 2,
      centerY: y + height / 2,
    },
  };
}

function collectSceneTextNodes(scene) {
  const pageEntries = Object.entries(scene?.scene?.pages || {});
  const byPageName = new Map();

  for (const [pageId, page] of pageEntries) {
    const pageName = page?.name || pageId;
    const nodes = Object.entries(page?.nodes || {})
      .filter(([, node]) => Boolean(node?.kind?.text))
      .map(([nodeId, node]) => normalizeSceneTextNode(pageName, pageId, nodeId, node));
    byPageName.set(pageName, nodes);
  }

  return byPageName;
}

function geometryDistance(left, right) {
  return (
    Math.abs((left?.centerX || 0) - (right?.centerX || 0)) +
    Math.abs((left?.centerY || 0) - (right?.centerY || 0)) +
    Math.abs((left?.width || 0) - (right?.width || 0)) +
    Math.abs((left?.height || 0) - (right?.height || 0))
  );
}

function textMismatchPenalty(expectedText, candidateText) {
  if (expectedText === candidateText) {
    return 0;
  }
  if (!expectedText || !candidateText) {
    return 5000;
  }
  if (candidateText.includes(expectedText) || expectedText.includes(candidateText)) {
    return 200;
  }
  return 2000 + Math.abs(expectedText.length - candidateText.length) * 5;
}

function matchPostEditDocumentToScene(postEditDocument, scene) {
  const byPageName = collectSceneTextNodes(scene);
  const matches = [];
  const unresolved = [];

  for (const pageId of postEditDocument.pageOrder || []) {
    const page = postEditDocument.pages?.[pageId];
    if (!page) {
      continue;
    }

    const candidates = [...(byPageName.get(page.pageName) || [])];
    if (candidates.length === 0) {
      for (const nodeId of page.nodeOrder || []) {
        unresolved.push({
          pageName: page.pageName,
          nodeId,
          reason: "No rebuilt scene page matched the stored pageName.",
        });
      }
      continue;
    }

    const used = new Set();
    for (const nodeId of page.nodeOrder || []) {
      const node = page.nodes?.[nodeId];
      if (!node) {
        continue;
      }

      const ranked = candidates
        .filter((candidate) => !used.has(candidate.nodeId))
        .map((candidate) => ({
          candidate,
          score:
            geometryDistance(node.anchor, candidate.anchor) +
            textMismatchPenalty(node.originalText, candidate.originalText),
        }))
        .sort((left, right) => left.score - right.score);

      const best = ranked[0];
      if (!best || best.score >= 10000) {
        unresolved.push({
          pageName: page.pageName,
          nodeId,
          reason: "No safe rebuilt scene node matched the stored anchor/text.",
        });
        continue;
      }

      used.add(best.candidate.nodeId);
      matches.push({
        documentPageId: pageId,
        documentNodeId: nodeId,
        pageName: page.pageName,
        rebuiltPageId: best.candidate.pageId,
        rebuiltNodeId: best.candidate.nodeId,
        editedTranslation: node.editedTranslation || "",
      });
    }
  }

  return {
    matches,
    unresolved,
  };
}

function buildTranslationPatchOps(matches) {
  const ops = [];
  for (const match of matches) {
    ops.push({
      updateNode: {
        page: match.rebuiltPageId,
        id: match.rebuiltNodeId,
        patch: {
          data: {
            text: {
              translation: match.editedTranslation || "",
            },
          },
        },
      },
    });
  }
  return ops;
}

function renamePageEntry(fileName, targetIndex) {
  const newPrefix = `page-${String(targetIndex + 1).padStart(3, "0")}-`;
  if (/^page-\d+-/i.test(fileName)) {
    return fileName.replace(/^page-\d+-/i, newPrefix);
  }
  return `${newPrefix}${fileName}`;
}

function runPowerShell(command) {
  const result = spawnSync("powershell", ["-NoProfile", "-Command", command], {
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "PowerShell command failed.");
  }
}

function reorderRenderedZip({ zipPath, sourcePageOrder, targetPageOrder, workspaceRoot }) {
  if (!zipPath.toLowerCase().endsWith(".zip")) {
    return zipPath;
  }
  if (!Array.isArray(sourcePageOrder) || !Array.isArray(targetPageOrder)) {
    return zipPath;
  }
  if (sourcePageOrder.join("|") === targetPageOrder.join("|")) {
    return zipPath;
  }

  const expandDir = path.join(workspaceRoot, "expanded");
  const stagedDir = path.join(workspaceRoot, "staged");
  const reorderedPath = path.join(path.dirname(zipPath), `post_edit_${path.basename(zipPath)}`);

  fs.rmSync(expandDir, { recursive: true, force: true });
  fs.rmSync(stagedDir, { recursive: true, force: true });
  fs.rmSync(reorderedPath, { force: true });
  ensureDir(expandDir);
  ensureDir(stagedDir);

  runPowerShell(`Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${expandDir}' -Force`);

  const exportedFiles = fs
    .readdirSync(expandDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));

  const fileByPageId = new Map();
  sourcePageOrder.forEach((pageId, index) => {
    if (exportedFiles[index]) {
      fileByPageId.set(pageId, exportedFiles[index]);
    }
  });

  targetPageOrder.forEach((pageId, index) => {
    const sourceFile = fileByPageId.get(pageId);
    if (!sourceFile) {
      return;
    }
    const renamed = renamePageEntry(sourceFile, index);
    fs.copyFileSync(path.join(expandDir, sourceFile), path.join(stagedDir, renamed));
  });

  runPowerShell(`Compress-Archive -LiteralPath '${path.join(stagedDir, "*")}' -DestinationPath '${reorderedPath}' -Force`);
  return reorderedPath;
}

function createRebuiltProjectName(date = new Date()) {
  const timestamp = date.toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  return `post_edit_rebuild_${timestamp}`;
}

module.exports = {
  buildBootstrapPipelineSteps,
  buildExportPipelineSteps,
  buildTranslationPatchOps,
  createRebuiltProjectName,
  matchPostEditDocumentToScene,
  reorderRenderedZip,
  uploadPages: legacyOneClick.uploadPages,
  startPipeline: legacyOneClick.startPipeline,
};
