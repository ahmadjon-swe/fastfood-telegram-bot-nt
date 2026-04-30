import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Markup, Context } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';
import { User, UserDocument, UserRole, RegistrationStep } from '../schemas/user.schema';
import { Topup, TopupDocument, TopupStatus } from '../schemas/topup.schema';
import { BotService } from './bot.service';

const PAYME_MERCHANT_ID = process.env.PAYME_MERCHANT_ID

@Injectable()
export class UserService implements OnModuleInit {
  private readonly logger = new Logger(UserService.name);
  private topupAwaitMap = new Map<number, boolean>();

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Topup.name) private readonly topupModel: Model<TopupDocument>,
    @InjectBot() private readonly bot: Telegraf<Context>,
    private readonly botService: BotService,
  ) {}

  onModuleInit() {
    this.registerHandlers();
  }

  private registerHandlers() {
    this.bot.start(async (ctx) => {
      try { await this.handleStart(ctx); } catch (err) { this.logger.error('Error in /start', err); }
    });

    this.bot.command('profile', async (ctx) => {
      try { await this.handleProfile(ctx); } catch (err) { this.logger.error('Error in /profile', err); }
    });

    this.bot.command('help', async (ctx) => {
      try { await this.handleHelp(ctx); } catch (err) { this.logger.error('Error in /help', err); }
    });

    this.bot.command('promote', async (ctx) => {
      try { await this.handlePromote(ctx); } catch (err) { this.logger.error('Error in /promote', err); }
    });

    this.bot.command('topup', async (ctx) => {
      try { await this.handleTopUp(ctx); } catch (err) { this.logger.error('Error in /topup', err); }
    });

    this.bot.command('confirmtopup', async (ctx) => {
      try { await this.handleConfirmTopup(ctx); } catch (err) { this.logger.error('Error in /confirmtopup', err); }
    });

    this.bot.on('contact', async (ctx) => {
      try { await this.handleContactMessage(ctx); } catch (err) { this.logger.error('Error handling contact', err); }
    });

    this.bot.on('location', async (ctx) => {
      try { await this.handleLocationMessage(ctx); } catch (err) { this.logger.error('Error handling location', err); }
    });

    this.bot.on('text', async (ctx, next) => {
      const chatId = ctx.from?.id;
      if (!chatId) return next();
      const state = this.topupAwaitMap.get(chatId);
      if (!state) return next();
      const text = (ctx.message as Message.TextMessage)?.text;
      if (text?.startsWith('/')) return next();
      await this.handleTopupAmountInput(ctx, text);
    });
  }

  // ─── Registration ─────────────────────────────────────────────────────────

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
        balance: 0,
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
        ]).resize().oneTime(),
      );
      return;
    }
    if (user.registrationStep === RegistrationStep.AWAITING_LOCATION) {
      await ctx.reply(
        '📍 Great! Now please share your delivery location.',
        Markup.keyboard([
          [Markup.button.locationRequest('📍 Share Location')],
        ]).resize().oneTime(),
      );
    }
  }

  private async handleContactMessage(ctx: Context) {
    const msg = ctx.message as Message.ContactMessage;
    if (!msg?.contact) return;
    const chatId = ctx.from.id;
    const user = await this.userModel.findOne({ chatId });
    if (!user) { await ctx.reply('Please send /start first.'); return; }
    if (user.registrationStep !== RegistrationStep.AWAITING_PHONE) return;
    if (msg.contact.user_id && msg.contact.user_id !== chatId) {
      await ctx.reply('⚠️ Please share your own phone number.');
      return;
    }
    await this.userModel.updateOne(
      { chatId },
      { phone: msg.contact.phone_number, registrationStep: RegistrationStep.AWAITING_LOCATION },
    );
    await ctx.reply(
      '✅ Phone number saved!\n\n📍 Now please share your delivery location.',
      Markup.keyboard([[Markup.button.locationRequest('📍 Share Location')]]).resize().oneTime(),
    );
  }

  private async handleLocationMessage(ctx: Context) {
    const msg = ctx.message as Message.LocationMessage;
    if (!msg?.location) return;
    const chatId = ctx.from.id;
    const user = await this.userModel.findOne({ chatId });
    if (!user) return;
    if (user.registrationStep !== RegistrationStep.AWAITING_LOCATION) return;
    await this.userModel.updateOne(
      { chatId },
      {
        location: { latitude: msg.location.latitude, longitude: msg.location.longitude },
        registrationStep: RegistrationStep.COMPLETE,
      },
    );
    const updatedUser = await this.userModel.findOne({ chatId });
    await ctx.reply('✅ Location saved! You are now fully registered.', Markup.removeKeyboard());
    await this.sendMainMenu(ctx, updatedUser);
  }

  // ─── Main Menu ────────────────────────────────────────────────────────────

  async sendMainMenu(ctx: Context, user?: UserDocument) {
    if (!user) user = await this.userModel.findOne({ chatId: ctx.from?.id });
    if (!user) return;

    const isPrivileged = user.role === UserRole.MANAGER || user.role === UserRole.SELLER;
    const menuText =
      `🏠 *Main Menu*\n\n` +
      `👤 ${user.firstName} | 💰 Balance: ${user.balance.toLocaleString()} UZS\n` +
      `🔖 Role: ${user.role.toUpperCase()}`;

    const buttons: any[][] = [
      [
        Markup.button.callback('🛒 Cart', 'view_cart'),
        Markup.button.callback('👤 Profile', 'view_profile'),
      ],
      [Markup.button.callback('📦 My Orders', 'my_orders')],
      [Markup.button.callback('🍽 Menu', 'show_categories')],
    ];

    if (isPrivileged) {
      buttons.push([
        Markup.button.callback('➕ Add Product', 'add_product'),
        Markup.button.callback('➕ Add Category', 'add_category'),
      ]);
    }

    if (user.role === UserRole.MANAGER) {
      buttons.push([Markup.button.callback('📊 All Orders', 'all_orders')]);
      buttons.push([Markup.button.callback('💰 Pending Top-ups', 'pending_topups')]);
    }

    await ctx.replyWithMarkdown(menuText, Markup.inlineKeyboard(buttons));
  }

  // ─── Help ─────────────────────────────────────────────────────────────────

  private async handleHelp(ctx: Context) {
    const user = await this.userModel.findOne({ chatId: ctx.from?.id });
    let helpText = '';

    if (!user || user.role === UserRole.CUSTOMER) {
      helpText =
        `📖 *Help — Customer*\n\n` +
        `*Commands:*\n` +
        `/start — Start bot / Main menu\n` +
        `/profile — View your profile\n` +
        `/topup — Top up balance via Payme\n` +
        `/help — Show this help message\n\n` +
        `*Menu buttons:*\n` +
        `🍽 Menu — Browse products by category\n` +
        `🛒 Cart — View your cart\n` +
        `📦 My Orders — Order history\n` +
        `👤 Profile — Personal info`;
    } else if (user.role === UserRole.SELLER) {
      helpText =
        `📖 *Help — Seller*\n\n` +
        `*Commands:*\n` +
        `/start — Main menu\n` +
        `/profile — Profile\n` +
        `/help — Help\n\n` +
        `*Menu buttons:*\n` +
        `➕ Add Product — Create new product\n` +
        `➕ Add Category — Create new category\n` +
        `🍽 Menu — View/manage products\n` +
        `📦 My Orders — Your orders`;
    } else if (user.role === UserRole.MANAGER) {
      helpText =
        `📖 *Help — Manager*\n\n` +
        `*Commands:*\n` +
        `/start — Main menu\n` +
        `/profile — Profile\n` +
        `/promote <chatId> <seller|manager> — Promote user\n` +
        `/topup <chatId> <amount> — Top up user balance\n` +
        `/confirmtopup <topupId> — Confirm a top-up request\n` +
        `/help — Help\n\n` +
        `*Menu buttons:*\n` +
        `📊 All Orders — View and update order statuses\n` +
        `💰 Pending Top-ups — View pending top-up requests\n` +
        `➕ Add Product / Category`;
    }

    await ctx.replyWithMarkdown(helpText);
  }

  // ─── Profile ──────────────────────────────────────────────────────────────

  private async handleProfile(ctx: Context) {
    const user = await this.userModel.findOne({ chatId: ctx.from?.id });
    if (!user) { await ctx.reply('Please send /start first.'); return; }
    if (user.registrationStep !== RegistrationStep.COMPLETE) {
      await this.continueRegistration(ctx, user); return;
    }
    const profileText =
      `👤 *Your Profile*\n\n` +
      `Name: ${user.firstName} ${user.lastName || ''}\n` +
      `Username: @${user.username || 'N/A'}\n` +
      `Phone: ${user.phone}\n` +
      `Role: ${user.role.toUpperCase()}\n` +
      `💰 Balance: ${user.balance.toLocaleString()} UZS`;
    await ctx.replyWithMarkdown(
      profileText,
      Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'main_menu')]]),
    );
  }

  // ─── Promote ──────────────────────────────────────────────────────────────

  private async handlePromote(ctx: Context) {
    const currentUser = await this.userModel.findOne({ chatId: ctx.from?.id });
    if (!currentUser || currentUser.role !== UserRole.MANAGER) {
      await ctx.reply('❌ Only managers can promote users.'); return;
    }
    const args = (ctx.message as Message.TextMessage).text.split(' ').slice(1);
    if (args.length < 2) { await ctx.reply('Usage: /promote <chatId> <seller|manager>'); return; }
    const targetChatId = parseInt(args[0]);
    const newRole = args[1] as UserRole;
    if (![UserRole.SELLER, UserRole.MANAGER].includes(newRole)) {
      await ctx.reply('❌ Invalid role. Use: seller or manager'); return;
    }
    const target = await this.userModel.findOneAndUpdate(
      { chatId: targetChatId }, { role: newRole }, { new: true },
    );
    if (!target) { await ctx.reply('❌ User not found.'); return; }
    await ctx.reply(`✅ ${target.firstName} promoted to ${newRole}.`);

    if (newRole === UserRole.MANAGER) {
      await this.botService.setManagerCommands(targetChatId);
    } else {
      await this.botService.setSellerCommands(targetChatId);
    }

    try {
      const blocked = await this.isUserBlockedBot(targetChatId);
      if (!blocked) {
        await this.bot.telegram.sendMessage(
          targetChatId,
          `🎉 Congratulations! You have been promoted to ${newRole.toUpperCase()}.`,
        );
      }
    } catch { /* skip */ }
  }

  // ─── Top-up ───────────────────────────────────────────────────────────────

  private async handleTopUp(ctx: Context) {
    const currentUser = await this.userModel.findOne({ chatId: ctx.from?.id });
    if (!currentUser) return;

    const args = (ctx.message as Message.TextMessage).text.split(' ').slice(1);

    // Manager: /topup <chatId> <amount>
    if (currentUser.role === UserRole.MANAGER && args.length >= 2) {
      const targetChatId = parseInt(args[0]);
      const amount = parseFloat(args[1]);
      if (isNaN(amount) || amount <= 0) { await ctx.reply('❌ Invalid amount.'); return; }

      const target = await this.userModel.findOneAndUpdate(
        { chatId: targetChatId }, { $inc: { balance: amount } }, { new: true },
      );
      if (!target) { await ctx.reply('❌ User not found.'); return; }

      await this.topupModel.create({
        chatId: targetChatId,
        amount,
        status: TopupStatus.CONFIRMED,
        confirmedBy: currentUser.chatId,
      });

      await ctx.reply(
        `✅ Added ${amount.toLocaleString()} UZS to ${target.firstName}'s balance.\nNew balance: ${target.balance.toLocaleString()} UZS`,
      );

      try {
        const blocked = await this.isUserBlockedBot(targetChatId);
        if (!blocked) {
          await this.bot.telegram.sendMessage(
            targetChatId,
            `💰 ${amount.toLocaleString()} UZS has been added to your balance!\nCurrent balance: ${target.balance.toLocaleString()} UZS`,
          );
        }
      } catch { this.logger.warn(`Could not notify user ${targetChatId}`); }
      return;
    }

    // Customer: /topup — ask for amount
    this.topupAwaitMap.set(Number(currentUser.chatId), true);
    await ctx.reply(
      `💰 *Top Up Balance*\n\n` +
      `Current balance: ${currentUser.balance.toLocaleString()} UZS\n\n` +
      `How much would you like to add? Enter the amount in UZS:`,
      { parse_mode: 'Markdown' },
    );
  }

  private async handleTopupAmountInput(ctx: Context, text: string) {
    const chatId = ctx.from?.id;
    if (!chatId) return;
    this.topupAwaitMap.delete(chatId);

    const amount = parseFloat(text.replace(/\s/g, ''));
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('❌ Invalid amount. Please enter a valid number.');
      return;
    }

    const topup = await this.topupModel.create({
      chatId,
      amount,
      status: TopupStatus.PENDING,
    });

    // Payme expects amount in tiyins (1 UZS = 100 tiyins)
    const amountTiyin = Math.round(amount * 100);
    const payload = `m=${PAYME_MERCHANT_ID};ac.order_id=${topup._id};a=${amountTiyin}`;
    const encoded = Buffer.from(payload).toString('base64');
    const paymeUrl = `https://checkout.paycom.uz/${encoded}`;

    await ctx.reply(
      `💳 *Pay via Payme*\n\n` +
      `Amount: ${amount.toLocaleString()} UZS\n` +
      `Request ID: \`${topup._id.toString().slice(-8).toUpperCase()}\`\n\n` +
      `Click the button below to complete the payment.\n` +
      `After payment, a manager will confirm your balance.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.url('💳 Pay via Payme', paymeUrl)],
          [Markup.button.callback('🏠 Main Menu', 'main_menu')],
        ]),
      },
    );

    // Notify managers
    const managers = await this.userModel.find({ role: UserRole.MANAGER });
    const user = await this.userModel.findOne({ chatId });
    for (const manager of managers) {
      try {
        const blocked = await this.isUserBlockedBot(Number(manager.chatId));
        if (!blocked) {
          await this.bot.telegram.sendMessage(
            manager.chatId,
            `💰 *New Top-up Request*\n\n` +
            `👤 User: ${user?.firstName}\n` +
            `📱 Chat ID: ${chatId}\n` +
            `💵 Amount: ${amount.toLocaleString()} UZS\n` +
            `🆔 Topup ID: ${topup._id}\n\n` +
            `To confirm: /confirmtopup ${topup._id}`,
            { parse_mode: 'Markdown' },
          );
        }
      } catch { /* skip */ }
    }
  }

  private async handleConfirmTopup(ctx: Context) {
    const manager = await this.userModel.findOne({ chatId: ctx.from?.id });
    if (!manager || manager.role !== UserRole.MANAGER) {
      await ctx.reply('❌ Only managers can confirm top-ups.'); return;
    }
    const args = (ctx.message as Message.TextMessage).text.split(' ').slice(1);
    if (!args[0]) { await ctx.reply('Usage: /confirmtopup <topupId>'); return; }

    const topup = await this.topupModel.findById(args[0]);
    if (!topup) { await ctx.reply('❌ Top-up request not found.'); return; }
    if (topup.status === TopupStatus.CONFIRMED) {
      await ctx.reply('⚠️ This request has already been confirmed.'); return;
    }

    await this.topupModel.findByIdAndUpdate(args[0], {
      status: TopupStatus.CONFIRMED,
      confirmedBy: manager.chatId,
    });

    const updated = await this.userModel.findOneAndUpdate(
      { chatId: topup.chatId },
      { $inc: { balance: topup.amount } },
      { new: true },
    );

    await ctx.reply(
      `✅ Confirmed! Added ${topup.amount.toLocaleString()} UZS to ${updated?.firstName}'s balance.\n` +
      `New balance: ${updated?.balance.toLocaleString()} UZS`,
    );

    try {
      const blocked = await this.isUserBlockedBot(topup.chatId);
      if (!blocked) {
        await this.bot.telegram.sendMessage(
          topup.chatId,
          `✅ Your balance has been confirmed!\n💰 +${topup.amount.toLocaleString()} UZS\nCurrent balance: ${updated?.balance.toLocaleString()} UZS`,
        );
      }
    } catch { /* skip */ }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async isUserBlockedBot(chatId: number): Promise<boolean> {
    try {
      await this.bot.telegram.sendChatAction(chatId, 'typing');
      return false;
    } catch (err: any) {
      if (err?.response?.error_code === 403) return true;
      return false;
    }
  }

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
    await this.userModel.updateOne({ chatId }, { $inc: { balance: -amount } });
    return true;
  }
}