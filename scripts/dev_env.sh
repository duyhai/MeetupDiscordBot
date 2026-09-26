envs=(
  DISCORD_API_KEY
  MEETUP_KEY
  MEETUP_SECRET
)

if [ ! -f .env ]; then
  for val in ${envs[@]}; do
    echo export $val= >> .env
  done

  echo "Please fill out your keys in .env!"
  exit 1
fi

source .env

# Local-dev switch: OAuth connect links point at localhost (through the prod
# /redirect trampoline) and REDISCLOUD_URL becomes optional. The name is a
# relic of the ts-node runner; constants.ts and configuration.ts key off it.
export TS_NODE_DEBUG=1

tsx src/index.ts