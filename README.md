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
- The Redis integration suite is gated on the `REDISCLOUD_URL` env var: if unset, it skips with a warning. To run it locally, start a Redis (e.g. `docker run --rm -p 6379:6379 redis` or `brew install redis && redis-server`) and run `REDISCLOUD_URL=redis://localhost:6379 yarn test:integration`.
- The pre-push hook only runs unit tests (integration tests need Redis) — CI runs the integration tier separately, so don't expect `git push` locally to catch integration failures.
