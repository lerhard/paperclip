/**
 * Plugin loader entry point for Paperclip's external adapter system.
 * 
 * This file exports createServerAdapter() which is called by the plugin loader
 * to dynamically register this adapter at runtime.
 */

import {
  execute,
  testEnvironment,
  sessionCodec,
  detectModel,
  listSkills,
  syncSkills,
} from "./server/index.js";
import {
  type,
  models,
  agentConfigurationDoc,
} from "./index.js";

/**
 * Factory function required by Paperclip's external adapter plugin system.
 * Returns a ServerAdapterModule that can be registered dynamically.
 */
export function createServerAdapter() {
  return {
    type,
    execute,
    testEnvironment,
    sessionCodec,
    detectModel,
    listSkills,
    syncSkills,
    models,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: false,
    agentConfigurationDoc,
  };
}
