/**
 * mcp-evolve — Public API.
 */

export { loadConfig, validateConfig } from './config.mjs';
export { run } from './run.mjs';
export { getPersona, getClusters, validateNewPersona, printPersonaMap } from './personas.mjs';
export {
  scoreQuestion, aggregateScores, loadGoldenSet, loadBaseline,
  checkStreak, buildActionPattern,
} from './eval.mjs';
export {
  loadMetrics, getFullSummary, getStalePersonas, getErrorProneTools,
  getSuccessRateTrend, detectPlateau,
} from './metrics.mjs';
export { runCompetition, selectCompetitionPersonas } from './compete.mjs';
export { loadKnowledge, writeFeatureKnowledge } from './knowledge.mjs';
