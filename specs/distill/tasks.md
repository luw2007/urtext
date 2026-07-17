- [x] T001 Define the facts manifest and deterministic workspace discovery <!-- role:coder clauses:C001,C002 -->
    Discover source, tests, entry points, and declared implementation evidence without writing canonical specs.
- [x] T002 Report declared-to-observed coverage gaps <!-- role:coder depends:T001 clauses:C003 -->
    Report missing declared evidence and unowned observed source/test facts without inventing a completeness score.
- [x] T003 Validate evidence paths and executable oracle targets <!-- role:coder depends:T001 clauses:C004 -->
    Fail only for declarations that the repository can deterministically prove invalid.
- [x] T004 Expose the distill command family in CLI help <!-- role:coder depends:T001 clauses:C005 -->
    Keep command documentation explicit about facts versus human-reviewed intent.
- [x] T005 Create codebase-to-spec Skill <!-- role:coder depends:T001 gate:true clauses:C006 -->
    Consume facts.json into staged Feature/FR/clause drafts with evidence, confidence, and explicit human decisions.
- [x] T006 Add fast distill promotion lane <!-- role:coder depends:T005 gate:true clauses:C007 -->
    Promote eligible observed low-risk runnable candidates after one feature-level confirmation; retain all other candidates in staging.
