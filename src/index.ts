export {
  parseClauseFile,
  ORACLE_KINDS,
  type OracleKind,
  type ClauseOracle,
  type ClauseRef,
  type ParsedClause,
  type ClauseParseError,
  type ParsedClauseFile,
} from './clause-parser.js'
export {
  parseTaskFile,
  serializeTaskFile,
  type ParsedTask,
  type TaskParseError,
  type ParsedTaskFile,
} from './task-parser.js'
export { parseAnchorFields, type ParsedAnchor, type AnchorParseIssue } from './anchor.js'
export {
  openRegistry,
  indexClauseFile,
  indexTaskFile,
  tombstoneFile,
  REGISTRY_SCHEMA,
  type IndexOutcome,
  type FileKind,
  type CrossRefError,
} from './registry.js'
export { discoverUnits, scanWorkspace, type FeatureUnit, type ScanReport } from './scanner.js'
export {
  linkWorkspace,
  propagateStale,
  impact,
  type LinkError,
  type ClauseKey,
  type StaleReport,
  type ImpactReport,
} from './linker.js'
export { runOracle, type OracleResult, type Verdict } from './oracle-runner.js'
export {
  verifyWorkspace,
  ensureEvidenceLedger,
  EVIDENCE_SCHEMA,
  type VerifyReport,
  type ClauseVerdict,
} from './verifier.js'
