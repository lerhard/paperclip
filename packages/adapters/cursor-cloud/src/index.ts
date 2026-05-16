export const type = "cursor_cloud";
export const label = "Cursor Cloud";

export const agentConfigurationDoc = `# cursor_cloud config

Core fields:
- repoUrl (string, required): Git repo URL
- repoStartingRef, repoPullRequestUrl (string, optional)
- runtimeEnvType (string, optional): cloud|pool|machine
- runtimeEnvName (string, optional)
- workOnCurrentBranch, autoCreatePR, skipReviewerRequest (boolean, optional)
- instructionsFilePath, promptTemplate, bootstrapPromptTemplate (string, optional)
- model (string, optional): omit for account default
- env.CURSOR_API_KEY (string, required)
- env.* (optional): additional env vars
`;
