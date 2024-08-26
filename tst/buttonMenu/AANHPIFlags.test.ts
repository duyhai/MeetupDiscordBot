/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  ButtonComponent,
  ButtonInteraction,
  Collection,
  Guild,
  GuildMember,
  Message,
  User,
} from 'discord.js';
import { AANHPIFlagsCommands } from '../../src/buttonMenu/AANHPIFlags';

// Mock Logger class
jest.mock('tslog', () => ({
  Logger: jest.fn(() => ({
    info: jest.fn(),
  })),
}));

describe('AANHPIFlagsCommands', () => {
  let commandsInstance: AANHPIFlagsCommands;
  let mockInteraction: ButtonInteraction;

  beforeEach(() => {
    commandsInstance = new AANHPIFlagsCommands();

    mockInteraction = {
      user: {
        id: '123',
        username: 'testUser',
        toString: () => '<@testUser#123>',
      } as unknown as User,
      guild: { members: { fetch: jest.fn() } },
      component: { emoji: { name: '🏳️' } },
      message: { content: 'Page: 1/3' },
      update: jest.fn(),
    } as unknown as ButtonInteraction;
  });

  describe('handleChoice', () => {
    it('should clear all flags when clear button is pressed', async () => {
      mockInteraction.component.emoji.name = '🏳️'; // Simulate clear button press
      jest.spyOn(mockInteraction.guild.members, 'fetch').mockResolvedValueOnce({
        nickname: 'Test User | 🇨🇦',
      } as unknown as Collection<string, GuildMember>);
      await commandsInstance.handleChoice(mockInteraction);
      expect(mockInteraction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('Cleared all flags from your name!'),
        })
      );
    });

    it('should add flag to user nickname if not already present', async () => {
      mockInteraction.component.emoji.name = '🇨🇦'; // Simulate adding Canada flag
      mockInteraction.guild.members.fetch.mockResolvedValueOnce({
        nickname: 'Test User',
      });
      await commandsInstance.handleChoice(mockInteraction);
      expect(mockInteraction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining(
            'The flag 🇨🇦 has been added to your name!'
          ),
        })
      );
    });

    it('should remove flag from user nickname if already present', async () => {
      mockInteraction.component.emoji.name = '🇨🇦'; // Simulate removing Canada flag
      mockInteraction.guild.members.fetch.mockResolvedValueOnce({
        nickname: 'Test User | 🇨🇦',
      });
      await commandsInstance.handleChoice(mockInteraction);
      expect(mockInteraction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining(
            'The flag 🇨🇦 has been removed from your name!'
          ),
        })
      );
    });

    // Add more test cases as needed
  });

  // Add more test cases for other methods if needed
});
