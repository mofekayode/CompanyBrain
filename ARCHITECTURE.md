# Company Brain, architecture

One repo (npm workspaces), three deployable services and one shared backend library.

```text
Browser
   │
   ▼
apps/web        Next.js portal: UI only                          → Vercel (or any Node host)
   │  HTTP (JSON, AI SDK chat stream)    NEXT_PUBLIC_API_URL
   ▼
apps/api        Node.js API (Hono): every backend endpoint       → AWS container
   │
   │            both import packages/core
   │
apps/worker     Node.js job worker: profiling, extraction        → AWS container (+ Docling sidecar)
   │  pulls jobs from Postgres
   ▼
Supabase Postgres (data, job queue, RLS) · S3 (files) · Docling (:5051)
Claude (agent, vision) · ElevenLabs (speech) · Twelve Labs (video embeddings)
```

## Where things live

| Part | Path | What it is |
|---|---|---|
| Portal | `apps/web/` | Pages and components. No database or AWS access. All data comes from the API. |
| API | `apps/api/src/` | `server.ts` (entry), `app.ts` (middleware, routing), `routes/*.ts` (thin handlers) |
| Worker | `apps/worker/src/worker.ts` | Claims jobs from `ingestion_jobs` and runs the handlers in core |
| Backend library | `packages/core/src/` | All business logic, shared by the API and the worker |
| ↳ storage | `packages/core/src/storage/` | S3 layout, write-once store, provenance |
| ↳ profiling | `packages/core/src/profiling/` | Format detection and per-format profilers |
| ↳ extraction | `packages/core/src/extraction/` | Docling, email, tables, text, audio, video, images, embeddings |
| ↳ jobs | `packages/core/src/jobs/` | Queue, handlers, extraction routing |
| ↳ workbench | `packages/core/src/workbench/` | Chat agent and tools, uploads, status, next steps, sessions, activity, evidence search |
| ↳ access | `packages/core/src/access/` | Company map, scopes and detectors, enforcement (RLS "view as"), FDE review reads |
| ↳ ontology | `packages/core/src/ontology/` | Company model: propose types/table roles, load entities + events, resolve duplicates, read prose (vocabulary, facts), graph read models |
| ↳ shared | `packages/core/src/{db,aws,env}.ts` | DB pool, AWS account guard, `.env` reader |
| Tests | `packages/core/tests/` | Unit tests, plus database tests that run the real migrations on in-memory Postgres |
| Ops scripts | `packages/core/scripts/` | Bulk land, profile, db check, extraction sample |
| Database schema | `supabase/migrations/` | Supabase migrations |
| Deploy | `infra/docker/node-service.Dockerfile`, `infra/s3/` | Container for API and worker; bucket policy and CORS |
| Docling service | `services/docling/` | Python venv for local runs; on AWS use the `docling-serve` image |
| Agent skills | `.claude/skills/` | Playbooks for FDEs using Claude Code |

## Rules the code follows

- **The portal is UI only.** It never imports runtime code from core; it imports only types.
- **Thin routes.** API handlers validate input, call `packages/core`, and return JSON. Logic lives in core so the API, the worker and scripts share it.
- **Slow work goes on the queue** (`ingestion_jobs`), never in a request. Jobs are idempotent, retried with backoff and recorded. The worker caps heavy job types (Docling, video, speech, vision).
- **One module per external service.** Swapping a vendor touches one file.
- **The database enforces safety.** RLS provides tenant isolation and ACLs, raw objects are write-once, and agent SQL runs under a sandbox role.
- **Access is scoped per file and enforced by Postgres.** Every file belongs to one scope. Held scopes are visible to admins only; released scopes are visible to their audience; hidden scopes aren't listed. Passages, documents and email threads inherit their file's ACL. The FDE workbench runs as the service role and sees everything; "view as" runs as a person under RLS.
- **Raw evidence is never changed.** `raw/` is write-once, enforced by both the bucket policy and the code.
- **Extract once per content.** Identical bytes are profiled and extracted once; copies point to the same result.

## Running locally

```bash
npm install
npm run docling          # document extraction service on :5051 (separate terminal)
npm run dev              # api :4318 + worker + portal :4317
npm test                 # core tests
npm run typecheck        # every workspace
```

Secrets are in the repo-root `.env`. Each service finds it by walking up from its folder, and reads only the keys it names (`packages/core/src/env.ts`).

## Deploying

| Service | How | Config |
|---|---|---|
| `apps/web` | Vercel (root directory `apps/web`) | `NEXT_PUBLIC_API_URL` = API URL |
| `apps/api` | `docker build -f infra/docker/node-service.Dockerfile --build-arg APP=api .` | `DATABASE_PASSWORD`, `ANTHROPIC_API_KEY`, `WEB_ORIGINS` (portal URL for CORS), port 4318 |
| `apps/worker` | same Dockerfile, `--build-arg APP=worker` | `DATABASE_PASSWORD`, `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `TWELVE_LABS_API_KEY`, `DOCLING_URL` |
| Docling | `quay.io/docling-project/docling-serve` next to the worker | none |

On AWS the containers use their task role (`COMPANY_BRAIN_AWS_PROFILE=""` is set in the image). The code still refuses any account other than 787137578043.
