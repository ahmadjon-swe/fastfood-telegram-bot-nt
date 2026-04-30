import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Markup, Context } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';
import { User, UserDocument, UserRole, RegistrationStep } from '../schemas/user.schema';

@Injectable()
export class UserService implements OnModuleInit {
  private readonly logger = new Logger(UserService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectBot() private readonly bot: Telegraf<Context>,
  ) {}

  onModuleInit() {
    this.registerHandlers();
  }

  private registerHandlers() {
    // /start command
    this.bot.start(async (ctx) => {
      try {
        await this.handleStart(ctx);
      } catch (err) {
        this.logger.error('Error in /start handler', err);
      }
    });

    // /profile command
    this.bot.command('profile', async (ctx) => {
      try {
        await this.handleProfile(ctx);
      } catch (err) {
        this.logger.error('Error in /profile handler', err);
      }
    });

    // /promote command: /promote <chatId> seller|manager
    this.bot.command('promote', async (ctx) => {
      try {
        await this.handlePromote(ctx);
      } catch (err) {
        this.logger.error('Error in /promote handler', err);
      }
    });

    // /topup command (manager only): /topup <chatId> <amount>
    this.bot.command('topup', async (ctx) => {
      try {
        await this.handleTopUp(ctx);
      } catch (err) {
        this.logger.error('Error in /topup handler', err);
      }
    });

    // Handle contact (phone) sharing
    this.bot.on('contact', async (ctx) => {
      try {
        await this.handleContactMessage(ctx);
      } catch (err) {
        this.logger.error('Error handling contact', err);
      }
    });

    // Handle location sharing
    this.bot.on('location', async (ctx) => {
      try {
        await this.handleLocationMessage(ctx);
      } catch (err) {
        this.logger.error('Error handling location', err);
      }
    });
  }

  // ─── Core Registration Flow ───────────────────────────────────────────────

  async handleStart(ctx: Context) {
    const from = ctx.from;
    if (!from) return;

    let user = await this.userModel.findOne({ chatId: from.id });

    if (!user) {
      user = await this.userModel.create({
        chatId: from.id,
        firstName: from.first_name,
        lastName: from.last_name,
        username: from.username,
        registrationStep: RegistrationStep.AWAITING_PHONE,
        balance: 100, // Welcome bonus
      });
      this.logger.log(`New user registered: ${from.id}`);
    }

    if (user.registrationStep !== RegistrationStep.COMPLETE) {
      await this.continueRegistration(ctx, user);
      return;
    }

    await this.sendMainMenu(ctx, user);
  }

  private async continueRegistration(ctx: Context, user: UserDocument) {
    if (user.registrationStep === RegistrationStep.AWAITING_PHONE) {
      await ctx.reply(
        `👋 Welcome, ${user.firstName}!\n\nTo use our food delivery service, please share your phone number.`,
        Markup.keyboard([
          [Markup.button.contactRequest('📱 Share Phone Number')],
        ])
          .resize()
          .oneTime(),
      );
      return;
    }

    if (user.registrationStep === RegistrationStep.AWAITING_LOCATION) {
      await ctx.reply(
        '📍 Great! Now please share your delivery location.',
        Markup.keyboard([
          [Markup.button.locationRequest('📍 Share Location')],
        ])
          .resize()
          .oneTime(),
      );
    }
  }

  private async handleContactMessage(ctx: Context) {
    const msg = ctx.message as Message.ContactMessage;
    if (!msg?.contact) return;

    const chatId = ctx.from.id;
    const user = await this.userModel.findOne({ chatId });
    if (!user) {
      await ctx.reply('Please send /start first.');
      return;
    }

    if (user.registrationStep !== RegistrationStep.AWAITING_PHONE) {
      return;
    }

    // Ensure user shares their own contact
    if (msg.contact.user_id && msg.contact.user_id !== chatId) {
      await ctx.reply('⚠️ Please share your own phone number.');
      return;
    }

    await this.userModel.updateOne(
      { chatId },
      {
        phone: msg.contact.phone_number,
        registrationStep: RegistrationStep.AWAITING_LOCATION,
      },
    );

    await ctx.reply(
      '✅ Phone number saved!\n\n📍 Now please share your delivery location.',
      Markup.keyboard([
        [Markup.button.locationRequest('📍 Share Location')],
      ])
        .resize()
        .oneTime(),
    );
  }

  private async handleLocationMessage(ctx: Context) {
    const msg = ctx.message as Message.LocationMessage;
    if (!msg?.location) return;

    const chatId = ctx.from.id;
    const user = await this.userModel.findOne({ chatId });
    if (!user) return;

    if (user.registrationStep !== RegistrationStep.AWAITING_LOCATION) {
      // Could be a live location update; ignore
      return;
    }

    await this.userModel.updateOne(
      { chatId },
      {
        location: {
          latitude: msg.location.latitude,
          longitude: msg.location.longitude,
        },
        registrationStep: RegistrationStep.COMPLETE,
      },
    );

    const updatedUser = await this.userModel.findOne({ chatId });

    await ctx.reply(
      '✅ Location saved! You are now fully registered.',
      Markup.removeKeyboard(),
    );

    await this.sendMainMenu(ctx, updatedUser);
  }

  // ─── Main Menu ────────────────────────────────────────────────────────────

