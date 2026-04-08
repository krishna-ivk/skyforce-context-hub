# [ADJACENT] Skyforce Context Hub

`skyforce-context-hub` is an experimental context-service repo for workspace document retrieval.

## Current Role

This repo currently provides:

- an Express API for context search and lookup
- a bridge into repo-document retrieval from `skyforce-core`
- an experimental service layer for context search across selected repos

It should not be treated as:

- the primary product entrypoint
- the canonical contract authority
- a fully stabilized production dependency for the current v1 spine

## Current Boundaries

The current service is best understood as:

- an adjacent retrieval experiment
- a proving ground for context-service ideas
- a candidate future integration point if the product needs a dedicated retrieval service

## Primary Commands

```bash
cd /home/vashista/skyforce/skyforce-context-hub
npm install
npm test
npm start
```

Optional repo override:

```bash
cd /home/vashista/skyforce/skyforce-context-hub
SKYFORCE_CONTEXT_HUB_REPOS="morphOS,skyforce-core,skyforce-symphony,skyforce-harness,skyforce-api-gateway,skyforce-command-centre-live,skyforce-command-centre" npm start
```

Useful API:

```text
GET /api/context/repos
```

## Status

This repo is adjacent to the current product spine, not part of the canonical v1 factory path.
