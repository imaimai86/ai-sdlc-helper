// ai-sdlc-helper as a library: project settings, detection, test framework setup and code search.
export { CONFIG_FILE } from './util.js';
export { RUNNERS, detect, detectPackage, literalList, packageGlobs, type Detection, type Runner } from './config/detect.js';
export { globToRegex, expandGlob } from './config/globs.js';
export { projectNode, satisfiesMajor, nodeRun, wrapCommand, type NodeRun, type ProjectNode } from './config/node.js';
export { CODE_INDEXERS, codeIndexers, codeSearchErrors, codeSearchFor, codeSearchGuide, type CodeIndexer } from './config/codeSearch.js';
export {
  resolve, validate, testDir, testSpec, testFiles, agentRules, allowedTools, testFramework, keyDir, layout, worktreeBase,
  type Config, type Suite, type Layout,
} from './config/settings.js';
export { suggest, setupPlan, provision, locateTestDir, packagesBelow, describeProject, rankRunners } from './config/suggest.js';
export { renderSkill, renderTemplate, skillNames } from './config/skills.js';
export { argsProblem } from './cli/args.js';
export { main, type Io } from './cli/main.js';
