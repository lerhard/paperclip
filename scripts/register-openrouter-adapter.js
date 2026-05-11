#!/usr/bin/env node

/**
 * Script to register the OpenRouter adapter as an external plugin.
 * 
 * This adds the adapter to ~/.paperclip/adapter-plugins.json with a localPath
 * pointing to packages/adapters/openrouter in the workspace.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve paths
const repoRoot = path.resolve(__dirname, "..");
const adapterPath = path.join(repoRoot, "packages", "adapters", "openrouter");
const homeDir = process.env.HOME || process.env.USERPROFILE;
const paperclipDir = path.join(homeDir, ".paperclip");
const pluginsFile = path.join(paperclipDir, "adapter-plugins.json");

// Ensure .paperclip directory exists
if (!fs.existsSync(paperclipDir)) {
  fs.mkdirSync(paperclipDir, { recursive: true });
  console.log(`Created directory: ${paperclipDir}`);
}

// Read or initialize plugins file
let plugins = [];
if (fs.existsSync(pluginsFile)) {
  try {
    const content = fs.readFileSync(pluginsFile, "utf-8");
    plugins = JSON.parse(content);
    if (!Array.isArray(plugins)) {
      plugins = [];
    }
  } catch (err) {
    console.warn(`Failed to parse ${pluginsFile}, starting fresh:`, err.message);
    plugins = [];
  }
}

// Check if OpenRouter adapter is already registered
const existingIndex = plugins.findIndex(p => p.type === "openrouter");

const adapterRecord = {
  packageName: "@paperclipai/adapter-openrouter",
  localPath: adapterPath,
  type: "openrouter",
  installedAt: new Date().toISOString(),
  disabled: false
};

if (existingIndex >= 0) {
  console.log("OpenRouter adapter already registered, updating...");
  plugins[existingIndex] = adapterRecord;
} else {
  console.log("Registering OpenRouter adapter...");
  plugins.push(adapterRecord);
}

// Write back to file
fs.writeFileSync(pluginsFile, JSON.stringify(plugins, null, 2) + "\n", "utf-8");

console.log("\n✅ OpenRouter adapter registered successfully!");
console.log(`   Type: openrouter`);
console.log(`   Path: ${adapterPath}`);
console.log(`   Config: ${pluginsFile}`);
console.log("\nNext steps:");
console.log("1. Run: pnpm install");
console.log("2. Restart the Paperclip server");
console.log("3. The OpenRouter adapter should appear in the adapter selection menu");
