#!/usr/bin/env bash
# Boots the local Postgres + Redis stack (docker-compose.yml), waits until both
# services report healthy, then prints the env exports the integration suite
# reads (DATABASE_URL, REDISCLOUD_URL).
#
# Usage:
#   bash scripts/docker-setup.sh        # start the stack and wait for health
#   bash scripts/docker-setup.sh down   # stop the stack (keeps the data volume)

DATABASE_URL=postgres://postgres:postgres@localhost:5432/meetup_bot
REDISCLOUD_URL=redis://localhost:6379

# Support both the Compose v2 plugin ("docker compose") and the standalone
# binary ("docker-compose", what `brew install docker-compose` provides).
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "Neither 'docker compose' nor 'docker-compose' is installed. See the README."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not reachable. Start it first (e.g. 'colima start')."
  exit 1
fi

if [ "$1" = "down" ]; then
  $COMPOSE down
  exit $?
fi

$COMPOSE up -d

echo "Waiting for postgres and redis to become healthy..."
for service in postgres redis; do
  for _ in $(seq 1 30); do
    status=$($COMPOSE ps --format '{{.Health}}' "$service" 2>/dev/null)
    if [ "$status" = "healthy" ]; then
      break
    fi
    sleep 2
  done
  if [ "$status" != "healthy" ]; then
    echo "$service did not become healthy in time. Check 'docker compose ps'."
    exit 1
  fi
  echo "$service is healthy."
done

echo ""
echo "Stack is up. Export these to point the bot / integration tests at it:"
echo ""
echo "  export DATABASE_URL=$DATABASE_URL"
echo "  export REDISCLOUD_URL=$REDISCLOUD_URL"
echo ""
echo "Then run: yarn test:integration"
echo "Tear down with: bash scripts/docker-setup.sh down"
