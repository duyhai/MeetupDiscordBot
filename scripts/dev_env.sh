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

ts-node src/index.ts