  async sendMainMenu(ctx: Context, user?: UserDocument) {
    if (!user) {
      user = await this.userModel.findOne({ chatId: ctx.from?.id });
    }
    if (!user) return;

    const isPrivileged =
      user.role === UserRole.MANAGER || user.role === UserRole.SELLER;

    const menuText =
      `🏠 *Main Menu*\n\n` +
      `👤 ${user.firstName} | 💰 Balance: $${user.balance.toFixed(2)}\n` +
      `🔖 Role: ${user.role.toUpperCase()}`;

    const buttons = [
      [
        Markup.button.callback('🍔 Food', 'category:food'),
        Markup.button.callback('🥤 Drinks', 'category:drinks'),
        Markup.button.callback('🍰 Desserts', 'category:desserts'),
      ],
      [
        Markup.button.callback('🛒 Cart', 'view_cart'),
        Markup.button.callback('👤 Profile', 'view_profile'),
      ],
      [Markup.button.callback('📦 My Orders', 'my_orders')],
    ];

    if (isPrivileged) {
      buttons.push([Markup.button.callback('➕ Add Product', 'add_product')]);
    }

    if (user.role === UserRole.MANAGER) {
      buttons.push([Markup.button.callback('📊 All Orders', 'all_orders')]);
    }

    await ctx.replyWithMarkdown(menuText, Markup.inlineKeyboard(buttons));
  }

  // ─── Profile ──────────────────────────────────────────────────────────────

  private async handleProfile(ctx: Context) {
    const user = await this.userModel.findOne({ chatId: ctx.from?.id });
    if (!user) {
      await ctx.reply('Please send /start first.');
      return;
    }

    if (user.registrationStep !== RegistrationStep.COMPLETE) {
      await this.continueRegistration(ctx, user);
      return;
    }

    const profileText =
      `👤 *Your Profile*\n\n` +
      `Name: ${user.firstName} ${user.lastName || ''}\n` +
      `Username: @${user.username || 'N/A'}\n` +
      `Phone: ${user.phone}\n` +
      `Role: ${user.role.toUpperCase()}\n` +
      `💰 Balance: $${user.balance.toFixed(2)}`;

    await ctx.replyWithMarkdown(
      profileText,
      Markup.inlineKeyboard([
        [Markup.button.callback('🏠 Main Menu', 'main_menu')],
      ]),
    );
  }

  // ─── Role Management ──────────────────────────────────────────────────────

  private async handlePromote(ctx: Context) {
    const currentUser = await this.userModel.findOne({ chatId: ctx.from?.id });
    if (!currentUser || currentUser.role !== UserRole.MANAGER) {
      await ctx.reply('❌ Only managers can promote users.');
      return;
    }

    const args = (ctx.message as Message.TextMessage).text.split(' ').slice(1);
    if (args.length < 2) {
      await ctx.reply('Usage: /promote <chatId> <seller|manager>');
      return;
    }

    const targetChatId = parseInt(args[0]);
    const newRole = args[1] as UserRole;

    if (![UserRole.SELLER, UserRole.MANAGER].includes(newRole)) {
      await ctx.reply('❌ Invalid role. Use: seller or manager');
      return;
    }

    const target = await this.userModel.findOneAndUpdate(
      { chatId: targetChatId },
      { role: newRole },
      { new: true },
    );

    if (!target) {
      await ctx.reply('❌ User not found.');
      return;
    }

    await ctx.reply(`✅ User ${target.firstName} promoted to ${newRole}.`);

    // Notify the promoted user
    try {
      await this.bot.telegram.sendMessage(
        targetChatId,
        `🎉 Congratulations! You have been promoted to ${newRole.toUpperCase()}.`,
      );
    } catch {
      // User may have blocked the bot
    }
  }

  private async handleTopUp(ctx: Context) {
    const currentUser = await this.userModel.findOne({ chatId: ctx.from?.id });
    if (!currentUser || currentUser.role !== UserRole.MANAGER) {
      await ctx.reply('❌ Only managers can top up balances.');
      return;
    }

    const args = (ctx.message as Message.TextMessage).text.split(' ').slice(1);
    if (args.length < 2) {
      await ctx.reply('Usage: /topup <chatId> <amount>');
      return;
    }

    const targetChatId = parseInt(args[0]);
    const amount = parseFloat(args[1]);

    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('❌ Invalid amount.');
      return;
    }

    const target = await this.userModel.findOneAndUpdate(
      { chatId: targetChatId },
      { $inc: { balance: amount } },
      { new: true },
    );

    if (!target) {
      await ctx.reply('❌ User not found.');
      return;
    }

    await ctx.reply(
      `✅ Added $${amount.toFixed(2)} to ${target.firstName}'s balance.\nNew balance: $${target.balance.toFixed(2)}`,
    );
  }

  // ─── Public Helpers ───────────────────────────────────────────────────────

  async findByChatId(chatId: number): Promise<UserDocument | null> {
    return this.userModel.findOne({ chatId });
  }

  async isRegistrationComplete(chatId: number): Promise<boolean> {
    const user = await this.userModel.findOne({ chatId });
    return user?.registrationStep === RegistrationStep.COMPLETE;
  }

  async deductBalance(chatId: number, amount: number): Promise<boolean> {
    const user = await this.userModel.findOne({ chatId });
    if (!user || user.balance < amount) return false;

    await this.userModel.updateOne(
      { chatId },
      { $inc: { balance: -amount } },
    );
    return true;
  }
}
