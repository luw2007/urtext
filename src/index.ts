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
export {
  recordMapping,
  recordAck,
  detectUnmapped,
  blame,
  diffHunks,
  ensureCodeMap,
  CODE_MAP_SCHEMA,
  type MappingClaim,
  type MapOutcome,
  type DiffHunk,
  type UnmappedReport,
  type BlameEntry,
} from './dwarf.js'
export {
  exportRequest,
  importVerdicts,
  coverage,
  latestEvidence,
  ensureAuditLedger,
  AUDIT_SCHEMA,
  type AuditRequest,
  type AuditItem,
  type AuditVerdictInput,
  type ImportOutcome,
  type CoverageReport,
  type CoverageRow,
} from './audit.js'
export {
  adjudicate,
  type Decision,
  type ClauseDecision,
  type GateReport,
} from './gate.js'
