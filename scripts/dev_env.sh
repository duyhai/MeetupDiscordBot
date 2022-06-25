envs=(
  DISCORD_API_KEY
  DATABASE_URL
  MEETUP_KEY
  MEETUP_SECRET
)

if [ ! -f .env ]; then
  for val in ${envs[@]}; do
    echo $val= >> .env
  done

  echo "Please fill out your keys in .env!"
  exit 1
fi

source .env
