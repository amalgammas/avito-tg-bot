# Repository Guidelines

## Project Structure & Module Organization
The NestJS app lives in `apps/bot-api/src`, split into feature-focused folders: `bot` for Telegram handlers, `config` for configuration providers, `health` for readiness endpoints, and `ozon` for marketplace integrations. Entrypoint code sits in `main.ts` and is wired by `app.module.ts`. Build artifacts land in `dist/`; do not edit anything there. Shared infrastructure such as the container recipe is under `infra/`. Use `@bot/*` path aliases (configured in `tsconfig.json`) when importing across modules.

## Build, Test, and Development Commands
Run `yarn inst-deps` once to install dependencies. Use `yarn start:dev` for a live TypeScript process with NestJS hot reload. Execute `yarn build` to emit production JavaScript into `dist/`, then start it with `yarn start`. These commands assume environment variables from `.env` are loaded (see below).

## Coding Style & Naming Conventions
Code is TypeScript with strict compiler settings. Follow the existing two-space indentation and keep lines concise. Name files and providers in kebab-case (`ozon-supply.service.ts`) and classes in PascalCase (`OzonSupplyService`). Group providers and modules by domain to mirror the folder layout. Maintain lightweight module-level comments only when context is non-obvious.

## Testing Guidelines
A Jest harness is not checked in yet; when adding tests, scaffold Nest’s default Jest setup and expose it as `yarn test`. Place `*.spec.ts` files alongside the code they cover and target isolated providers or services. Cover new logic and critical error paths before merging. Until automated tests exist, validate flows by running `yarn start:dev` against a staging bot token.

## Commit & Pull Request Guidelines
Commit history shows short imperative messages with optional issue tags (`create-project#3`). Continue that format: start with a verb, append an issue handle when applicable, and keep scope focused. For pull requests, describe the motivation, enumerate key changes, and link tracking tickets. Include configuration notes or screenshots if the change affects bot behavior or external integrations.

## Configuration & Secrets
Copy `.env.example` to `.env` and fill required keys (bot token, Ozon credentials, HTTP port). Never commit secrets. When adding new variables, update the example file and document defaults in the PR description. Prefer injecting configuration through Nest’s `ConfigService` rather than reading from `process.env` directly.
