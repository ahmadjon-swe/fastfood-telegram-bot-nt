import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Markup, Context } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';
import { Product, ProductDocument } from '../schemas/product.schema';
import { User, UserDocument, UserRole, RegistrationStep } from '../schemas/user.schema';

interface ProductWizardState {
  step: 'name' | 'price' | 'description' | 'image' | 'category';
  name?: string;
  price?: number;
  description?: string;
  image?: string;
}

interface CategoryWizardState {
  step: 'name' | 'emoji';
  name?: string;
}

@Injectable()
export class ProductService implements OnModuleInit {
  private readonly logger = new Logger(ProductService.name);
  private wizardStates = new Map<number, ProductWizardState>();
  private categoryWizardStates = new Map<number, CategoryWizardState>();

  private categories: { name: string; emoji: string }[] = [
    { name: 'food', emoji: '🍔' },
    { name: 'drinks', emoji: '🥤' },
    { name: 'desserts', emoji: '🍰' },
  ];

  constructor(
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectBot() private readonly bot: Telegraf<Context>,
  ) {}

  onModuleInit() {
    this.registerHandlers();
  }

  private registerHandlers() {
    this.bot.action('show_categories', async (ctx) => {
      try { await ctx.answerCbQuery(); await this.handleShowCategories(ctx); }
      catch (err) { this.logger.error('Error in show_categories', err); }
    });

    this.bot.action(/^category:(.+)$/, async (ctx) => {
      try { await ctx.answerCbQuery(); await this.handleCategoryView(ctx, ctx.match[1]); }
      catch (err) { this.logger.error('Error in category action', err); }
    });

    this.bot.action(/^product_detail:(.+)$/, async (ctx) => {
      try { await ctx.answerCbQuery(); await this.handleProductDetail(ctx, ctx.match[1]); }
      catch (err) { this.logger.error('Error in product_detail', err); }
    });

    this.bot.action('add_product', async (ctx) => {
      try { await ctx.answerCbQuery(); await this.startAddProductWizard(ctx); }
      catch (err) { this.logger.error('Error starting product wizard', err); }
    });

    this.bot.action('add_category', async (ctx) => {
      try { await ctx.answerCbQuery(); await this.startAddCategoryWizard(ctx); }
      catch (err) { this.logger.error('Error starting category wizard', err); }
    });

    this.bot.action(/^set_category:(.+)$/, async (ctx) => {
      try { await ctx.answerCbQuery(); await this.handleWizardCategorySelect(ctx, ctx.match[1]); }
      catch (err) { this.logger.error('Error in set_category action', err); }
    });

    this.bot.action(/^toggle_product:(.+)$/, async (ctx) => {
      try { await ctx.answerCbQuery(); await this.handleToggleProduct(ctx, ctx.match[1]); }
      catch (err) { this.logger.error('Error toggling product', err); }
    });

    this.bot.action('main_menu', async (ctx) => {
      try { await ctx.answerCbQuery(); await this.sendMainMenuEdit(ctx); }
      catch (err) { this.logger.error('Error in main_menu action', err); }
    });

    this.bot.action('pending_topups', async (ctx) => {
      try { await ctx.answerCbQuery(); await this.handlePendingTopups(ctx); }
      catch (err) { this.logger.error('Error in pending_topups', err); }
    });

    this.bot.action('view_profile', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const user = await this.userModel.findOne({ chatId: ctx.from?.id });
        if (!user) return;
        const profileText =
          `👤 *Your Profile*\n\n` +
          `Name: ${user.firstName} ${user.lastName || ''}\n` +
          `Phone: ${user.phone}\n` +
          `Role: ${user.role.toUpperCase()}\n` +
          `💰 Balance: ${user.balance.toLocaleString()} UZS`;
        await ctx.editMessageText(profileText, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'main_menu')]]),
        });
      } catch (err) { this.logger.error('Error in view_profile action', err); }
    });

    this.bot.on('text', async (ctx, next) => {
      const chatId = ctx.from?.id;
      if (!chatId) return next();
      const text = (ctx.message as Message.TextMessage)?.text;
      if (text?.startsWith('/')) return next();

      const catState = this.categoryWizardStates.get(chatId);
      if (catState) {
        try { await this.handleCategoryWizardText(ctx, catState); } catch (err) { this.logger.error('Category wizard error', err); }
        return;
      }

      const prodState = this.wizardStates.get(chatId);
      if (prodState) {
        try { await this.handleWizardText(ctx, prodState); } catch (err) { this.logger.error('Product wizard error', err); return next(); }
        return;
      }

      return next();
    });
  }

  // ─── Main Menu Edit ───────────────────────────────────────────────────────

  private async sendMainMenuEdit(ctx: Context) {
    const user = await this.userModel.findOne({ chatId: ctx.from?.id });
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
    try {
      await ctx.editMessageText(menuText, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    } catch {
      await ctx.replyWithMarkdown(menuText, Markup.inlineKeyboard(buttons));
    }
  }

  // ─── Categories ───────────────────────────────────────────────────────────

  private async handleShowCategories(ctx: Context) {
    const buttons = this.categories.map((cat) => [
      Markup.button.callback(`${cat.emoji} ${cat.name}`, `category:${cat.name}`),
    ]);
    buttons.push([Markup.button.callback('🏠 Main Menu', 'main_menu')]);

    const text = `🍽 *Menu*\n\nSelect a category:`;
    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    } catch {
      await ctx.replyWithMarkdown(text, Markup.inlineKeyboard(buttons));
    }
  }

  async handleCategoryView(ctx: Context, category: string) {
    const chatId = ctx.from?.id;
    if (!chatId) return;
    const user = await this.userModel.findOne({ chatId });
    if (!user || user.registrationStep !== RegistrationStep.COMPLETE) {
      await ctx.reply('⚠️ Please complete registration first. Send /start');
      return;
    }

    const catInfo = this.categories.find((c) => c.name === category);
    const emoji = catInfo?.emoji || '📦';
    const products = await this.productModel.find({ category, isActive: true });

    if (products.length === 0) {
      const text = `${emoji} *${category}*\n\nNo products available in this category.`;
      try {
        await ctx.editMessageText(text, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('◀️ Back to Menu', 'show_categories')],
            [Markup.button.callback('🏠 Main Menu', 'main_menu')],
          ]),
        });
      } catch {
        await ctx.replyWithMarkdown(text, Markup.inlineKeyboard([
          [Markup.button.callback('◀️ Back to Menu', 'show_categories')],
          [Markup.button.callback('🏠 Main Menu', 'main_menu')],
        ]));
      }
      return;
    }

    const productButtons = products.map((p) => [
      Markup.button.callback(
        `${emoji} ${p.name} — ${p.price.toLocaleString()} UZS`,
        `product_detail:${p._id}`,
      ),
    ]);
    productButtons.push([Markup.button.callback('◀️ Back to Menu', 'show_categories')]);
    productButtons.push([Markup.button.callback('🏠 Main Menu', 'main_menu')]);

    const text = `${emoji} *${category}* — ${products.length} item(s)`;
    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(productButtons) });
    } catch {
      await ctx.replyWithMarkdown(text, Markup.inlineKeyboard(productButtons));
    }
  }

  // ─── Product Detail ───────────────────────────────────────────────────────

  private async handleProductDetail(ctx: Context, productId: string) {
    const chatId = ctx.from?.id;
    if (!chatId) return;

    const user = await this.userModel.findOne({ chatId });
    const product = await this.productModel.findById(productId);
    if (!product) { await ctx.reply('❌ Product not found.'); return; }

    const catInfo = this.categories.find((c) => c.name === product.category);
    const emoji = catInfo?.emoji || '📦';

    const text =
      `${emoji} *${product.name}*\n` +
      `💰 Price: ${product.price.toLocaleString()} UZS\n` +
      (product.description ? `📝 ${product.description}\n` : '');

    const buttons: any[][] = [
      [Markup.button.callback('🛒 Add to Cart', `add_to_cart:${product._id}`)],
    ];

    if (user?.role === UserRole.MANAGER || user?.role === UserRole.SELLER) {
      buttons.push([
        Markup.button.callback(
          product.isActive ? '🔴 Deactivate' : '🟢 Activate',
          `toggle_product:${product._id}`,
        ),
      ]);
    }

    buttons.push([Markup.button.callback(`◀️ Back to ${product.category}`, `category:${product.category}`)]);
    buttons.push([Markup.button.callback('🏠 Main Menu', 'main_menu')]);

    if (product.image) {
      try {
        await ctx.replyWithPhoto(product.image, { caption: text, parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
        return;
      } catch { /* fallthrough */ }
    }

    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    } catch {
      await ctx.replyWithMarkdown(text, Markup.inlineKeyboard(buttons));
    }
  }

  // ─── Add Product Wizard ───────────────────────────────────────────────────

  private async startAddProductWizard(ctx: Context) {
    const chatId = ctx.from?.id;
    if (!chatId) return;
    const user = await this.userModel.findOne({ chatId });
    if (!user || (user.role !== UserRole.MANAGER && user.role !== UserRole.SELLER)) {
      await ctx.reply('❌ Only managers and sellers can add products.'); return;
    }
    this.wizardStates.set(chatId, { step: 'name' });
    await ctx.reply('➕ *Add New Product*\n\nStep 1/5: Enter the product name:', { parse_mode: 'Markdown' });
  }

  private async handleWizardText(ctx: Context, state: ProductWizardState) {
    const chatId = ctx.from?.id;
    const text = (ctx.message as Message.TextMessage)?.text;
    if (!chatId || !text) return;
    switch (state.step) {
      case 'name':
        state.name = text; state.step = 'price';
        this.wizardStates.set(chatId, state);
        await ctx.reply('Step 2/5: Enter the price in UZS (e.g. 25000):');
        break;
      case 'price': {
        const price = parseFloat(text.replace(/\s/g, ''));
        if (isNaN(price) || price <= 0) { await ctx.reply('❌ Invalid price. Please enter a valid number:'); return; }
        state.price = price; state.step = 'description';
        this.wizardStates.set(chatId, state);
        await ctx.reply('Step 3/5: Enter a description (or "skip"):');
        break;
      }
      case 'description':
        state.description = text.toLowerCase() === 'skip' ? undefined : text;
        state.step = 'image';
        this.wizardStates.set(chatId, state);
        await ctx.reply('Step 4/5: Send a photo URL (or "skip"):');
        break;
      case 'image':
        state.image = text.toLowerCase() === 'skip' ? undefined : text;
        state.step = 'category';
        this.wizardStates.set(chatId, state);
        const catButtons = this.categories.map((c) => [
          Markup.button.callback(`${c.emoji} ${c.name}`, `set_category:${c.name}`),
        ]);
        await ctx.reply('Step 5/5: Select a category:', Markup.inlineKeyboard(catButtons));
        break;
      default:
        break;
    }
  }

  private async handleWizardCategorySelect(ctx: Context, category: string) {
    const chatId = ctx.from?.id;
    if (!chatId) return;
    const state = this.wizardStates.get(chatId);
    if (!state || state.step !== 'category') {
      await ctx.reply('No active product creation. Use ➕ Add Product from the menu.'); return;
    }
    this.wizardStates.delete(chatId);
    const product = await this.productModel.create({
      name: state.name,
      price: state.price,
      description: state.description,
      image: state.image,
      category,
      isActive: true,
      createdBy: chatId,
    });
    const catInfo = this.categories.find((c) => c.name === category);
    const emoji = catInfo?.emoji || '📦';
    try {
      await ctx.editMessageText(
        `✅ *Product Created!*\n\n${emoji} *${product.name}*\n💰 ${product.price.toLocaleString()} UZS\n🏷️ ${product.category}` +
        (product.description ? `\n📝 ${product.description}` : ''),
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🏠 Main Menu', 'main_menu')],
            [Markup.button.callback('➕ Add Another', 'add_product')],
          ]),
        },
      );
    } catch {
      await ctx.replyWithMarkdown(
        `✅ Product created: ${emoji} *${product.name}* — ${product.price.toLocaleString()} UZS`,
        Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'main_menu')]]),
      );
    }
  }

  // ─── Add Category Wizard ──────────────────────────────────────────────────

  private async startAddCategoryWizard(ctx: Context) {
    const chatId = ctx.from?.id;
    if (!chatId) return;
    const user = await this.userModel.findOne({ chatId });
    if (!user || (user.role !== UserRole.MANAGER && user.role !== UserRole.SELLER)) {
      await ctx.reply('❌ Unauthorized.'); return;
    }
    this.categoryWizardStates.set(chatId, { step: 'name' });
    await ctx.reply('➕ *Add New Category*\n\nStep 1/2: Enter the category name (e.g. pizza):',
      { parse_mode: 'Markdown' });
  }

  private async handleCategoryWizardText(ctx: Context, state: CategoryWizardState) {
    const chatId = ctx.from?.id;
    const text = (ctx.message as Message.TextMessage)?.text;
    if (!chatId || !text) return;
    if (state.step === 'name') {
      const nameLower = text.toLowerCase().trim();
      if (this.categories.find((c) => c.name === nameLower)) {
        await ctx.reply('⚠️ This category already exists. Enter a different name:'); return;
      }
      state.name = nameLower;
      state.step = 'emoji';
      this.categoryWizardStates.set(chatId, state);
      await ctx.reply('Step 2/2: Enter an emoji for this category (e.g. 🍕):');
    } else if (state.step === 'emoji') {
      this.categoryWizardStates.delete(chatId);
      this.categories.push({ name: state.name!, emoji: text.trim() });
      await ctx.reply(
        `✅ Category *"${text.trim()} ${state.name}"* has been added!`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🍽 View Menu', 'show_categories')],
            [Markup.button.callback('🏠 Main Menu', 'main_menu')],
          ]),
        },
      );
    }
  }

  // ─── Toggle Product ───────────────────────────────────────────────────────

  private async handleToggleProduct(ctx: Context, productId: string) {
    const chatId = ctx.from?.id;
    if (!chatId) return;
    const user = await this.userModel.findOne({ chatId });
    if (!user || (user.role !== UserRole.MANAGER && user.role !== UserRole.SELLER)) {
      await ctx.reply('❌ Unauthorized.'); return;
    }
    const product = await this.productModel.findById(productId);
    if (!product) { await ctx.reply('❌ Product not found.'); return; }
    product.isActive = !product.isActive;
    await product.save();
    await ctx.reply(`✅ "${product.name}" is now ${product.isActive ? 'ACTIVE 🟢' : 'INACTIVE 🔴'}.`);
  }

  // ─── Pending Top-ups ──────────────────────────────────────────────────────

  private async handlePendingTopups(ctx: Context) {
    const text =
      `💰 *Pending Top-up Requests*\n\n` +
      `To confirm a top-up request:\n` +
      `/confirmtopup <topupId>\n\n` +
      `You will be notified when new requests arrive.`;
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'main_menu')]]),
      });
    } catch {
      await ctx.replyWithMarkdown(text, Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'main_menu')]]));
    }
  }

  async findById(productId: string): Promise<ProductDocument | null> {
    return this.productModel.findById(productId);
  }
}