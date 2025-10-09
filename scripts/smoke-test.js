const fs = require("fs");
const path = require("path");
const vm = require("vm");

const distDir = path.join(__dirname, "..", "dist");
const bundlePath = path.join(distDir, "index.js");
const mapPath = path.join(distDir, "index.js.map");
const registerPath = path.join(distDir, "sourcemap-register.js");

// Test configuration
const MIN_BUNDLE_SIZE = 1024;
const MAX_BUNDLE_SIZE = 10 * 1024 * 1024; // 10MB
const MIN_SOURCE_MAP_SIZE = 1024;
const MIN_REGISTER_SIZE = 1024;

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

function requireMaxSize(filePath, maxSize, label) {
  const stats = fs.statSync(filePath);
  assert(stats.size <= maxSize, `${label} is too large (${stats.size} bytes, max: ${maxSize}).`);
}

function requireValidJson(filePath, label) {
  const content = fs.readFileSync(filePath, "utf8");
  try {
    JSON.parse(content);
  } catch (error) {
    assert(false, `${label} contains invalid JSON: ${error.message}`);
  }
}

function requireContainsText(filePath, text, label) {
  const content = fs.readFileSync(filePath, "utf8");
  assert(content.includes(text), `${label} does not contain expected text: "${text}"`);
}

function requireValidJavaScript(filePath, label) {
  const content = fs.readFileSync(filePath, "utf8");
  try {
    // Try to create a VM context to validate JS syntax
    new vm.Script(content, { filename: filePath });
  } catch (error) {
    assert(false, `${label} contains invalid JavaScript: ${error.message}`);
  }
}

function runPositiveScenario() {
  console.log("Running positive smoke test scenario...");
  
  // File existence tests
  requireFileExists(distDir, "dist directory");
  requireFileExists(bundlePath, "bundled action (dist/index.js)");
  requireFileExists(mapPath, "source map (dist/index.js.map)");
  requireFileExists(registerPath, "source map register (dist/sourcemap-register.js)");

  // File size tests
  requireMinSize(bundlePath, MIN_BUNDLE_SIZE, "dist/index.js");
  requireMaxSize(bundlePath, MAX_BUNDLE_SIZE, "dist/index.js");
  requireMinSize(mapPath, MIN_SOURCE_MAP_SIZE, "dist/index.js.map");
  requireMinSize(registerPath, MIN_REGISTER_SIZE, "dist/sourcemap-register.js");

  // Content emptiness tests
  requireNotEmpty(bundlePath, "dist/index.js");
  requireNotEmpty(mapPath, "dist/index.js.map");
  requireNotEmpty(registerPath, "dist/sourcemap-register.js");
  
  console.log("Basic file tests passed.");
}

function runContentValidationTests() {
  console.log("Running content validation tests...");
  
  // Validate JavaScript syntax
  requireValidJavaScript(bundlePath, "dist/index.js");
  requireValidJavaScript(registerPath, "dist/sourcemap-register.js");
  
  // Validate JSON structure of source map
  requireValidJson(mapPath, "dist/index.js.map");
  
  // Check for expected content in bundle
  requireContainsText(bundlePath, "exports", "dist/index.js (should contain exports)");
  requireContainsText(bundlePath, "require", "dist/index.js (should contain require calls)");
  
  console.log("Content validation tests passed.");
}

function runBundleIntegrityTests() {
  console.log("Running bundle integrity tests...");
  
  // Check that the bundle can be loaded without immediate errors
  try {
    const bundleContent = fs.readFileSync(bundlePath, "utf8");
    
    // Should contain GitHub Actions core imports
    assert(
      bundleContent.includes("@actions/core") || bundleContent.includes("actions-core"),
      "Bundle should contain @actions/core dependency"
    );
    
    // Should contain GitHub Actions github imports
    assert(
      bundleContent.includes("@actions/github") || bundleContent.includes("actions-github"),
      "Bundle should contain @actions/github dependency"
    );
    
    // Should not contain development dependencies
    assert(
      !bundleContent.includes("typescript") || bundleContent.includes("// typescript"),
      "Bundle should not contain TypeScript runtime code"
    );
    
  } catch (error) {
    assert(false, `Bundle integrity check failed: ${error.message}`);
  }
  
  console.log("Bundle integrity tests passed.");
}

function runSourceMapValidationTests() {
  console.log("Running source map validation tests...");
  
  try {
    const sourceMapContent = fs.readFileSync(mapPath, "utf8");
    const sourceMap = JSON.parse(sourceMapContent);
    
    // Validate required source map fields
    assert(sourceMap.version !== undefined, "Source map should have version field");
    assert(Array.isArray(sourceMap.sources), "Source map should have sources array");
    assert(typeof sourceMap.mappings === "string", "Source map should have mappings string");
    assert(sourceMap.file !== undefined, "Source map should have file field");
    
    // Check that sources reference TypeScript files
    const hasTypeScriptSources = sourceMap.sources.some(source => 
      source.includes(".ts") || source.includes("src/")
    );
    assert(hasTypeScriptSources, "Source map should reference TypeScript source files");
    
  } catch (error) {
    assert(false, `Source map validation failed: ${error.message}`);
  }
  
  console.log("Source map validation tests passed.");
}

