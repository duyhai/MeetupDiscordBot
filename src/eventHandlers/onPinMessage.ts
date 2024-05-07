import { Discord, On, Client, ArgsOf } from 'discordx';

const PIN_EMOJIS = ['📌', '📍'];
const PIN_THRESHOLD = 5;

@Discord()
export class OnPinMessageEvents {
  @On({
    event: 'messageReactionAdd',
  })
  async onPinMessageAdd([
    messageReaction,
    _user,
  ]: ArgsOf<'messageReactionAdd'>) {
    if (
      PIN_EMOJIS.includes(messageReaction.emoji.name) &&
      messageReaction.count >= PIN_THRESHOLD &&
      !messageReaction.message.pinned &&
      !messageReaction.message.pinnable
    ) {
      messageReaction.message.channel.messages.fetchPinned();
      await messageReaction.message.pin();
    }
  }
}
