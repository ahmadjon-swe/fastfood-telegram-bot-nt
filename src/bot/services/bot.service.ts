import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Context } from 'telegraf';

@Injectable()
export class BotService implements OnModuleInit {
  private readonly logger = new Logger(BotService.name);

  constructor(@InjectBot() private readonly bot: Telegraf<Context>) {}

  async onModuleInit() {
    await this.registerCommands();
  }
  
  private async registerCommands() {
    try {
      // Customer commands (default — everyone sees these)
      await this.bot.telegram.setMyCommands([
        { command: 'start', description: 'Start the bot / Main menu' },
        { command: 'profile', description: 'View your profile' },
        { command: 'topup', description: 'Top up balance via Payme' },
        { command: 'help', description: 'Show available commands' },
      ]);

      // Seller-specific commands
      await this.bot.telegram.setMyCommands(
        [
          { command: 'start', description: 'Start the bot / Main menu' },
          { command: 'profile', description: 'View your profile' },
          { command: 'help', description: 'Show available commands' },
          { command: 'topup', description: 'Toping up the balance' },
        ],
        { scope: { type: 'all_private_chats' } },
      );

      // Manager-specific commands — set per-user when promoting
      this.logger.log('Bot commands registered successfully');
    } catch (err) {
      this.logger.error('Failed to register bot commands', err);
    }
  }

  // Call this after promoting a user to manager
  async setManagerCommands(chatId: number) {
    try {
      await this.bot.telegram.setMyCommands(
        [
          { command: 'start', description: 'Start the bot / Main menu' },
          { command: 'profile', description: 'View your profile' },
          { command: 'help', description: 'Show available commands' },
          { command: 'promote', description: 'Promote user: /promote <chatId> <role>' },
          { command: 'topup', description: 'Top up user balance: /topup <chatId> <amount>' },
          { command: 'confirmtopup', description: 'Confirm topup: /confirmtopup <topupId>' },
        ],
        { scope: { type: 'chat', chat_id: chatId } },
      );
    } catch (err) {
      this.logger.warn(`Could not set manager commands for ${chatId}`, err);
    }
  }

  async setSellerCommands(chatId: number) {
    try {
      await this.bot.telegram.setMyCommands(
        [
          { command: 'start', description: 'Start the bot / Main menu' },
          { command: 'profile', description: 'View your profile' },
          { command: 'help', description: 'Show available commands' },
        ],
        { scope: { type: 'chat', chat_id: chatId } },
      );
    } catch (err) {
      this.logger.warn(`Could not set seller commands for ${chatId}`, err);
    }
  }
}