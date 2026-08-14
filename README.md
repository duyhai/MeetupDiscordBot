# MeetupDiscordBot

A Discord bot for managing the 1.5 Gen Asian Meetup group

# How to fork repo and contribute back into the main repo

https://www.dataschool.io/how-to-contribute-on-github/

# How to set original repository as upstream

https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/configuring-a-remote-for-a-fork

# Development

- We recommend using VSCode for coding
- Once you install VSCode, use the `code-workspace` file to open the project
- Install the recommended plugins
- Install node js: https://nodejs.org/en/
- Install yarn: `npm install --global yarn`
- Download dependencies: `yarn`
- Run the script with `yarn dev`
- Fill out the API keys in the `.env` file
- If you are on Windows, turn off auto CRLF with this command: `git config core.autocrlf false`

# Testing

We have two tiers of automated tests: fast unit tests and slower integration tests that hit real services.

- Unit tests: `yarn test` — no network or external services required. Runs on the pre-push hook and in CI.
- Integration tests: `yarn test:integration` — covers OAuth routes, the GraphQL client, and Redis caching.
- Run both: `yarn test:all`
- The Redis and Postgres integration suites are gated on the `REDISCLOUD_URL` / `DATABASE_URL` env vars: if unset, they skip with a warning. To run them locally, use the Docker stack below (`yarn test:integration:docker` is the one-shot version).
- The pre-push hook only runs unit tests (integration tests need Redis) — CI runs the integration tier separately, so don't expect `git push` locally to catch integration failures.

# Local testing with Docker
The integration suite needs a real Postgres (`DATABASE_URL`) and Redis (`REDISCLOUD_URL`). A `docker-compose.yml` at the repo root spins up both locally so you don't have to install them by hand.

## Install Docker (macOS, Apple Silicon)
We recommend [Colima](https://github.com/abiosoft/colima), a lightweight Docker runtime:
```
brew install colima docker docker-compose
colima start
```
As an alternative, Docker Desktop works too:
```
brew install --cask docker
```
(then launch Docker Desktop once so the daemon is running).

## Bring up the stack and run the integration tests
```
# Start Postgres + Redis and wait until both are healthy.
yarn docker:up

# Point the tests at the containers.
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/meetup_bot
export REDISCLOUD_URL=redis://localhost:6379

# Run the integration suite (Postgres + Redis suites now execute instead of skipping).
yarn test:integration

# Tear the stack down when you're done (the Postgres data volume is preserved).
yarn docker:down
```

`yarn docker:up` prints the exact `export` lines above after the services are healthy, so you can copy them straight from its output.

For a one-shot run that boots the stack, wires the env vars, and runs the integration tests in a single command:
```
yarn test:integration:docker
```
(This leaves the containers running; use `yarn docker:down` afterwards.)

The Postgres data volume survives `yarn docker:down`. If the schema ever changes shape or you want a clean slate, reset with `docker compose down -v`.
