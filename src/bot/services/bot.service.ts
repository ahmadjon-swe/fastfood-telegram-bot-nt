import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Context } from 'telegraf';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument, RegistrationStep } from '../schemas/user.schema';

@Injectable()
export class BotService implements OnModuleInit {
  private readonly logger = new Logger(BotService.name);

  constructor(
    @InjectBot() private readonly bot: Telegraf<Context>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  onModuleInit() {
    this.registerHandlers();
    this.logger.log('🤖 Bot handlers initialized');
  }

  private registerHandlers() {
    // /help command
    this.bot.command('help', async (ctx) => {
      try {
        await this.handleHelp(ctx);
      } catch (err) {
        this.logger.error('Error in /help', err);
      }
    });

    // /balance command
    this.bot.command('balance', async (ctx) => {
      try {
        await this.handleBalance(ctx);
      } catch (err) {
        this.logger.error('Error in /balance', err);
      }
    });

    // Guard: intercept all messages for users who haven't finished registration
    // NOTE: This runs AFTER more specific handlers due to Telegraf's middleware order.
    // User & Product services register text handlers early, so this acts as fallback.
    this.bot.on('message', async (ctx, next) => {
      const chatId = ctx.from?.id;
      if (!chatId) return next();

      const user = await this.userModel.findOne({ chatId });
      if (!user) {
        // Unregistered user — UserService's /start handler should have fired already
        await ctx.reply('Please send /start to begin.');
        return;
      }

      if (user.registrationStep !== RegistrationStep.COMPLETE) {
        // Registration not finished — prompt them again
        if (user.registrationStep === RegistrationStep.AWAITING_PHONE) {
          await ctx.reply(
            '⚠️ Please share your phone number to continue.',
            {
              reply_markup: {
                keyboard: [[{ text: '📱 Share Phone Number', request_contact: true }]],
                resize_keyboard: true,
                one_time_keyboard: true,
              },
            },
          );
        } else if (user.registrationStep === RegistrationStep.AWAITING_LOCATION) {
          await ctx.reply(
            '⚠️ Please share your location to continue.',
            {
              reply_markup: {
                keyboard: [[{ text: '📍 Share Location', request_location: true }]],
                resize_keyboard: true,
                one_time_keyboard: true,
              },
            },
          );
        }
        return;
      }

      return next();
    });

    // Global error handler
    this.bot.catch((err: any, ctx: Context) => {
      this.logger.error(`Unhandled bot error for update ${ctx.updateType}`, err);
    });
  }

  private async handleHelp(ctx: Context) {
    const helpText =
      `🤖 *Fastfood Delivery Bot Help*\n\n` +
      `*Commands:*\n` +
      `/start — Start the bot / Main menu\n` +
      `/help — Show this help message\n` +
      `/profile — View your profile\n` +
      `/balance — Check your balance\n\n` +
      `*Manager Commands:*\n` +
      `/promote <chatId> <seller|manager> — Promote a user\n` +
      `/topup <chatId> <amount> — Top up user balance\n\n` +
      `*How to Order:*\n` +
      `1. Browse categories (Food/Drinks/Desserts)\n` +
      `2. Add items to cart\n` +
      `3. View cart and confirm order\n` +
      `4. Pay with your balance\n` +
      `5. Track your order status`;

    await ctx.replyWithMarkdown(helpText);
  }

  private async handleBalance(ctx: Context) {
    const chatId = ctx.from?.id;
    if (!chatId) return;

    const user = await this.userModel.findOne({ chatId });
    if (!user) {
      await ctx.reply('Please send /start first.');
      return;
    }

    await ctx.replyWithMarkdown(
      `💳 *Your Balance*\n\n` +
        `Available: *$${user.balance.toFixed(2)}*\n\n` +
        `Contact a manager to top up your balance.`,
    );
  }
}
