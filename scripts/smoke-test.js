const fs = require("fs");
const path = require("path");

const distDir = path.join(__dirname, "..", "dist");
const bundlePath = path.join(distDir, "index.js");
const mapPath = path.join(distDir, "index.js.map");
const registerPath = path.join(distDir, "sourcemap-register.js");

function assert(condition, message) {
  if (!condition) {
    const error = new Error(message);
    error.name = "SmokeTestError";
    throw error;
  }
}

function requireFileExists(filePath, label) {
  assert(fs.existsSync(filePath), `${label} is missing.`);
}

function requireMinSize(filePath, size, label) {
  const stats = fs.statSync(filePath);
  assert(stats.size >= size, `${label} looks too small (${stats.size} bytes).`);
}

function requireNotEmpty(filePath, label) {
  const content = fs.readFileSync(filePath, "utf8");
  assert(content.trim().length > 0, `${label} is empty.`);
}

function runPositiveScenario() {
  console.log("Running positive smoke test scenario...");
  requireFileExists(distDir, "dist directory");
  requireFileExists(bundlePath, "bundled action (dist/index.js)");
  requireFileExists(mapPath, "source map (dist/index.js.map)");
  requireFileExists(registerPath, "source map register (dist/sourcemap-register.js)");

  requireMinSize(bundlePath, 1024, "dist/index.js");
  requireMinSize(mapPath, 1024, "dist/index.js.map");
  requireMinSize(registerPath, 1024, "dist/sourcemap-register.js");

  requireNotEmpty(bundlePath, "dist/index.js");
  requireNotEmpty(mapPath, "dist/index.js.map");
  requireNotEmpty(registerPath, "dist/sourcemap-register.js");
  console.log("Positive scenario passed.");
}

function runNegativeScenario() {
  console.log("Running negative smoke test scenario...");
  const missingPath = path.join(distDir, "__nonexistent__.js");
  let caught = false;
  try {
    requireFileExists(missingPath, "nonexistent file");
  } catch (error) {
    caught = true;
    assert(
      error instanceof Error && /missing/.test(error.message),
      "Negative scenario produced an unexpected error message"
    );
  }
  assert(caught, "Negative scenario did not detect missing file.");
  console.log("Negative scenario passed (missing file correctly detected).");
}

try {
  runPositiveScenario();
  runNegativeScenario();
  console.log("All smoke test scenarios passed.");
} catch (error) {
  console.error(`Smoke test failed: ${error.message}`);
  process.exit(1);
}
