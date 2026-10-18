import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Fixtures for the SDD tests: a Standard feature with spec, plan and tasks. */

export const SPEC = `# Spec: Demo

> Status: approved

## Requirements

- **R1** — La herramienta resuelve la tarea.
  - Given una tarea, when se delega, then se usa su bloque.
- **R2** — Segunda regla.

## Edge cases & error behavior

- **E1** — Slug inexistente.
- **E2** — Tarea inexistente.
`;

export const PLAN = `# Plan: Demo

> Status: approved

## Quality gates

| Gate | Command | Where | Baseline |
|---|---|---|---|
| Tests | \`node -e "process.exit(0)"\` | \`here\` | \`3 passed, 0 failed\` |
| Dist | \`git diff --exit-code\` | \`pipeline-only\` | \`—\` |
| Lint | — no tooling | — | — |

## Components

### C1 — Lector

- **Implements**: R1

### C2 — Brief

- **Implements**: R2, E2

## Build order
`;

export const TASKS = `# Tasks: Demo

> Status: approved

## T1 — Hecha

- [x] Done
- **Owner**: —
- **Component**: C1 · **Implements**: R1
- **Files**: \`index.ts\`
- **Do**: algo.
- **Acceptance**: algo.
- **Verify**: \`node -e "1"\`
- **Notes**: listo

## T2 — Bloqueada

- [!] Blocked — 2026-10-18, falta acceso
- **Owner**: —
- **Component**: C1 · **Implements**: R1
- **Files**: \`index.ts\`
- **Verify**: \`node -e "1"\`
- **Notes**: —

## T3 [P] — Construir el brief

- [ ] Done
- **Owner**: —
- **Component**: C2 · **Implements**: R1, E2
- **Files**: \`index.ts\`, \`src/nuevo.ts\`, \`.env\`
- **Do**: Escribir el brief con acentos: «añadir» y ñ.
- **Acceptance**: El brief contiene R1 y E2.
- **Verify**: \`node -e "process.exit(0)"\`
- **Notes**: —

## T4 [P] — Reclamada

- [ ] Done
- **Owner**: codex (multi-provider) since 2026-10-18
- **Component**: C2 · **Implements**: R2
- **Files**: \`index.ts\`
- **Verify**: revisión manual
- **Notes**: —

---

## Gaps found in verification

## G1 — Hueco

- [ ] Done
- **Owner**: —
- **Component**: C1 · **Implements**: R9
- **Files**: \`index.ts\`
- **Verify**: \`node -e "1"\`
- **Notes**: —

---

## Verification reports
`;

export function writeFeature(root: string, slug: string, files: Record<string, string>): void {
  const dir = path.join(root, "specs", slug);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
}
