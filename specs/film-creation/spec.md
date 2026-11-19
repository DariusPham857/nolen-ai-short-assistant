# Film Creation

Status: DRAFT_BLOCKED
Source: [PRD FR-01, MVP-01](../../docs/PRD/PRD_AI_Short_Film_Assistant_v1.0.md)

## Goal
Producer enters a brief and constraints, persists a Film and reads it after reload.

## Scope
REQUIRED for the future slice: input validation, create/read persistence and UI.
This increment writes the specification only. Story generation, billing dispatch,
provider integration and export implementation are outside this change.

## Invariants
[DECIDED] USD integer micros, 30–60 second target and 9:16 MVP output per PRD.
[PROPOSED] Film creation alone has no generation, reservation or charge side effects;
FR-01 requires draft/budget persistence but does not explicitly settle that command boundary.
Do not encode a transport representation or deployment decision through examples.

## Acceptance criteria
- Valid brief and approved constraints persist and can be read after reload.
- Missing/invalid required input is rejected without a partial Film write.
- Duration outside 30–60 seconds and invalid budget input are rejected.
- Persistence failure is reported without claiming creation succeeded.
- Reading an unknown Film returns the agreed not-found contract.
- Money round-trips exactly under the contract selected before implementation.
- [PROPOSED] Creation does not enqueue generation or post financial events.

## Open Questions / Blocked Contracts
- Owner must freeze money range/storage/domain/JSON serialization before DB/API tasks.
  BIGINT, bigint and decimal-string JSON are proposals, not current decisions.
- Owner must freeze Hono deployment/ingress before API/UI wiring.
- Freeze required fields, error envelope/statuses and create command side effects
  against FR-01 before contract implementation. Existing schema is scaffold, not approval.
- Implementation blocked; draft completeness does not mean SPEC_READY for coding.