function runPerformanceTests() {
  console.log("Running performance tests...");
  
  const bundleStats = fs.statSync(bundlePath);
  const mapStats = fs.statSync(mapPath);
  const registerStats = fs.statSync(registerPath);
  
  console.log(`  Bundle size: ${(bundleStats.size / 1024).toFixed(2)} KB`);
  console.log(`  Source map size: ${(mapStats.size / 1024).toFixed(2)} KB`);
  console.log(`  Register size: ${(registerStats.size / 1024).toFixed(2)} KB`);
  
  // Performance assertions
  const totalSize = bundleStats.size + mapStats.size + registerStats.size;
  console.log(`  Total size: ${(totalSize / 1024).toFixed(2)} KB`);
  
  // Warn if bundle is getting large (but don't fail)
  if (bundleStats.size > 5 * 1024 * 1024) { // 5MB
    console.warn(`  Warning: Bundle size is quite large (${(bundleStats.size / 1024 / 1024).toFixed(2)} MB)`);
  }
  
  console.log("Performance tests completed.");
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

function runErrorScenarioTests() {
  console.log("Running error scenario tests...");
  
  // Test file size validation
  const testEmptyFile = path.join(__dirname, "test-empty.js");
  const testLargeFile = path.join(__dirname, "test-large.js");
  
  try {
    // Create temporary empty file
    fs.writeFileSync(testEmptyFile, "");
    
    let caught = false;
    try {
      requireMinSize(testEmptyFile, 100, "empty test file");
    } catch (error) {
      caught = true;
      assert(error.message.includes("too small"), "Should detect file too small");
    }
    assert(caught, "Should have caught empty file error");
    
    // Clean up
    fs.unlinkSync(testEmptyFile);
    
  } catch (error) {
    // Clean up on error
    if (fs.existsSync(testEmptyFile)) fs.unlinkSync(testEmptyFile);
    throw error;
  }
  
  // Test invalid JSON validation
  const testInvalidJson = path.join(__dirname, "test-invalid.json");
  
  try {
    // Create temporary invalid JSON file
    fs.writeFileSync(testInvalidJson, '{"invalid": json}');
    
    let caught = false;
    try {
      requireValidJson(testInvalidJson, "invalid JSON test file");
    } catch (error) {
      caught = true;
      assert(error.message.includes("invalid JSON"), "Should detect invalid JSON");
    }
    assert(caught, "Should have caught invalid JSON error");
    
    // Clean up
    fs.unlinkSync(testInvalidJson);
    
  } catch (error) {
    // Clean up on error
    if (fs.existsSync(testInvalidJson)) fs.unlinkSync(testInvalidJson);
    throw error;
  }
  
  // Test invalid JavaScript validation
  const testInvalidJs = path.join(__dirname, "test-invalid.js");
  
  try {
    // Create temporary invalid JavaScript file
    fs.writeFileSync(testInvalidJs, 'function invalid() { return }}}');
    
    let caught = false;
    try {
      requireValidJavaScript(testInvalidJs, "invalid JavaScript test file");
    } catch (error) {
      caught = true;
      assert(error.message.includes("invalid JavaScript"), "Should detect invalid JavaScript");
    }
    assert(caught, "Should have caught invalid JavaScript error");
    
    // Clean up
    fs.unlinkSync(testInvalidJs);
    
  } catch (error) {
    // Clean up on error
    if (fs.existsSync(testInvalidJs)) fs.unlinkSync(testInvalidJs);
    throw error;
  }
  
  console.log("Error scenario tests passed.");
}

function runEnvironmentTests() {
  console.log("Running environment tests...");
  
  // Check Node.js version compatibility
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
  assert(majorVersion >= 18, `Node.js version should be >= 18, but got ${nodeVersion}`);
  
  // Check that required directories exist in project structure
  const projectRoot = path.join(__dirname, "..");
  const srcDir = path.join(projectRoot, "src");
  const packageJson = path.join(projectRoot, "package.json");
  const tsConfig = path.join(projectRoot, "tsconfig.json");
  
  requireFileExists(srcDir, "src directory");
  requireFileExists(packageJson, "package.json");
  requireFileExists(tsConfig, "tsconfig.json");
  
  // Validate package.json structure
  try {
    const packageContent = JSON.parse(fs.readFileSync(packageJson, "utf8"));
    assert(packageContent.name, "package.json should have name field");
    assert(packageContent.main, "package.json should have main field");
    assert(packageContent.scripts && packageContent.scripts.build, "package.json should have build script");
  } catch (error) {
    assert(false, `package.json validation failed: ${error.message}`);
  }
  
  console.log(`Environment tests passed (Node.js ${nodeVersion}).`);
}

// Main test execution
function runAllTests() {
  const startTime = Date.now();
  console.log("=".repeat(60));
  console.log("Starting comprehensive smoke tests...");
  console.log("=".repeat(60));
  
  try {
    // Environment and setup tests
    runEnvironmentTests();
    console.log();
    
    // Basic file and structure tests
    runPositiveScenario();
    console.log();
    
    // Content validation tests
    runContentValidationTests();
    console.log();
    
    // Bundle integrity tests
    runBundleIntegrityTests();
    console.log();
    
    // Source map validation tests
    runSourceMapValidationTests();
    console.log();
    
    // Performance tests
    runPerformanceTests();
    console.log();
    
    // Error scenario tests
    runErrorScenarioTests();
    console.log();
    
    // Original negative scenario test
    runNegativeScenario();
    
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    
    console.log("=".repeat(60));
    console.log(`✅ All smoke test scenarios passed! (${duration}s)`);
    console.log("=".repeat(60));
    
  } catch (error) {
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    
    console.log("=".repeat(60));
    console.error(`❌ Smoke test failed after ${duration}s:`);
    console.error(`   ${error.message}`);
    if (error.stack && process.env.DEBUG) {
      console.error("\nStack trace:");
      console.error(error.stack);
    }
    console.log("=".repeat(60));
    process.exit(1);
  }
}

// Run tests if this script is executed directly
if (require.main === module) {
  runAllTests();
}
